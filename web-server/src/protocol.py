from __future__ import annotations

import json
import math
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from .types import SessionError


class SessionStartMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["session.start"]
    model: str
    config: dict[str, Any] = Field(default_factory=dict)


class SessionEndMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["session.end"]


class InputAppendMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["input.append"]
    frame: str | None = None
    audio: str | None = None
    text: str | None = None
    # Absolute Unix time in milliseconds when supplied (`Date.now()`).
    t: float | None = None

    @field_validator("t")
    @classmethod
    def t_must_be_finite_and_non_negative(cls, value: float | None) -> float | None:
        if value is not None and (not math.isfinite(value) or value < 0):
            raise ValueError("t must be finite and non-negative")
        return value


class SessionStartedMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["session.started"] = "session.started"
    session_id: str
    model: str
    config: dict[str, Any]


class SessionEndedMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["session.ended"] = "session.ended"
    session_id: str | None


class ResponseChunkMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["response.chunk"] = "response.chunk"
    session_id: str
    text: str
    audio: str | None
    raw: str
    final: bool
    # Echo of the last consumed input.append `t` (Unix ms). Omitted when unknown.
    t: float | None = None


class ErrorMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["error"] = "error"
    session_id: str | None
    fatal: bool
    message: str


InboundMessage = Annotated[
    Union[SessionStartMessage, SessionEndMessage, InputAppendMessage],
    Field(discriminator="type"),
]

_INBOUND_ADAPTER: TypeAdapter[
    SessionStartMessage | SessionEndMessage | InputAppendMessage
] = TypeAdapter(InboundMessage)


def parse_inbound(
    raw: str,
) -> SessionStartMessage | SessionEndMessage | InputAppendMessage:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SessionError("Malformed JSON", fatal=False) from exc
    try:
        return _INBOUND_ADAPTER.validate_python(payload)
    except ValidationError as exc:
        raise SessionError("Invalid message", fatal=False) from exc
