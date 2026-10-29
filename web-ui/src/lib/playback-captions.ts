import type { PlaybackInterval } from "./pcm";

type Cue = { text: string; start: number; end: number; audio: boolean; order: number; unit?: number; page: number; turn: number };
/** Timeline-selected page, not confirmation of DOM rendering or audible speech. */
export type CaptionObservation = {caption_unit?:number;captionPage:number;captionOrder:number;captionMode:"audio"|"timed";textChars:number};
type Pending = { text: string; at: number; order: number; turn: number; interval?: PlaybackInterval | null };
const MAX_CUES = 256;
const MAX_UNITS = 128;
const MAX_TEXT = 16_384;
const AUDIO_WAIT_MS = 600;
const PHRASE_PAGE_CHARS = 104;

/** Display-only pages. Concatenating them preserves the received characters. */
function pages(text: string): string[] {
  const result: string[] = [];
  let characters = Array.from(text);
  while (characters.length > 60) {
    let split = 60;
    for (let i = 59; i > 0; i--) {
      if (/\s/u.test(characters[i])) { split = i + 1; break; }
    }
    result.push(characters.slice(0, split).join(""));
    characters = characters.slice(split);
  }
  if (characters.length) result.push(characters.join(""));
  return result;
}

/** Bounded, generation-local captions; callers cancel at playback-generation reset. */
export class CaptionTimeline {
  private cues: Cue[] = [];
  private pending = new Map<number, Pending>();
  private handled = new Set<number>();
  private last = "";
  private wallEnd = 0;
  private nextOrder = 0;
  private lastOrder = -1;
  private genericTail: Cue | null = null;
  private lastObservation: CaptionObservation | null = null;
  private turn = 0;
  private phraseTurn = -1;
  private phraseOrder = -1;
  private phraseSourcePage = -1;
  private phrasePage = 0;
  private phrasePrefixPage = 0;
  private phrasePrefix = "";
  private phraseText = "";

  addText(text: string, unit: number | undefined, wallNow: number): void {
    if (!text) return;
    text = text.slice(0, MAX_TEXT);
    if (unit === undefined) { this.appendGeneric(text, wallNow); return; }
    this.genericTail = null;
    if (this.handled.has(unit)) return;
    const entry = this.pending.get(unit) ?? { text: "", at: wallNow, order: this.nextOrder++, turn: this.turn };
    entry.text = (entry.text + text).slice(0, MAX_TEXT);
    this.pending.set(unit, entry);
    if (entry.interval !== undefined) this.resolve(unit, entry, wallNow);
    this.bound(wallNow);
  }

  schedule(unit: number | undefined, interval: PlaybackInterval | null, wallNow: number): void {
    if (unit === undefined || this.handled.has(unit)) return;
    const entry = this.pending.get(unit) ?? { text: "", at: wallNow, order: this.nextOrder++, turn: this.turn };
    entry.interval = interval;
    this.pending.set(unit, entry);
    if (entry.text) this.resolve(unit, entry, wallNow);
    this.bound(wallNow);
  }

  finish(wallNow: number): void {
    this.genericTail = null;
    this.turn++;
    // Generation completion is not playback completion; keep scheduled cues.
    this.flush(wallNow);
  }

  read(audioNow: number, wallNow: number): string {
    this.flush(wallNow);
    const remaining: Cue[] = [];
    let candidate: Cue | undefined;
    let playing: Cue | undefined;
    for (const cue of this.cues) {
      const now = cue.audio ? audioNow : wallNow;
      if (now >= cue.start && cue.order >= this.lastOrder) {
        if (!candidate || cue.order >= candidate.order) candidate = cue;
        if (cue.audio && now < cue.end && (!playing || cue.order >= playing.order)) playing = cue;
      }
      if (now < cue.end) remaining.push(cue);
    }
    const visible = playing ?? candidate;
    if (visible) {
      this.last = this.readPhrase(visible, audioNow, wallNow);
      this.lastOrder = visible.order;
      this.lastObservation={...(visible.unit === undefined ? {} : {caption_unit:visible.unit}),captionPage:this.phrasePage,
        captionOrder:visible.order,captionMode:visible.audio ? "audio" : "timed",textChars:this.last.length};
    }
    this.cues = remaining;
    this.pruneSuperseded(wallNow);
    return this.last;
  }

