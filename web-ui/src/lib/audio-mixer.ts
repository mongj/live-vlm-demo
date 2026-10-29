import {
  BARGE_IN_RMS_THRESHOLD,
  BYTES_PER_SAMPLE,
  CAPTURE_CHUNK_SECONDS,
  floatToS16le,
  INBOUND_SAMPLE_RATE_HZ,
  resampleLinear,
} from "@/lib/pcm";

export type MixerSourceKind = "microphone" | "media";

export type MixerSource = {
  stream: MediaStream;
  kind: MixerSourceKind;
  /** Linear gain applied before mixing; 1 is unity. */
  gain: number;
};

type ConnectedSource = MixerSource & {
  input: MediaStreamAudioSourceNode;
  level: GainNode;
};

type MixerGraph = {
  context: AudioContext;
  mixBus: GainNode;
  speechBus: GainNode;
  limiter: DynamicsCompressorNode;
  merger: ChannelMergerNode;
  silent: GainNode;
  capture: AudioNode | null;
};

const SCRIPT_PROCESSOR_BUFFER = 4096;
const GAIN_SMOOTHING_SECONDS = 0.02;
const MIX_CHANNEL = 0;
const SPEECH_CHANNEL = 1;
const SPEECH_WINDOW_SECONDS = 0.01;
const SPEECH_ONSET_SECONDS = 0.2;
const SPEECH_REARM_SECONDS = 0.3;

// Channel 0 carries the mix that is sent; channel 1 carries microphones only, for barge-in.
const CAPTURE_WORKLET = `
class PcmMixCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const mix = input && input[${MIX_CHANNEL}];
    if (mix && mix.length > 0) {
      const speech = input[${SPEECH_CHANNEL}] || new Float32Array(0);
      this.port.postMessage([mix.slice(), speech.slice()]);
    }
    return true;
  }
}
registerProcessor("pcm-mix-capture", PcmMixCaptureProcessor);
`;

function concatFloat(left: Float32Array, right: Float32Array): Float32Array {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  const out = new Float32Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}

function hasLiveAudio(stream: MediaStream): boolean {
  return stream.getAudioTracks().some((track) => track.readyState === "live");
}

/**
 * Sums any number of MediaStreams into mono 16 kHz PCM chunks. Per-source gain is applied
 * first, the sum is scaled by 1/sqrt(n) and passed through a limiter so several hot inputs
 * cannot clip.
 */
export class AudioMixer {
  private graph: MixerGraph | null = null;
  private desired = new Map<string, MixerSource>();
  private connected = new Map<string, ConnectedSource>();
  private pending: Float32Array = new Float32Array(0);
  private pendingMicrophone: Float32Array = new Float32Array(0);
  private speechSources = new Map<string, MediaStream>();
  private speechSampleRate = 0;
  private speechWindowSamples = 0;
  private speechWindowEnergy = 0;
  private speechActiveSamples = 0;
  private speechHistory: number[] = [];
  private speechQuietSamples = 0;
  private speechLatched = false;
  private workletUrl: string | null = null;
  private captureGeneration = 0;
  private captureKind: "worklet" | "script" | null = null;
  private closed = false;

  constructor(
    private readonly onChunk: (pcm: Uint8Array) => void,
    private readonly onSpeechStart?: () => void,
    private readonly onMicrophoneChunk?: (pcm: Uint8Array) => void,
    private readonly onSpeechEnd?: () => void
  ) {}

