export type EvidenceEvent = "start" | "client_config" | "generation_config" | "socket_open" | "session_accepted" | "session_ended" | "input" | "input_status" | "output" | "response_boundary" | "diagnostic" | "playback" | "caption_timeline" | "interrupt" | "issue" | "state_change" | "failure" | "stop";
export type EvidenceReason = "input_overload" | "startup_failed" | "socket_error" | "socket_closed" | "gateway_error" | "input_failed" | "typed_timeout" | "send_failed" | "stop_failed" | "malformed_message" | "stopped" | "unmounted" | "replaced";
export type SessionLogSummary = {eventCount:number; issueCount:number; stateChangeCount:number; terminal:boolean; downloadStatus:string; transcriptEnabled:boolean};
export type TranscriptEndReason = "model_final" | "interrupted" | "session_ended";
export type TranscriptInterruptionSource = "microphone" | "typed" | "server" | "input-transcription";
type TranscriptTiming = {
  firstTextAtSgt:string;lastTextUpdateAtSgt:string;
  firstTextElapsedSeconds:number;lastTextUpdateElapsedSeconds:number;
  gapSincePreviousMessageUpdateSeconds:number|null;
  gapStatus:"first_message"|"available"|"overlap"|"unavailable";
};
type TranscriptRow = {role:"user"|"assistant";source?:"voice"|"typed";text:string;at:number;updatedAt:number;partial:boolean;endReason?:TranscriptEndReason;interruptionSource?:TranscriptInterruptionSource;timing?:TranscriptTiming|null};
const transcriptEndReasons=new Set<unknown>(["model_final","interrupted","session_ended"]);
const interruptionSources=new Set<unknown>(["microphone","typed","server","input-transcription"]);
type SavedTranscript = {entries:TranscriptRow[];truncated:boolean};
const transcriptBudget = 256 * 1024;
const sgtOffsetMs = 8 * 60 * 60 * 1000;
const validTranscriptTime = (value:unknown):value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 - sgtOffsetMs;

