import {
  BARGE_IN_RMS_THRESHOLD,
  BYTES_PER_SAMPLE,
  CAPTURE_CHUNK_SECONDS,
  floatRms,
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
  private workletUrl: string | null = null;
  private closed = false;

  constructor(
    private readonly onChunk: (pcm: Uint8Array) => void,
    private readonly onSpeechStart?: () => void
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
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
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
    this.desired = new Map(sources);
    this.reconcile();
  }

  stop(): void {
    this.closed = true;
    this.pending = new Float32Array(0);
    for (const source of this.connected.values()) {
      source.input.disconnect();
      source.level.disconnect();
    }
    this.connected.clear();
    const graph = this.graph;
    this.graph = null;
    if (graph) {
      graph.capture?.disconnect();
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
    const node = new AudioWorkletNode(context, "pcm-mix-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (Array.isArray(data) && data[0] instanceof Float32Array && data[1] instanceof Float32Array) {
        this.handleSamples(data[0], data[1]);
      }
    };
    return node;
  }

  private createScriptProcessor(context: AudioContext): AudioNode {
    const processor = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 2, 1);
    processor.channelCountMode = "explicit";
    processor.channelInterpretation = "discrete";
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const speech = input.numberOfChannels > SPEECH_CHANNEL ? input.getChannelData(SPEECH_CHANNEL) : new Float32Array(0);
      this.handleSamples(input.getChannelData(MIX_CHANNEL).slice(), speech);
    };
    return processor;
  }

  private handleSamples(mix: Float32Array, speech: Float32Array): void {
    const context = this.graph?.context;
    if (this.closed || !context || mix.length === 0) {
      return;
    }
    if (this.onSpeechStart && floatRms(speech) >= BARGE_IN_RMS_THRESHOLD) {
      this.onSpeechStart();
    }
    this.pending = concatFloat(this.pending, mix);
    const needed = Math.max(1, Math.round(context.sampleRate * CAPTURE_CHUNK_SECONDS));
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