  async start(): Promise<void> {
    const context = new AudioContext({ sampleRate: INBOUND_SAMPLE_RATE_HZ });
    await context.resume();
    if (this.closed) {
      await context.close();
      return;
    }
    const mixBus = context.createGain();
    const speechBus = context.createGain();
    const limiter = this.createLimiter(context);
    const merger = context.createChannelMerger(2);
    const silent = context.createGain();
    silent.gain.value = 0;
    mixBus.connect(limiter);
    limiter.connect(merger, 0, MIX_CHANNEL);
    speechBus.connect(merger, 0, SPEECH_CHANNEL);
    silent.connect(context.destination);
    const graph: MixerGraph = { context, mixBus, speechBus, limiter, merger, silent, capture: null };
    this.graph = graph;
    try {
      graph.capture = await this.createWorkletNode(context);
    } catch {
      if (this.closed) {
        return;
      }
      this.captureKind = "script";
      graph.capture = this.createScriptProcessor(context);
    }
    if (this.closed) {
      return;
    }
    merger.connect(graph.capture);
    graph.capture.connect(silent);
    this.reconcile();
  }

  setSources(sources: Map<string, MixerSource>): void {
    const microphones = new Map<string, MediaStream>();
    for (const [id, source] of sources) {
      if (source.kind === "microphone" && source.gain > 0 && hasLiveAudio(source.stream)) {
        microphones.set(id, source.stream);
      }
    }
    const microphoneChanged = microphones.size !== this.speechSources.size ||
      [...microphones].some(([id, stream]) => this.speechSources.get(id) !== stream);
    if (microphoneChanged) {
      this.captureGeneration += 1;
      this.pending = new Float32Array(0);
      this.pendingMicrophone = new Float32Array(0);
      this.resetSpeechOnset();
    }
    this.speechSources = microphones;
    this.desired = new Map(sources);
    this.reconcile();
    if (microphoneChanged) this.replaceCaptureGraph();
  }

  /** Drain held samples before disconnecting; silence finalizes the existing ASR epoch. */
  finishMicrophone(): void {
    const rate = this.graph?.context.sampleRate;
    if (!rate || this.closed) return;
    const needed = Math.max(1, Math.round(rate * CAPTURE_CHUNK_SECONDS));
    if (this.pending.length) {
      const padded = new Float32Array(needed);
      padded.set(this.pending.subarray(0, needed));
      this.pending = new Float32Array(0);
      this.onChunk(floatToS16le(resampleLinear(padded, rate, INBOUND_SAMPLE_RATE_HZ)));
    }
    if (this.pendingMicrophone.length) {
      const padded = new Float32Array(needed);
      padded.set(this.pendingMicrophone.subarray(0, needed));
      this.onMicrophoneChunk?.(floatToS16le(resampleLinear(padded, rate, INBOUND_SAMPLE_RATE_HZ)));
    }
    this.pendingMicrophone = new Float32Array(0);
    for (let i = 0; i < 6; i += 1) {
      this.onMicrophoneChunk?.(new Uint8Array(INBOUND_SAMPLE_RATE_HZ * CAPTURE_CHUNK_SECONDS * BYTES_PER_SAMPLE));
    }
  }

