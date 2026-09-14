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