  /** Completed retained text is not work; read() retires clock-expired cues. */
  isActive(): boolean {
    return this.pending.size > 0 || this.cues.length > 0;
  }

  observation(): CaptionObservation | null {
    return this.lastObservation ? {...this.lastObservation} : null;
  }

  mute(audioNow: number, wallNow: number): void {
    this.read(audioNow, wallNow);
    const audio = this.cues.filter((cue) => cue.audio && cue.end > audioNow);
    this.cues = this.cues.filter((cue) => !cue.audio);
    for (const cue of audio) this.fallback(cue.text, wallNow, cue.order, wallNow, cue.unit, cue.page, cue.turn);
    for (const [unit, entry] of this.pending) {
      if (entry.text) this.fallback(entry.text, wallNow, entry.order, wallNow, unit, 0, entry.turn);
      this.mark(unit);
    }
    this.pending.clear();
  }

  cancel(): void {
    this.cues = []; this.pending.clear(); this.handled.clear();
    this.last = ""; this.wallEnd = 0;
    this.genericTail = null; this.nextOrder = 0; this.lastOrder = -1;
    this.lastObservation = null;
    this.turn = 0; this.phraseTurn = -1; this.phraseOrder = -1;
    this.phraseSourcePage = -1; this.phrasePage = 0; this.phraseText = "";
    this.phrasePrefix = ""; this.phrasePrefixPage = 0;
  }

  private readPhrase(visible: Cue, audioNow: number, wallNow: number): string {
    if (visible.turn !== this.phraseTurn) {
      this.phraseTurn = visible.turn;
      this.phraseOrder = -1; this.phraseSourcePage = -1;
      this.phrasePage = 0; this.phraseText = "";
      this.phrasePrefix = ""; this.phrasePrefixPage = 0;
    }
    // Native audio units are often only one or two words. Keep their text in a
    // readable rolling phrase. Timed/muted units share the same ordered state;
    // switching sound on/off must not omit words or resurrect an older prefix.
    const ordered = [...this.cues].sort((a,b)=>a.order-b.order || a.page-b.page);
    for (const cue of ordered) {
      // A late missing-audio fallback must not be inserted ahead of newer
      // audible speech. Previously displayed timed words are already retained
      // in phraseText, including across mute/unmute transitions.
      if (visible.audio && !cue.audio && cue.order < visible.order) continue;
      if (cue.turn !== visible.turn || cue.start > (cue.audio ? audioNow : wallNow) ||
          cue.order > visible.order || (cue.order === visible.order && cue.page > visible.page) ||
          cue.order < this.phraseOrder || (cue.order === this.phraseOrder && cue.page < this.phraseSourcePage)) continue;
      if (cue.order !== this.phraseOrder || cue.page !== this.phraseSourcePage) {
        this.phrasePrefix = this.phraseText;
        this.phrasePrefixPage = this.phrasePage;
      }
      // The current generic cue can grow as text tokens arrive. Rebuild that
      // part instead of appending it twice. Whitespace is collapsed for display
      // only; the transcript and stored model output stay byte-for-byte intact.
      this.phraseText = (this.phrasePrefix + cue.text).replace(/\s+/gu," ");
      this.phrasePage = this.phrasePrefixPage;
      if (Array.from(this.phraseText.trimEnd()).length > PHRASE_PAGE_CHARS) {
        const characters=Array.from(this.phraseText);
        const prefixLength=Array.from(this.phrasePrefix.replace(/\s+/gu," ")).length;
        // Retire only words from the already presented prefix. Splitting at the
        // display limit can otherwise discard the beginning of this new cue.
        // Keep an unfinished trailing word so native subwords still join.
        const boundary=characters.lastIndexOf(" ",prefixLength-1);
        let split=boundary < 0 ? 0 : boundary+1;
        // A long URL/CJK token has no safe word boundary; keep its newest
        // codepoints bounded, without discarding the new (<=60-codepoint) cue.
        split=Math.max(split,Array.from(this.phraseText.trimEnd()).length-PHRASE_PAGE_CHARS);
        this.phraseText=characters.slice(split).join("");
        this.phrasePage++;
      }
      this.phraseOrder = cue.order; this.phraseSourcePage = cue.page;
    }
    return this.phraseText.trim();
  }

