export type SessionStartMessage = {
  type: "session.start";
  model: string;
  config: Record<string, unknown>;
};

export type InputAppendMessage = {
  type: "input.append";
  frame?: string | null;
  audio?: string | null;
  text?: string | null;
  /** Absolute Unix time in milliseconds (`Date.now()`). */
  t?: number | null;
};

export type ClientMessage = SessionStartMessage | InputAppendMessage;

export type SessionStartedMessage = {
  type: "session.started";
  session_id: string;
  model: string;
  config: Record<string, unknown>;
};

export type ResponseChunkMessage = {
  type: "response.chunk";
  session_id: string;
  text: string;
  audio?: string | null;
  raw?: string;
  final: boolean;
  /** Echo of the last consumed `input.append` `t` (Unix ms), when known. */
  t?: number;
};

export type ErrorMessage = {
  type: "error";
  session_id: string | null;
  fatal: boolean;
  message: string;
};

export type ServerMessage = SessionStartedMessage | ResponseChunkMessage | ErrorMessage;

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
      };
    }
    case "response.chunk": {
      const sessionId = asString(value.session_id);
      const text = asString(value.text);
      const final = asBoolean(value.final);
      if (!sessionId || text === null || final === null) {
        return null;
      }
      return {
        type: "response.chunk",
        session_id: sessionId,
        text,
        audio: asString(value.audio),
        raw: asString(value.raw) ?? undefined,
        final,
        t: asUnixMs(value.t),
      };
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
