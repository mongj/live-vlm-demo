import type { InputFeedback } from "@/lib/input-feedback.mjs";
import type { InputTranscriptionMessage, InputStatusMessage } from "@/lib/protocol";

export type SessionConnection = "none"|"connecting"|"socket"|"accepted"|"closed"|"failed";
export type SessionActivity = "idle"|"preparing"|"sending"|"waiting"|"responding";
export type SessionStatusBadge = {
  label: string;
  tone: "idle"|"listening"|"watching"|"preparing"|"sending"|"waiting"|"responding"|"error";
};
type SessionStatusState = {phase:string;connection:SessionConnection;activity:SessionActivity;mode:string;holding:boolean;listening:boolean;pending:boolean;micError:boolean;speaking?:boolean;watching?:boolean};
export function canUpdateSessionActivity(feedback:InputFeedback,event:InputTranscriptionMessage|InputStatusMessage):boolean {
  if (event.session_id !== feedback.sessionId) return false;
  if (event.source === "voice" && event.generation !== feedback.generation) return false;
  const id=event.type === "input.transcription" ? event.utterance_id : event.input_id;
  const previous=feedback.entries.find(entry=>entry.id === id);
  if (event.type === "input.transcription" && previous && (!previous.streaming || event.revision <= previous.revision)) return false;
  if (feedback.pendingId) return event.type === "input.status" && id === feedback.pendingId;
  if (event.turn_order < feedback.latestOrder) return false;
  if (event.type === "input.status" && previous && ["waiting","failed","cancelled"].includes(previous.status)
    && ["transcribing","preparing","sending","sent"].includes(event.state)) return false;
  return true;
}
export function describeSessionStatusView(state:SessionStatusState):SessionStatusBadge & {detail:string} {
  if (state.connection === "failed") return {label:"Session failed",tone:"error",detail:"Session failed · see recovery details"};
  if (state.phase === "connecting") return state.connection === "socket"
    ? {label:"Awaiting session",tone:"waiting",detail:"App connected · waiting for model session"}
    : {label:"Connecting",tone:"waiting",detail:"Connecting to app"};
  if (state.phase !== "live") return state.connection === "closed"
    ? {label:"Stopped",tone:"idle",detail:"Session stopped"}
    : {label:"Not started",tone:"idle",detail:"App loaded · model session not started"};
  if (state.pending) return {label:"Mic permission",tone:"waiting",detail:"Microphone permission pending"};
  if ((state.holding || state.speaking) && state.listening) return {label:"Listening",tone:"listening",detail:"Listening"};
  if (state.activity === "preparing") return {label:"Preparing",tone:"preparing",detail:"Preparing instruction"};
  if (state.activity === "sending") return {label:"Sending",tone:"sending",detail:"Sending instruction"};
  if (state.activity === "responding") return {label:"Responding",tone:"responding",detail:"Responding"};
  if (state.activity === "waiting") return {label:"Waiting",tone:"waiting",detail:"Waiting for response"};
  if (state.micError) return {label:"Mic unavailable",tone:"error",detail:"Model session ready · microphone unavailable"};
  if (state.watching) return {label:"Watching",tone:"watching",detail:"Model session ready · watching video"};
  if (state.listening) return {label:"Listening",tone:"listening",detail:"Model session ready · listening"};
  return state.mode === "push-to-talk"
    ? {label:"Hold to speak",tone:"idle",detail:"Model session ready · Hold to speak"}
    : {label:"Mic off",tone:"idle",detail:"Model session ready · microphone off"};
}
export function describeSessionStatus(state:SessionStatusState):string {
  return describeSessionStatusView(state).detail;
}
