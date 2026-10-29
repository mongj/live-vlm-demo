import { parseRuntimeDiagnostic, type RuntimeDiagnostic } from './runtime-diagnostics.mjs';

export type SessionStartMessage = {
  type: "session.start";
  model: string;
  config: Record<string, unknown>;
};

export type SessionEndMessage = {
  type: "session.end";
};

export type InputAppendMessage = {
  type: "input.append";
  frame?: string | null;
  audio?: string | null;
  text?: string | null;
  /** Absolute Unix time in milliseconds (`Date.now()`). */
  t?: number | null;
};

export type InputTypedMessage = {type:"input.typed"; request_id:string; text:string};
export type InputMicrophoneMessage = {type:"input.microphone"; generation:number; sequence:number; enabled:boolean; pcm?:string};
export type SpeechCapabilities = {version:1; transcription:boolean; typed_input:boolean; spoken_interruption?:boolean; reason?:string};
export type InputTranscriptionMessage = {type:"input.transcription"; session_id:string; source:"voice"; utterance_id:string; generation:number; turn_order:number; revision:number; text:string; final:boolean};
export type InputStatusMessage = {type:"input.status"; session_id:string; input_id:string; source:"voice"|"typed"; generation?:number; turn_order:number; state:"transcribing"|"preparing"|"sending"|"sent"|"waiting"|"failed"|"cancelled"; detail?:string};
export type InputFeedbackEvent = InputTranscriptionMessage | InputStatusMessage | {type:"microphone";generation:number} | {type:"assistant";turn_order?:number} | {type:"typed";input_id:string;text:string;transport?:"speech"|"text"};
export type ClientMessage = SessionStartMessage | SessionEndMessage | InputAppendMessage | InputTypedMessage | InputMicrophoneMessage;

export type SessionStartedMessage = {
  type: "session.started";
  session_id: string;
  model: string;
  config: Record<string, unknown>;
  speech?: SpeechCapabilities;
};

export type SessionEndedMessage = {
  type: "session.ended";
  session_id: string | null;
};

export type ResponseChunkMessage = {
  type: "response.chunk";
  session_id: string;
  text: string;
  audio?: string | null;
  raw?: string;
  final: boolean;
  /** Gemini Live barge-in. Absent or false is a normal chunk. */
  interrupted?: boolean;
  /** Echo of the last consumed `input.append` `t` (Unix ms), when known. */
  t?: number;
  turn_order?: number;
  caption_unit?: number;
  diagnostic?: RuntimeDiagnostic;
};

export type ErrorMessage = {
  type: "error";
  session_id: string | null;
  fatal: boolean;
  message: string;
};

export type ServerMessage = SessionStartedMessage | SessionEndedMessage | ResponseChunkMessage | ErrorMessage | InputTranscriptionMessage | InputStatusMessage;

function isCounter(value:unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isId(value:unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asUnixMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "session.started": {
      const sessionId = asString(value.session_id);
      const model = asString(value.model);
      if (!sessionId || !model || !isRecord(value.config)) {
        return null;
      }
      return {
        type: "session.started",
        session_id: sessionId,
        model,
        config: value.config,
        ...(isRecord(value.speech) && value.speech.version === 1 && typeof value.speech.transcription === 'boolean' && typeof value.speech.typed_input === 'boolean'
          ? {speech:{version:1,transcription:value.speech.transcription,typed_input:value.speech.typed_input,
            ...(typeof value.speech.spoken_interruption === 'boolean' ? {spoken_interruption:value.speech.spoken_interruption} : {}),
            ...(typeof value.speech.reason === 'string' ? {reason:value.speech.reason} : {})} as SpeechCapabilities} : {}),
      };
    }
    case "session.ended": {
      const sessionId = value.session_id;
      if (sessionId !== undefined && sessionId !== null && typeof sessionId !== "string") {
        return null;
      }
      return {
        type: "session.ended",
        session_id: typeof sessionId === "string" ? sessionId : null,
      };
    }
    case "response.chunk": {
      const sessionId = asString(value.session_id);
      const text = asString(value.text);
      const final = asBoolean(value.final);
      const interrupted =
        value.interrupted === undefined ? false : asBoolean(value.interrupted);
      if (!sessionId || text === null || final === null || interrupted === null) {
        return null;
      }
      const diagnostic = parseRuntimeDiagnostic(value.diagnostic);
      return {
        type: "response.chunk",
        session_id: sessionId,
        text,
        audio: asString(value.audio),
        raw: asString(value.raw) ?? undefined,
        final,
        interrupted,
        t: asUnixMs(value.t),
        ...(isCounter(value.turn_order) ? {turn_order:value.turn_order} : {}),
        ...(isCounter(value.caption_unit) ? {caption_unit:value.caption_unit} : {}),
        ...(diagnostic ? {diagnostic} : {}),
      };
    }
    case "input.transcription": {
      if (!asString(value.session_id) || value.source !== 'voice' || !isId(value.utterance_id) || !isCounter(value.generation) || !isCounter(value.turn_order) || !isCounter(value.revision) || typeof value.text !== 'string' || value.text.length > 8000 || typeof value.final !== 'boolean') return null;
      return {type:value.type,session_id:value.session_id as string,source:'voice',utterance_id:value.utterance_id,generation:value.generation,turn_order:value.turn_order,revision:value.revision,text:value.text,final:value.final};
    }
    case "input.status": {
      const states = ['transcribing','preparing','sending','sent','waiting','failed','cancelled'];
      if (!asString(value.session_id) || !isId(value.input_id) || !['voice','typed'].includes(String(value.source)) || !isCounter(value.turn_order) || !states.includes(String(value.state)) || (value.source === 'voice' && !isCounter(value.generation))) return null;
      return {type:value.type,session_id:value.session_id as string,input_id:value.input_id,source:value.source as 'voice'|'typed',turn_order:value.turn_order,state:value.state as InputStatusMessage['state'],
        ...(isCounter(value.generation) ? {generation:value.generation} : {}),...(typeof value.detail === 'string' ? {detail:value.detail.slice(0,300)} : {})};
    }
    case "error": {
      const message = asString(value.message);
      const fatal = asBoolean(value.fatal);
      if (message === null || fatal === null) {
        return null;
      }
      const sessionId = value.session_id;
      if (sessionId !== null && typeof sessionId !== "string") {
        return null;
      }
      return {
        type: "error",
        session_id: sessionId,
        fatal,
        message,
      };
    }
    default:
      return null;
  }
}

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

/** Gemini Live input transcripts are forwarded on `response.chunk.raw` as `[input] …`. */
export const INPUT_TRANSCRIPTION_PREFIX = "[input] ";

export function inputTranscriptionFromRaw(raw: string): string {
  const index = raw.indexOf(INPUT_TRANSCRIPTION_PREFIX);
  if (index === -1) {
    return "";
  }
  return raw.slice(index + INPUT_TRANSCRIPTION_PREFIX.length);
}
