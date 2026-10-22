export type EvidenceEvent = "start" | "socket_open" | "session_accepted" | "session_ended" | "input" | "input_status" | "output" | "response_boundary" | "diagnostic" | "playback" | "interrupt" | "issue" | "failure" | "stop";
export type EvidenceReason = "input_overload" | "startup_failed" | "socket_error" | "socket_closed" | "gateway_error" | "input_failed" | "typed_timeout" | "send_failed" | "stop_failed" | "malformed_message" | "stopped" | "unmounted" | "replaced";
export type SessionLogSummary = {eventCount:number; issueCount:number; terminal:boolean; downloadStatus:string};
const reasons = new Set<EvidenceReason>(["input_overload","startup_failed","socket_error","socket_closed","gateway_error","input_failed","typed_timeout","send_failed","stop_failed","malformed_message","stopped","unmounted","replaced"]);
const events = new Set<EvidenceEvent>(["start","socket_open","session_accepted","session_ended","input","input_status","output","response_boundary","diagnostic","playback","interrupt","issue","failure","stop"]);
const strings: Record<string,Set<string>> = {
  source:new Set(["microphone","mixed_audio","typed","video","voice","server","input-transcription"]),
  state:new Set(["transcribing","preparing","sending","sent","waiting","failed","cancelled","connecting","queued","connected","listening","responding","error","closed","startup","admission","session_ready","input_sent","model_output","input_drop","asr_complete","asr_failed","tts_complete","tts_failed"]),
  reason:reasons,
  stage:new Set(["connecting","queued","connected","listening","responding","error","closed"]),
};
const numeric = new Set(["bytes","textChars","sequence","generation","turnOrder","revision","frames","packets","inputAudioMs","outputAudioMs","dropped_audio_ms","text_chunks","audio_chunks","asr_ms","tts_ms","elapsed_ms","chunk_index","prefill_ms","generate_ms","wall_clock_ms","cost_llm_ms","kv_cache_length","n_tokens","n_tts_tokens","vision_slices","vision_tokens"]);
const booleans = new Set(["final","interrupted","discarded","transcription","typed_input","hasFrame","hasText","accepted"]);
type EvidenceRow = {event:EvidenceEvent; at:number; elapsedMs:number; [key:string]:unknown};

/** Bounded metadata only. Never pass raw protocol messages or error strings to exports. */
export class SessionEvidence {
  private rows: EvidenceRow[] = [];
  private aliases = new Map<string,string>();
  private byteCount = 512;
  private dropped = 0;
  private issues = 0;
  private terminalReason: EvidenceReason | null = null;
  private endedAt: number | null = null;
  private durationMs: number | null = null;
  private downloadStatus = "Not downloaded";
  readonly startedAt:number;
  readonly model:string;
  private startTick:number;
  private maxEvents:number;
  private maxBytes:number;
  autoDownloadAttempted = false;

  constructor(model:string, at=Date.now(), tick=performance.now(), limits={maxEvents:20_000,maxBytes:10*1024*1024}) {
    this.model = ["joyai-vl","minicpm-o-4-5","gemini-3-8-live","mock"].includes(model) ? model : "other";
    this.startedAt=at; this.startTick=tick;
    this.maxEvents=Math.min(20_000,Math.max(1,limits.maxEvents));
    this.maxBytes=Math.min(10*1024*1024,Math.max(512,limits.maxBytes));
  }

  add(event:EvidenceEvent, data:Record<string,unknown>={}, at=Date.now(), tick=performance.now()) {
    if (!events.has(event) || this.terminalReason) return;
    if (event === "issue") this.issues++;
    if (this.dropped > 0 || this.rows.length >= this.maxEvents) { this.dropped++; return; }
    const row:EvidenceRow={event,at,elapsedMs:Math.max(0,tick-this.startTick)};
    for (const [key,value] of Object.entries(data)) {
      if (numeric.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) row[key]=value;
      else if (booleans.has(key) && typeof value === "boolean") row[key]=value;
      else if (typeof value === "string" && strings[key] instanceof Set && strings[key].has(value)) row[key]=value;
      else if (key === "inputId" && typeof value === "string" && value.length <= 128) {
        if (!this.aliases.has(value)) this.aliases.set(value,`input-${this.aliases.size+1}`);
        row.inputId=this.aliases.get(value);
      }
    }
    const bytes=new TextEncoder().encode(JSON.stringify(row)).byteLength+1;
    if (this.byteCount+bytes > this.maxBytes) { this.dropped++; return; }
    this.rows.push(row); this.byteCount+=bytes;
  }

  finish(reason:EvidenceReason, at=Date.now(), tick=performance.now()) {
    if (this.terminalReason) return;
    const safe=reasons.has(reason) ? reason : "gateway_error";
    this.add(safe === "stopped" || safe === "unmounted" || safe === "replaced" ? "stop" : "failure",{reason:safe},at,tick);
    this.terminalReason=safe;
    this.endedAt=at;
    this.durationMs=Math.max(0,tick-this.startTick);
  }
  setDownloadStatus(status:"Download requested · check browser downloads"|"Download unavailable · retry manually") { this.downloadStatus=status; }
  summary():SessionLogSummary { return {eventCount:this.rows.length,issueCount:this.issues,terminal:this.terminalReason !== null,downloadStatus:this.downloadStatus}; }
  snapshot() { return {version:1,scope:"Browser-observed events; upstream metrics are sampled. Not full server/GPU logs. Memory-only until downloaded.",model:this.model,startedAt:this.startedAt,endedAt:this.endedAt,durationMs:this.durationMs,terminalReason:this.terminalReason,truncated:this.dropped>0,droppedEvents:this.dropped,issueCount:this.issues,limits:{maxEvents:this.maxEvents,maxBytes:this.maxBytes},events:this.rows.map(row=>({...row}))}; }
}

export function safeFailureReason(message:unknown, fallback:EvidenceReason="gateway_error"):EvidenceReason {
  return typeof message === "string" && /\binput_overload\b/i.test(message) ? "input_overload" : fallback;
}
export function overloadRecoveryMessage(message:string):string {
  return safeFailureReason(message) === "input_overload"
    ? "MiniCPM fell behind the live stream (input_overload). Start a new session to clear the backlog. Open Debug to download the diagnostic log."
    : message;
}