  stop(): void {
    this.closed = true;
    this.pending = new Float32Array(0);
    this.pendingMicrophone = new Float32Array(0);
    this.resetSpeechOnset();
    this.speechSources.clear();
    for (const source of this.connected.values()) {
      source.input.disconnect();
      source.level.disconnect();
    }
    this.connected.clear();
    const graph = this.graph;
    this.graph = null;
    if (graph) {
      if (graph.capture) this.disconnectCapture(graph.capture);
      graph.merger.disconnect();
      if (graph.context.state !== "closed") {
        void graph.context.close();
      }
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
  }

  private createLimiter(context: AudioContext): DynamicsCompressorNode {
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    return limiter;
  }

  private disconnectCapture(capture: AudioNode): void {
    capture.disconnect();
    if ("port" in capture) {
      const port = (capture as AudioWorkletNode).port;
      port.onmessage = null;
      port.close();
    } else if ("onaudioprocess" in capture) {
      (capture as ScriptProcessorNode).onaudioprocess = null;
    }
  }

  /** Old nodes retain their immutable generation, even if their callbacks were already queued. */
  private replaceCaptureGraph(): void {
    const graph = this.graph;
    if (!graph?.capture || !this.captureKind || this.closed) return;
    let capture: AudioNode;
    try {
      capture = this.captureKind === "worklet"
        ? this.createWorkletCapture(graph.context) : this.createScriptProcessor(graph.context);
    } catch {
      this.captureKind = "script";
      capture = this.createScriptProcessor(graph.context);
    }
    // A new limiter also drops its look-ahead buffer of pre-cancel microphone
    // samples. Keep the context and library source nodes alive throughout.
    graph.mixBus.disconnect();
    graph.speechBus.disconnect();
    graph.limiter.disconnect();
    graph.merger.disconnect();
    this.disconnectCapture(graph.capture);
    graph.limiter = this.createLimiter(graph.context);
    graph.merger = graph.context.createChannelMerger(2);
    graph.capture = capture;
    graph.mixBus.connect(graph.limiter);
    graph.limiter.connect(graph.merger, 0, MIX_CHANNEL);
    graph.speechBus.connect(graph.merger, 0, SPEECH_CHANNEL);
    graph.merger.connect(capture);
    capture.connect(graph.silent);
  }

  private reconcile(): void {
    const graph = this.graph;
    if (!graph || !graph.capture || this.closed) {
      return;
    }
    const now = graph.context.currentTime;
    for (const [id, source] of this.connected) {
      const wanted = this.desired.get(id);
      if (!wanted || wanted.stream !== source.stream || wanted.kind !== source.kind) {
        source.input.disconnect();
        source.level.disconnect();
        this.connected.delete(id);
      }
    }
    for (const [id, wanted] of this.desired) {
      let source = this.connected.get(id);
      if (!source) {
        if (!hasLiveAudio(wanted.stream)) {
          continue;
        }
        const input = graph.context.createMediaStreamSource(wanted.stream);
        const level = graph.context.createGain();
        level.gain.value = wanted.gain;
        input.connect(level);
        level.connect(graph.mixBus);
        if (wanted.kind === "microphone") {
          level.connect(graph.speechBus);
        }
        source = { ...wanted, input, level };
        this.connected.set(id, source);
      }
      source.gain = wanted.gain;
      source.level.gain.setTargetAtTime(wanted.gain, now, GAIN_SMOOTHING_SECONDS);
    }
    const count = this.connected.size;
    graph.mixBus.gain.setTargetAtTime(count > 1 ? 1 / Math.sqrt(count) : 1, now, GAIN_SMOOTHING_SECONDS);
  }

  private async createWorkletNode(context: AudioContext): Promise<AudioNode> {
    const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    this.workletUrl = url;
    await context.audioWorklet.addModule(url);
    this.captureKind = "worklet";
    return this.createWorkletCapture(context);
  }

  private createWorkletCapture(context: AudioContext): AudioNode {
    const generation = this.captureGeneration;
    const node = new AudioWorkletNode(context, "pcm-mix-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (generation !== this.captureGeneration) return;
      const data = event.data;
      if (Array.isArray(data) && data[0] instanceof Float32Array && data[1] instanceof Float32Array) {
        this.handleSamples(data[0], data[1]);
      }
    };
    return node;
  }

  private createScriptProcessor(context: AudioContext): AudioNode {
    const generation = this.captureGeneration;
    const processor = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 2, 1);
    processor.channelCountMode = "explicit";
    processor.channelInterpretation = "discrete";
    processor.onaudioprocess = (event) => {
      if (generation !== this.captureGeneration) return;
      const input = event.inputBuffer;
      const speech = input.numberOfChannels > SPEECH_CHANNEL ? input.getChannelData(SPEECH_CHANNEL) : new Float32Array(0);
      this.handleSamples(input.getChannelData(MIX_CHANNEL).slice(), speech);
    };
    return processor;
  }

  private resetSpeechOnset(): void {
    const wasActive = this.speechLatched;
    this.speechSampleRate = 0;
    this.speechWindowSamples = 0;
    this.speechWindowEnergy = 0;
    this.speechActiveSamples = 0;
    this.speechHistory = [];
    this.speechQuietSamples = 0;
    this.speechLatched = false;
    if (wasActive) this.onSpeechEnd?.();
  }

