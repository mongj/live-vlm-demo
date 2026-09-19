export const INBOUND_SAMPLE_RATE_HZ = 16_000;
export const OUTBOUND_SAMPLE_RATE_HZ = 24_000;
export const BYTES_PER_SAMPLE = 2;
export const CAPTURE_CHUNK_SECONDS = 0.1;

const BASE64_CHUNK = 0x2000;
const SCRIPT_PROCESSOR_BUFFER = 4096;

const CAPTURE_WORKLET = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (samples && samples.length > 0) {
      this.port.postMessage(samples);
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
`;

export function encodePcmBase64(pcm: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < pcm.length; offset += BASE64_CHUNK) {
    const slice = pcm.subarray(offset, offset + BASE64_CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function decodePcmBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function floatToS16le(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const value = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(i * BYTES_PER_SAMPLE, value, true);
  }
  return out;
}

export function s16leToFloat(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(Math.floor(pcm.byteLength / BYTES_PER_SAMPLE));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * BYTES_PER_SAMPLE, true) / 0x8000;
  }
  return samples;
}

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || input.length === 0) {
    return new Float32Array(0);
  }
  if (fromRate === toRate) {
    return input.slice();
  }
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const src = i * ratio;
    const index = Math.floor(src);
    const frac = src - index;
    const a = input[index] ?? 0;
    const b = input[Math.min(index + 1, input.length - 1)] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}

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

export class PcmPlayer {
  private readonly context: AudioContext;
  private nextTime = 0;
  private leftover = new Uint8Array(0);
  private sources: AudioBufferSourceNode[] = [];

  constructor() {
    this.context = new AudioContext();
  }

  async resume(): Promise<void> {
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  enqueue(pcmBase64: string): void {
    let bytes: Uint8Array;
    try {
      bytes = decodePcmBase64(pcmBase64);
    } catch {
      return;
    }
    const merged = concatBytes(this.leftover, bytes);
    const even = merged.byteLength - (merged.byteLength % BYTES_PER_SAMPLE);
    this.leftover = even < merged.byteLength ? merged.slice(even) : new Uint8Array(0);
    if (even < BYTES_PER_SAMPLE) {
      return;
    }
    const floats = s16leToFloat(merged.subarray(0, even));
    if (floats.length === 0) {
      return;
    }
    const buffer = this.context.createBuffer(1, floats.length, OUTBOUND_SAMPLE_RATE_HZ);
    buffer.getChannelData(0).set(floats);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const now = this.context.currentTime;
    if (this.nextTime < now) {
      this.nextTime = now;
    }
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((entry) => entry !== source);
    };
  }

  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
      source.disconnect();
    }
    this.sources = [];
    this.nextTime = 0;
    this.leftover = new Uint8Array(0);
  }

  close(): void {
    this.stop();
    void this.context.close();
  }
}

export class PcmCapture {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private mute: GainNode | null = null;
  private workletUrl: string | null = null;
  private pending = new Float32Array(0);
  private closed = false;

  constructor(
    private readonly stream: MediaStream,
    private readonly onChunk: (pcm: Uint8Array) => void
  ) {}

  async start(): Promise<void> {
    const context = new AudioContext({ sampleRate: INBOUND_SAMPLE_RATE_HZ });
    this.context = context;
    await context.resume();
    if (this.closed) {
      await context.close();
      return;
    }
    this.source = context.createMediaStreamSource(this.stream);
    try {
      await this.startWorklet(context);
    } catch {
      this.startScriptProcessor(context);
    }
  }

  stop(): void {
    this.closed = true;
    this.pending = new Float32Array(0);
    this.source?.disconnect();
    this.node?.disconnect();
    this.mute?.disconnect();
    this.source = null;
    this.node = null;
    this.mute = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") {
      void context.close();
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
  }

  private async startWorklet(context: AudioContext): Promise<void> {
    const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    this.workletUrl = url;
    await context.audioWorklet.addModule(url);
    if (this.closed || !this.source) {
      throw new Error("Capture closed");
    }
    const node = new AudioWorkletNode(context, "pcm-capture");
    node.port.onmessage = (event) => {
      if (event.data instanceof Float32Array) {
        this.handleSamples(event.data);
      }
    };
    this.connectGraph(context, node);
  }

  private startScriptProcessor(context: AudioContext): void {
    if (!this.source) {
      return;
    }
    const processor = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    processor.onaudioprocess = (event) => {
      this.handleSamples(event.inputBuffer.getChannelData(0));
    };
    this.connectGraph(context, processor);
  }

  private connectGraph(context: AudioContext, node: AudioNode): void {
    if (!this.source) {
      return;
    }
    const mute = context.createGain();
    mute.gain.value = 0;
    this.source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
    this.node = node;
    this.mute = mute;
  }

  private handleSamples(samples: Float32Array): void {
    if (this.closed || samples.length === 0) {
      return;
    }
    const context = this.context;
    if (!context) {
      return;
    }
    this.pending = concatFloat(this.pending, samples);
    const needed = Math.max(1, Math.round(context.sampleRate * CAPTURE_CHUNK_SECONDS));
    while (this.pending.length >= needed) {
      const slice = this.pending.subarray(0, needed);
      this.pending = this.pending.slice(needed);
      const resampled = resampleLinear(slice, context.sampleRate, INBOUND_SAMPLE_RATE_HZ);
      const pcm = floatToS16le(resampled);
      if (pcm.byteLength >= BYTES_PER_SAMPLE) {
        this.onChunk(pcm);
      }
    }
  }
}