/** Export metadata only: never changes the displayed transcript or playback. */
function withTranscriptTiming(transcript:SavedTranscript,start:number):SavedTranscript {
  return {...transcript,entries:transcript.entries.map((row,index)=>{
    // Preserve uncertainty when sanitization had to repair an old timestamp.
    if (row.timing === null) return {...row,timing:null};
    const previous=transcript.entries[index-1];
    const gapStatus:TranscriptTiming["gapStatus"]=!previous ? "first_message" : previous.timing === null ? "unavailable" : row.at < previous.updatedAt ? "overlap" : "available";
    return {...row,timing:{
      firstTextAtSgt:new Date(row.at+sgtOffsetMs).toISOString().replace("Z","+08:00"),
      lastTextUpdateAtSgt:new Date(row.updatedAt+sgtOffsetMs).toISOString().replace("Z","+08:00"),
      firstTextElapsedSeconds:(row.at-start)/1000,
      lastTextUpdateElapsedSeconds:(row.updatedAt-start)/1000,
      gapSincePreviousMessageUpdateSeconds:gapStatus === "available" ? (row.at-previous.updatedAt)/1000 : null,
      gapStatus,
    }};
  })};
}
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
    const timingKnown=row.timing !== null && validTranscriptTime(row.at) && validTranscriptTime(row.updatedAt) && row.at >= start && row.updatedAt >= row.at && row.updatedAt <= end;
    const endReason=row.role === "assistant" && transcriptEndReasons.has(row.endReason) ? row.endReason as TranscriptEndReason : undefined;
    entries.push({role:row.role,...(["voice","typed"].includes(row.source) ? {source:row.source} : {}),text,at,updatedAt,partial:row.partial === true,
      ...(timingKnown ? {} : {timing:null}),
      ...(endReason ? {endReason} : {}),...(endReason === "interrupted" && interruptionSources.has(row.interruptionSource) ? {interruptionSource:row.interruptionSource as TranscriptInterruptionSource} : {})});
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
const events = new Set<EvidenceEvent>(["start","client_config","generation_config","socket_open","session_accepted","session_ended","input","input_status","output","response_boundary","diagnostic","playback","caption_timeline","interrupt","issue","state_change","failure","stop"]);
const strings: Record<string,Set<string>> = {
  source:new Set(["microphone","mixed_audio","typed","video","voice","server","input-transcription"]),
  state:new Set(["transcribing","preparing","sending","sent","waiting","failed","cancelled","connecting","queued","connected","listening","responding","error","closed","startup","admission","session_ready","input_sent","model_output","input_drop","asr_complete","asr_failed","tts_complete","tts_failed","speech_onset","speech_end","scheduled","stopped"]),
  reason:reasons,
  dropReason:new Set(["stale_order","microphone_active","interrupted_turn","server_interrupted"]),
  stage:new Set(["connecting","queued","connected","listening","responding","error","closed"]),
  captionState:new Set(["observed","cleared"]),
  captionMode:new Set(["audio","timed"]),
  captionClearReason:new Set(["interrupted","session_ended","failure","reset"]),
  markerSource:new Set(["button","keyboard"]),
  native_kind:new Set(["listen","text","audio"]),
  native_force_source:new Set(["none","typed","microphone"]),
};
const numeric = new Set(["bytes","textChars","sequence","generation","turnOrder","revision","frames","packets","inputAudioMs","outputAudioMs","dropped_audio_ms","text_chunks","audio_chunks","asr_ms","tts_ms","elapsed_ms","chunk_index","prefill_ms","generate_ms","wall_clock_ms","cost_llm_ms","kv_cache_length","n_tokens","n_tts_tokens","vision_slices","vision_tokens","queuedAudioMs","cancelledAudioMs","audioClockMs","playbackStartMs","playbackEndMs","latestObservedOrder","acceptedInputOrder","pendingInputOrder","lastReplyOrder"]);
const booleans = new Set(["final","interrupted","discarded","transcription","typed_input","hasFrame","hasText","accepted","last_force_listen","instructionAccepted","native_matched","native_force_listen","whitespaceOnly"]);
const nativeNumbers=new Set(["native_input_sequence","native_input_age_ms","native_input_frames","native_input_audio_ms","native_listen_events","native_listen_streak","native_since_content_ms"]);
const captionCounters=new Set(["caption_unit","captionPage","captionOrder","leadingWhitespace","trailingWhitespace"]);
const markerNumbers=new Set(["markerIndex","frameSequence","latestFrameSequence","latestFrameAt","latestFrameElapsedMs","frameAgeMs"]);
type EvidenceRow = {event:EvidenceEvent; at:number; elapsedMs:number; [key:string]:unknown};
const generationBounds:Record<string,readonly [number,number]> = {temperature:[0.1,2],topP:[0.05,1],topK:[0,200],lengthPenalty:[0.5,2]};
const playbackStrings:Record<string,ReadonlySet<string>> = {
  state:new Set(["scheduled","ended","cancelled","context_state","resume_failed","output_settings","output_device_changed","output_device_failed"]),
  audioContextState:new Set(["running","suspended","closed","interrupted","unknown"]),
  playbackStopReason:new Set(["stopped","interrupted","muted","zero_volume","closed"]),
  resumeFailure:new Set(["not_allowed","invalid_state","other"]),
  outputDeviceFailure:new Set(["not_allowed","invalid_state","not_found","unsupported","other"]),
};
const playbackNumbers=new Set(["baseLatencyMs","outputLatencyMs","outputContextMs","outputPerformanceMs"]);
const clientStrings:Record<string,ReadonlySet<string>> = {
  configurationSource:new Set(["browser_observed"]),
  microphoneMode:new Set(["push-to-talk","always-listening"]),
  videoSource:new Set(["none","camera","file"]),
};
const clientBooleans=new Set(["microphoneEnabled","videoAudioSelected","captionsEnabled","customPromptPresent"]);

/** Bounded metadata only. Never pass raw protocol messages or error strings to exports. */
export class SessionEvidence {
  private rows: EvidenceRow[] = [];
  private aliases = new Map<string,string>();
  private byteCount = 512;
  private dropped = 0;
  private issues = 0;
  private changes = 0;
  private frameCount = 0;
  private lastFrame: {sequence:number;at:number;elapsedMs:number} | null = null;
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

