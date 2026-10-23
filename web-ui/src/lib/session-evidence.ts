export type EvidenceEvent = "start" | "socket_open" | "session_accepted" | "session_ended" | "input" | "input_status" | "output" | "response_boundary" | "diagnostic" | "playback" | "interrupt" | "issue" | "failure" | "stop";
export type EvidenceReason = "input_overload" | "startup_failed" | "socket_error" | "socket_closed" | "gateway_error" | "input_failed" | "typed_timeout" | "send_failed" | "stop_failed" | "malformed_message" | "stopped" | "unmounted" | "replaced";
export type SessionLogSummary = {eventCount:number; issueCount:number; terminal:boolean; downloadStatus:string; transcriptEnabled:boolean};
type TranscriptRow = {role:"user"|"assistant";source?:"voice"|"typed";text:string;at:number;updatedAt:number;partial:boolean};
type SavedTranscript = {entries:TranscriptRow[];truncated:boolean};
const transcriptBudget = 256 * 1024;
function cleanTranscript(value:unknown,start:number,end:number):SavedTranscript {
  const entries:TranscriptRow[]=[];let bytes=0,truncated=false;
  if (!value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) return {entries,truncated};
  truncated="truncated" in value && value.truncated === true;
  for (const row of value.entries) {
    if (!row || typeof row !== "object" || !["user","assistant"].includes(row.role) || typeof row.text !== "string" || !row.text.trim()) continue;
    if (entries.length>=500 || bytes>=transcriptBudget) {truncated=true;break;}
    const text=row.text.slice(0,Math.min(8000,Math.floor((transcriptBudget-bytes)/4)));
    if (text.length<row.text.length) truncated=true;
    if (!text.trim()) break;
    const at=typeof row.at === "number" && Number.isFinite(row.at) ? Math.min(end,Math.max(start,row.at)) : start;
    const updatedAt=typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? Math.min(end,Math.max(at,row.updatedAt)) : at;
    entries.push({role:row.role,...(["voice","typed"].includes(row.source) ? {source:row.source} : {}),text,at,updatedAt,partial:row.partial === true});
    bytes+=new TextEncoder().encode(text).byteLength;
  }
  return {entries,truncated};
}
export function sessionLogFilename(startedAt:number):string {
  // Fixed SGT offset, independent of the computer locale; Windows-safe.
  const stamp=new Date(startedAt+8*60*60*1000).toISOString().slice(0,-1).replace("T","_").replace(/[:.]/g,"-");
  return `session-diagnostics-${stamp}_SGT.json`;
}
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
  private transcript:SavedTranscript={entries:[],truncated:false};
  private transcriptTimes=new Map<string,{at:number;updatedAt:number;text:string}>();

  constructor(model:string, at=Date.now(), tick=performance.now(), limits={maxEvents:20_000,maxBytes:10*1024*1024}, readonly transcriptEnabled=false) {
    this.model = ["joyai-vl","minicpm-o-4-5","gemini-3-8-live","mock"].includes(model) ? model : "other";
    this.startedAt=at; this.startTick=tick;
    this.maxEvents=Math.min(20_000,Math.max(1,limits.maxEvents));
    this.maxBytes=Math.min(10*1024*1024,Math.max(512,limits.maxBytes));
  }

  captureTranscript(messages:ReadonlyArray<{id:string;role:string;text:string;source?:string;streaming?:boolean}>,at=Date.now()) {
    if (!this.transcriptEnabled || this.terminalReason) return;
    const times=new Map<string,{at:number;updatedAt:number;text:string}>();
    const rows=messages.filter(row=>row.text.trim()).slice(0,500).map(row=>{
      const previous=this.transcriptTimes.get(row.id);
      const timing={at:previous?.at ?? at,updatedAt:previous?.text === row.text ? previous.updatedAt : at,text:row.text};
      times.set(row.id,timing);
      return {...row,at:timing.at,updatedAt:timing.updatedAt,partial:row.streaming === true};
    });
    this.transcriptTimes=times;
    this.transcript=cleanTranscript({entries:rows,truncated:this.transcript.truncated || messages.length>500},this.startedAt,Math.max(this.startedAt,at));
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
  summary():SessionLogSummary { return {eventCount:this.rows.length,issueCount:this.issues,terminal:this.terminalReason !== null,downloadStatus:this.downloadStatus,transcriptEnabled:this.transcriptEnabled}; }
  snapshot() { return {version:1,scope:`Browser-observed diagnostic events; upstream metrics sampled. No media. ${this.transcriptEnabled ? "Opt-in displayed transcript included; ASR may be inaccurate." : "No transcripts."} Not full server/GPU logs.`,model:this.model,startedAt:this.startedAt,endedAt:this.endedAt,durationMs:this.durationMs,terminalReason:this.terminalReason,truncated:this.dropped>0,droppedEvents:this.dropped,issueCount:this.issues,limits:{maxEvents:this.maxEvents,maxBytes:this.maxBytes},events:this.rows.map(row=>({...row})),transcriptEnabled:this.transcriptEnabled,...(this.transcriptEnabled ? {transcript:{entries:this.transcript.entries.map(row=>({...row})),truncated:this.transcript.truncated}} : {})}; }
}