  private detectSpeechOnset(speech: Float32Array, sampleRate: number): void {
    if (this.speechSampleRate !== sampleRate) {
      this.resetSpeechOnset();
      this.speechSampleRate = sampleRate;
    }
    const windowSamples = Math.max(1, Math.round(sampleRate * SPEECH_WINDOW_SECONDS));
    const onsetSamples = Math.ceil(sampleRate * SPEECH_ONSET_SECONDS);
    const rearmSamples = Math.ceil(sampleRate * SPEECH_REARM_SECONDS);
    // Fixed small windows prevent a short impulse in a large ScriptProcessor
    // block from counting as sustained speech. Carry only energy/counts across
    // callbacks; capture PCM is neither changed nor retained by this detector.
    // Sustained speaker echo can still qualify; this is not echo cancellation.
    for (let index = 0; index < speech.length; index += 1) {
      const sample = speech[index];
      this.speechWindowEnergy += sample * sample;
      this.speechWindowSamples += 1;
      if (this.speechWindowSamples < windowSamples) continue;
      const rms = Math.sqrt(this.speechWindowEnergy / this.speechWindowSamples);
      this.speechWindowEnergy = 0;
      this.speechWindowSamples = 0;
      // Keep only 30 classified 10ms windows, never microphone PCM. Small
      // pauses may occur within speech, but old isolated sounds must expire.
      const hotSamples = rms >= BARGE_IN_RMS_THRESHOLD ? windowSamples : 0;
      this.speechHistory.push(hotSamples);
      this.speechActiveSamples += hotSamples;
      if (this.speechHistory.length > 30) {
        this.speechActiveSamples -= this.speechHistory.shift()!;
      }
      if (rms >= BARGE_IN_RMS_THRESHOLD) {
        this.speechQuietSamples = 0;
        if (!this.speechLatched && this.speechActiveSamples >= onsetSamples) {
          this.speechLatched = true;
          this.onSpeechStart?.();
        }
      } else {
        this.speechQuietSamples = Math.min(rearmSamples, this.speechQuietSamples + windowSamples);
        if (this.speechLatched && this.speechQuietSamples >= rearmSamples) {
          this.speechLatched = false;
          this.onSpeechEnd?.();
        }
      }
    }
  }

  private handleSamples(mix: Float32Array, speech: Float32Array): void {
    const context = this.graph?.context;
    if (this.closed || !context || mix.length === 0 || this.connected.size === 0) {
      return;
    }
    const micActive = [...this.connected.values()].some(source => source.kind === 'microphone' && source.gain > 0 && hasLiveAudio(source.stream));
    if (micActive && speech.length > 0) {
      if (this.onSpeechStart) this.detectSpeechOnset(speech, context.sampleRate);
    } else {
      this.resetSpeechOnset();
    }
    this.pending = concatFloat(this.pending, mix);
    const needed = Math.max(1, Math.round(context.sampleRate * CAPTURE_CHUNK_SECONDS));
    if (this.onMicrophoneChunk && micActive) {
      this.pendingMicrophone = concatFloat(this.pendingMicrophone, speech);
      while (this.pendingMicrophone.length >= needed) {
        const slice = this.pendingMicrophone.subarray(0, needed);
        this.pendingMicrophone = this.pendingMicrophone.slice(needed);
        this.onMicrophoneChunk(floatToS16le(resampleLinear(slice, context.sampleRate, INBOUND_SAMPLE_RATE_HZ)));
      }
    } else {
      this.pendingMicrophone = new Float32Array(0);
    }
    while (this.pending.length >= needed) {
      const slice = this.pending.subarray(0, needed);
      this.pending = this.pending.slice(needed);
      const pcm = floatToS16le(resampleLinear(slice, context.sampleRate, INBOUND_SAMPLE_RATE_HZ));
      if (pcm.byteLength >= BYTES_PER_SAMPLE) {
        this.onChunk(pcm);
      }
    }
  }
}