  captureTranscript(messages:ReadonlyArray<{id:string;role:string;text:string;source?:string;streaming?:boolean;endReason?:TranscriptEndReason;interruptionSource?:TranscriptInterruptionSource}>,at=Date.now()) {
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
    if (event === "state_change") this.changes++;
    if (this.dropped > 0 || this.rows.length >= this.maxEvents) { this.dropped++; return; }
    const row:EvidenceRow={event,at,elapsedMs:Math.max(0,tick-this.startTick)};
    if (event === "input" && data.hasFrame === true) {
      this.lastFrame={sequence:++this.frameCount,at,elapsedMs:row.elapsedMs};
      row.frameSequence=this.frameCount;
    }
    if (event === "state_change") {
      row.markerIndex=this.changes;
      if (this.lastFrame) Object.assign(row,{
        latestFrameSequence:this.lastFrame.sequence,latestFrameAt:this.lastFrame.at,
        latestFrameElapsedMs:this.lastFrame.elapsedMs,frameAgeMs:Math.max(0,row.elapsedMs-this.lastFrame.elapsedMs),
      });
    }
    for (const [key,value] of Object.entries(data)) {
      if (event === "playback" && typeof value === "string" && playbackStrings[key] instanceof Set && playbackStrings[key].has(value)) row[key]=value;
      else if (event === "playback" && key === "playbackChunk" && typeof value === "number" && Number.isSafeInteger(value) && value > 0) row[key]=value;
      else if (event === "playback" && key === "outputMuted" && typeof value === "boolean") row[key]=value;
      else if (event === "playback" && key === "outputVolume" && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) row[key]=value;
      else if (event === "playback" && playbackNumbers.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) row[key]=value;
      else if (event === "client_config" && typeof value === "string" && clientStrings[key] instanceof Set && clientStrings[key].has(value)) row[key]=value;
      else if (event === "client_config" && clientBooleans.has(key) && typeof value === "boolean") row[key]=value;
      else if (event === "client_config" && key === "telemetryRevision" && value === 2) row[key]=value;
      else if (event === "client_config" && key === "requestedFps" && typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8) row[key]=value;
      else if (event === "generation_config" && key === "source" && value === "session_request") row[key]=value;
      else if (event === "generation_config" && key === "decodeMode" && (value === "sampling" || value === "greedy")) row[key]=value;
      else if (event === "generation_config" && generationBounds[key] && typeof value === "number" && Number.isFinite(value) &&
        value >= generationBounds[key][0] && value <= generationBounds[key][1] && (key !== "topK" || Number.isInteger(value))) row[key]=value;
      else if (numeric.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) row[key]=value;
      else if (captionCounters.has(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) row[key]=value;
      else if ((markerNumbers.has(key) || nativeNumbers.has(key)) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) row[key]=value;
      else if (key === "forced_listen_packets" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) row[key]=value;
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
    // Only this new live log knows it reached a terminal boundary. Sanitizing
    // older logs must never infer model completion from partial:false.
    this.transcript.entries=this.transcript.entries.map(row=>row.role === "assistant" && !row.endReason ? {...row,endReason:"session_ended"} : row);
    this.add(safe === "stopped" || safe === "unmounted" || safe === "replaced" ? "stop" : "failure",{reason:safe},at,tick);
    this.terminalReason=safe;
    this.endedAt=at;
    this.durationMs=Math.max(0,tick-this.startTick);
  }
  setDownloadStatus(status:"Download requested · check browser downloads"|"Download unavailable · retry manually") { this.downloadStatus=status; }
  summary():SessionLogSummary { return {eventCount:this.rows.length,issueCount:this.issues,stateChangeCount:this.changes,terminal:this.terminalReason !== null,downloadStatus:this.downloadStatus,transcriptEnabled:this.transcriptEnabled}; }
  snapshot() { return {version:1,scope:`Browser-observed diagnostic events; upstream metrics sampled. No media. ${this.transcriptEnabled ? "Opt-in displayed transcript included; ASR may be inaccurate. Transcript partial reports streaming state, not completion; endReason is explicit when known. Timing is first displayed text / last text update; gap is previous retained message's last update to this message's first text, not speech-response latency. Null timing/gap means unknown, unavailable or overlapping as labelled." : "No transcripts."} State-change marks are manual activation times, not exact visual onset or correctness labels. Frame context is the preceding browser submission, not native receipt. Caption events are timeline observations, not proof of rendering or audibility. Not full server/GPU logs.`,model:this.model,startedAt:this.startedAt,endedAt:this.endedAt,durationMs:this.durationMs,terminalReason:this.terminalReason,truncated:this.dropped>0,droppedEvents:this.dropped,issueCount:this.issues,stateChangeCount:this.changes,limits:{maxEvents:this.maxEvents,maxBytes:this.maxBytes},events:this.rows.map(row=>({...row})),transcriptEnabled:this.transcriptEnabled,...(this.transcriptEnabled ? {transcript:withTranscriptTiming(this.transcript,this.startedAt)} : {})}; }
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
  if (clean.transcriptEnabled) clean.transcript=withTranscriptTiming(cleanTranscript(value.transcript,value.startedAt,clean.endedAt ?? 8.64e15),value.startedAt);
  clean.issueCount=finiteCount(value.issueCount) ? Math.floor(value.issueCount) : clean.issueCount;
  clean.stateChangeCount=finiteCount(value.stateChangeCount) ? Math.floor(value.stateChangeCount) : clean.stateChangeCount;
  clean.droppedEvents=Math.min(Number.MAX_SAFE_INTEGER,clean.droppedEvents + Math.max(0,value.events.length-maxEvents) + (finiteCount(value.droppedEvents) ? Math.floor(value.droppedEvents) : 0));
  clean.truncated=value.truncated === true || clean.droppedEvents>0;
  // Very small caller-supplied budgets must fit the fixed envelope too, not
  // just payload rows. Preserve the observation caveat in a compact scope.
  const envelope={...clean,events:[],...(clean.transcript ? {transcript:{...clean.transcript,entries:[]}} : {})};
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength>maxBytes) {
    clean.scope="Browser events; no media. Caption timeline observations, not rendering/audibility. Transcript partial=streaming, not completion.";
  }
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
