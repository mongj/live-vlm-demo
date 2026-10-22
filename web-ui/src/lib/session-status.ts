import type { InputFeedback } from "@/lib/input-feedback.mjs";
import type { InputTranscriptionMessage, InputStatusMessage } from "@/lib/protocol";

export type SessionConnection = "none"|"connecting"|"socket"|"accepted"|"closed"|"failed";
export type SessionActivity = "idle"|"preparing"|"sending"|"waiting"|"responding";
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
export function describeSessionStatus(state:{phase:string;connection:SessionConnection;activity:SessionActivity;mode:string;holding:boolean;listening:boolean;pending:boolean;micError:boolean}):string {
  if (state.connection === "failed") return "Session failed · see recovery details";
  if (state.phase === "connecting") return state.connection === "socket" ? "App connected · waiting for model session" : "Connecting to app";
  if (state.phase !== "live") return state.connection === "closed" ? "Session stopped" : "App loaded · model session not started";
  if (state.pending) return "Microphone permission pending";
  if (state.holding && state.listening) return "Listening";
  if (state.activity === "preparing") return "Preparing instruction";
  if (state.activity === "sending") return "Sending instruction";
  if (state.activity === "responding") return "Responding";
  if (state.activity === "waiting") return "Waiting for response";
  if (state.micError) return "Model session ready · microphone unavailable";
  if (state.listening) return "Model session ready · listening";
  return state.mode === "push-to-talk" ? "Model session ready · Hold to speak" : "Model session ready · microphone off";
}
