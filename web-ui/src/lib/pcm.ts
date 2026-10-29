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

/** Seconds on the AudioContext playback clock, not wall time. */
export interface PlaybackInterval { start: number; end: number }

export type PcmStopReason = "stopped" | "interrupted" | "muted" | "zero_volume" | "closed";
type AudioFailure = "not_allowed" | "invalid_state" | "other";
/** Browser scheduling/source lifecycle evidence, never a claim of audible output. */
export interface PcmPlaybackEvent {
  state: "scheduled" | "ended" | "cancelled" | "context_state" | "resume_failed" | "output_settings" | "output_device_changed" | "output_device_failed";
  playbackChunk?: number;
  caption_unit?: number;
  audioContextState: "running" | "suspended" | "closed" | "interrupted" | "unknown";
  outputMuted: boolean;
  outputVolume: number;
  audioClockMs?: number;
  playbackStartMs?: number;
  playbackEndMs?: number;
  queuedAudioMs?: number;
  cancelledAudioMs?: number;
  playbackStopReason?: PcmStopReason;
  resumeFailure?: AudioFailure;
  outputDeviceFailure?: AudioFailure | "not_found" | "unsupported";
  baseLatencyMs?: number;
  outputLatencyMs?: number;
  outputContextMs?: number;
  outputPerformanceMs?: number;
}

type PlaybackSource = PlaybackInterval & {
  source: AudioBufferSourceNode;
  playbackChunk: number;
  caption_unit?: number;
  finished: boolean;
};

// Invalid/unavailable readings stay absent; do not clamp them into invented data.
function diagnosticNumber(value: number | undefined, maximum = 86_400_000): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined;
}

function diagnosticId(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) ? diagnosticNumber(value, 1_000_000_000) : undefined;
}

function audioFailure(error: unknown): AudioFailure {
  const name = error instanceof Error ? error.name : "";
  return name === "NotAllowedError" ? "not_allowed" : name === "InvalidStateError" ? "invalid_state" : "other";
}

export class PcmPlayer {
  private readonly context: AudioContext;
  private nextTime = 0;
  private leftover = new Uint8Array(0);
  private sources: PlaybackSource[] = [];
  private readonly output: GainNode;
  private muted = false;
  private volume = 1;
  private nextChunk = 0;
  private closed = false;

  constructor(private readonly onLifecycle?: (event: PcmPlaybackEvent) => void) {
    this.context = new AudioContext();
    this.output = this.context.createGain();
    this.output.connect(this.context.destination);
    this.context.onstatechange = () => this.emit({state: "context_state"});
    this.emit({state: "context_state"});
  }

  setMuted(muted: boolean): void {
    if (this.closed) return;
    this.muted = muted;
    this.output.gain.value = muted ? 0 : this.volume;
    if (muted) this.stop("muted");
    this.emit({state: "output_settings"});
  }

  setVolume(volume: number): void {
    if (this.closed || !Number.isFinite(volume)) return;
    this.volume = Math.min(1, Math.max(0, volume));
    this.output.gain.value = this.muted ? 0 : this.volume;
    if (this.volume === 0) this.stop("zero_volume");
    this.emit({state: "output_settings"});
  }