  private resolve(unit: number, entry: Pending, wallNow: number): void {
    const interval = entry.interval;
    if (!interval || !Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start) {
      this.fallback(entry.text, wallNow, entry.order, wallNow, unit, 0, entry.turn);
    } else {
      const chunks = pages(entry.text);
      const duration = interval.end - interval.start;
      let offset = 0;
      let page = 0;
      for (const text of chunks) {
        const start = interval.start + duration * offset / entry.text.length;
        offset += text.length;
        this.cues.push({ text, start, end: interval.start + duration * offset / entry.text.length, audio: true, order: entry.order, unit, page:page++, turn: entry.turn });
      }
      this.trim(wallNow);
    }
    this.pending.delete(unit); this.mark(unit);
  }

  private appendGeneric(text: string, wallNow: number): void {
    const tail = this.genericTail;
    if (tail && this.cues.includes(tail) && wallNow < tail.end) {
      this.cues = this.cues.filter((cue) => cue !== tail);
      this.wallEnd = tail.start;
      this.fallback(tail.text + text, tail.start, tail.order, wallNow, undefined, tail.page);
    } else {
      this.fallback(text, wallNow);
    }
    this.genericTail = this.cues.at(-1) ?? null;
  }

  private pruneSuperseded(wallNow: number): void {
    const obsolete = this.cues.some((cue) => !cue.audio && cue.order < this.lastOrder);
    this.cues = this.cues.filter((cue) => cue.audio || cue.order >= this.lastOrder);
    let cursor = wallNow;
    for (const cue of this.cues) {
      if (cue.audio) continue;
      if (obsolete) {
        const remaining = cue.end - Math.max(cue.start, wallNow);
        cue.start = cursor;
        cue.end = cursor + Math.max(0, remaining);
      }
      cursor = Math.max(cursor, cue.end);
    }
    this.wallEnd = cursor;
    if (this.genericTail && !this.cues.includes(this.genericTail)) this.genericTail = null;
  }

  private fallback(text: string, wallNow: number, order = this.nextOrder++, trimNow = wallNow, unit?: number, page = 0, turn = this.turn): void {
    for (const chunk of pages(text)) {
      const start = Math.max(wallNow, this.wallEnd);
      this.wallEnd = start + Math.max(1000, chunk.length * 55);
      this.cues.push({ text: chunk, start, end: this.wallEnd, audio: false, order, unit, page:page++, turn });
    }
    this.trim(trimNow);
  }

  private trim(wallNow: number): void {
    if (this.cues.length <= MAX_CUES) return;
    const removed = this.cues.splice(0, this.cues.length - MAX_CUES);
    if (!removed.some((cue) => !cue.audio)) return;
    // Eviction must remove time as well as text. Audio intervals are immutable;
    // only retained readable wall pages are compacted onto the current clock.
    let cursor = wallNow;
    for (const cue of this.cues) {
      if (cue.audio) continue;
      const duration = Math.max(0, cue.end - Math.max(cue.start, wallNow));
      cue.start = cursor;
      cue.end = cursor + duration;
      cursor = cue.end;
    }
    this.wallEnd = cursor;
    if (this.genericTail && !this.cues.includes(this.genericTail)) this.genericTail = null;
  }

  private flush(wallNow: number): void {
    for (const [unit, entry] of this.pending) {
      if (wallNow - entry.at >= AUDIO_WAIT_MS) {
        if (entry.text) this.fallback(entry.text, wallNow, entry.order, wallNow, unit, 0, entry.turn);
        this.pending.delete(unit); this.mark(unit);
      }
    }
  }

  private bound(wallNow: number): void {
    while (this.pending.size > MAX_UNITS || [...this.pending.values()].reduce((n, p) => n + p.text.length, 0) > MAX_TEXT) {
      const unit = this.pending.keys().next().value!;
      const entry = this.pending.get(unit)!;
      if (entry.text) this.fallback(entry.text, wallNow, entry.order, wallNow, unit, 0, entry.turn);
      this.pending.delete(unit); this.mark(unit);
    }
  }

  private mark(unit: number): void {
    this.handled.add(unit);
    while (this.handled.size > 512) this.handled.delete(this.handled.values().next().value!);
  }
}