export type EvidenceSnapshot = ReturnType<SessionEvidence["snapshot"]>;
const finiteCount = (value:unknown):value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const object = (value:unknown):value is Record<string,unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Treat persisted data as untrusted, rebuilding it through the original allowlist. */
export function sanitizeEvidenceSnapshot(value:unknown, completedOnly=true):EvidenceSnapshot | null {
  if (!object(value) || value.version !== 1 || !finiteCount(value.startedAt) || value.startedAt>8.64e15 || !Array.isArray(value.events)) return null;
  const terminal = typeof value.terminalReason === "string" && reasons.has(value.terminalReason as EvidenceReason);
  if (completedOnly && (!terminal || !finiteCount(value.endedAt) || value.endedAt>8.64e15 || value.endedAt < value.startedAt || !finiteCount(value.durationMs))) return null;
  const limits=object(value.limits) ? value.limits : {};
  const maxEvents=finiteCount(limits.maxEvents) ? Math.min(20_000,Math.max(1,Math.floor(limits.maxEvents))) : 20_000;
  const maxBytes=finiteCount(limits.maxBytes) ? Math.min(10*1024*1024,Math.max(512,Math.floor(limits.maxBytes))) : 10*1024*1024;
  const rebuilt=new SessionEvidence(typeof value.model === "string" ? value.model : "other",value.startedAt,0,{maxEvents,maxBytes},value.transcriptEnabled === true);
  for (const row of value.events.slice(0,maxEvents)) {
    if (object(row) && events.has(row.event as EvidenceEvent) && finiteCount(row.at) && finiteCount(row.elapsedMs)) {
      rebuilt.add(row.event as EvidenceEvent,row,row.at,row.elapsedMs);
    }
  }
  const clean=rebuilt.snapshot();
  clean.terminalReason=terminal ? value.terminalReason as EvidenceReason : null;
  clean.endedAt=terminal && finiteCount(value.endedAt) ? value.endedAt : null;
  clean.durationMs=terminal && finiteCount(value.durationMs) ? value.durationMs : null;
  if (clean.transcriptEnabled) clean.transcript=cleanTranscript(value.transcript,value.startedAt,clean.endedAt ?? 8.64e15);
  clean.issueCount=finiteCount(value.issueCount) ? Math.floor(value.issueCount) : clean.issueCount;
  clean.droppedEvents=Math.min(Number.MAX_SAFE_INTEGER,clean.droppedEvents + Math.max(0,value.events.length-maxEvents) + (finiteCount(value.droppedEvents) ? Math.floor(value.droppedEvents) : 0));
  clean.truncated=value.truncated === true || clean.droppedEvents>0;
  while (new TextEncoder().encode(JSON.stringify(clean)).byteLength>maxBytes && (clean.events.length || clean.transcript?.entries.length)) {
    if (clean.transcript?.entries.length) {clean.transcript.entries.pop();clean.transcript.truncated=true;}
    else {clean.events.pop();clean.droppedEvents++;clean.truncated=true;}
  }
  return clean;
}

export function safeFailureReason(message:unknown, fallback:EvidenceReason="gateway_error"):EvidenceReason {
  return typeof message === "string" && /\binput_overload\b/i.test(message) ? "input_overload" : fallback;
}
export function overloadRecoveryMessage(message:string):string {
  return safeFailureReason(message) === "input_overload"
    ? "MiniCPM fell behind the live stream (input_overload). Start a new session to clear the backlog. Open Debug to download the diagnostic log."
    : message;
}