  async resume(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.context.state === "suspended") await this.context.resume();
    } catch (error) {
      // Callers intentionally fire-and-forget resume; report without rejecting.
      this.emit({state: "resume_failed", resumeFailure: audioFailure(error)});
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    try {
      await setContextSink(this.context, deviceId);
      this.emit("setSinkId" in this.context ? {state: "output_device_changed"}
        : {state: "output_device_failed", outputDeviceFailure: "unsupported"});
    } catch (error) {
      this.emit({state: "output_device_failed", outputDeviceFailure:
        error instanceof Error && error.name === "NotFoundError" ? "not_found" : audioFailure(error)});
      throw error; // Preserve the existing caller-visible routing failure.
    }
  }

  enqueue(pcmBase64: string, caption_unit?: number): PlaybackInterval | null {
    if (this.closed || this.muted || this.volume === 0) return null;
    let bytes: Uint8Array;
    try {
      bytes = decodePcmBase64(pcmBase64);
    } catch {
      return null;
    }
    const merged = concatBytes(this.leftover, bytes);
    const even = merged.byteLength - (merged.byteLength % BYTES_PER_SAMPLE);
    this.leftover = even < merged.byteLength ? merged.slice(even) : new Uint8Array(0);
    if (even < BYTES_PER_SAMPLE) {
      return null;
    }
    const floats = s16leToFloat(merged.subarray(0, even));
    if (floats.length === 0) {
      return null;
    }
    const buffer = this.context.createBuffer(1, floats.length, OUTBOUND_SAMPLE_RATE_HZ);
    buffer.getChannelData(0).set(floats);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    const now = this.context.currentTime;
    if (this.nextTime < now) {
      this.nextTime = now;
    }
    const start = this.nextTime;
    source.start(start);
    this.nextTime += buffer.duration;
    const end = this.nextTime;
    const entry: PlaybackSource = {source, start, end, playbackChunk: ++this.nextChunk,
      caption_unit: diagnosticId(caption_unit), finished: false};
    this.sources.push(entry);
    source.onended = () => {
      if (entry.finished) return;
      entry.finished = true;
      source.onended = null;
      this.sources = this.sources.filter((current) => current !== entry);
      try { source.disconnect(); } catch { /* Already disconnected. */ }
      this.emit({state: "ended", playbackChunk: entry.playbackChunk, caption_unit: entry.caption_unit,
        playbackStartMs: start * 1000, playbackEndMs: end * 1000});
    };
    this.emit({state: "scheduled", playbackChunk: entry.playbackChunk, caption_unit: entry.caption_unit,
      playbackStartMs: start * 1000, playbackEndMs: end * 1000});
    return { start, end };
  }

  clockTime(): number {
    return this.context.currentTime;
  }

  queuedMs(): number {
    return Math.max(0, this.nextTime - this.context.currentTime) * 1000;
  }

  stop(reason: PcmStopReason = "stopped"): number {
    const cancelledMs = this.queuedMs();
    const now = this.context.currentTime;
    const sources = this.sources;
    this.sources = [];
    this.nextTime = 0;
    this.leftover = new Uint8Array(0);
    // Set every terminal flag before stop() can synchronously dispatch onended.
    for (const entry of sources) entry.finished = true;
    for (const entry of sources) {
      const source = entry.source;
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished.
      }
      try { source.disconnect(); } catch { /* Already disconnected. */ }
      this.emit({state: "cancelled", playbackChunk: entry.playbackChunk, caption_unit: entry.caption_unit,
        playbackStartMs: entry.start * 1000, playbackEndMs: entry.end * 1000, playbackStopReason: reason,
        cancelledAudioMs: Math.max(0, entry.end - Math.max(now, entry.start)) * 1000});
    }
    return cancelledMs;
  }

  isActive(): boolean {
    return this.sources.length > 0;
  }

  close(): void {
    if (this.closed) return;
    this.stop("closed");
    this.closed = true;
    this.context.onstatechange = null;
    void this.context.close().catch(() => {});
  }

  private emit(details: Pick<PcmPlaybackEvent, "state"> & Partial<PcmPlaybackEvent>): void {
    if (this.closed || !this.onLifecycle) return;
    try {
      let timestamp: AudioTimestamp | undefined;
      try { timestamp = this.context.getOutputTimestamp?.(); } catch { /* Optional browser evidence. */ }
      const state: string = this.context.state;
      this.onLifecycle({...details,
        audioContextState: state === "running" || state === "suspended" || state === "closed" || state === "interrupted" ? state : "unknown",
        outputMuted: this.muted, outputVolume: this.volume,
        playbackChunk: diagnosticId(details.playbackChunk), caption_unit: diagnosticId(details.caption_unit),
        audioClockMs: diagnosticNumber(this.context.currentTime * 1000),
        playbackStartMs: diagnosticNumber(details.playbackStartMs), playbackEndMs: diagnosticNumber(details.playbackEndMs),
        queuedAudioMs: diagnosticNumber(this.queuedMs()), cancelledAudioMs: diagnosticNumber(details.cancelledAudioMs),
        baseLatencyMs: diagnosticNumber(this.context.baseLatency * 1000, 60_000),
        outputLatencyMs: diagnosticNumber(this.context.outputLatency * 1000, 60_000),
        outputContextMs: diagnosticNumber(timestamp?.contextTime === undefined ? undefined : timestamp.contextTime * 1000),
        outputPerformanceMs: diagnosticNumber(timestamp?.performanceTime),
      });
    } catch {
      // Diagnostics and optional browser metrics must never break playback.
    }
  }
}
