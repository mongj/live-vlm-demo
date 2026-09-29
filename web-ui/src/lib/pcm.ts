import { setContextSink } from "@/lib/media-devices";

export const INBOUND_SAMPLE_RATE_HZ = 16_000;
export const OUTBOUND_SAMPLE_RATE_HZ = 24_000;
export const BYTES_PER_SAMPLE = 2;
export const CAPTURE_CHUNK_SECONDS = 0.1;
/** RMS on captured float samples that counts as local speech onset. */
export const BARGE_IN_RMS_THRESHOLD = 0.045;

const BASE64_CHUNK = 0x2000;

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

export function floatRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
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

  setOutputDevice(deviceId: string): Promise<void> {
    return setContextSink(this.context, deviceId);
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

  isActive(): boolean {
    return this.sources.length > 0;
  }

  close(): void {
    this.stop();
    void this.context.close();
  }
}
