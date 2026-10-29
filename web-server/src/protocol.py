from __future__ import annotations

import json
import math
import base64
import binascii
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator, model_validator

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
    speech: dict[str, Any] | None = None


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
    # Gemini Live sets this when the model turn was cut by user activity.
    # Omitted on the wire when false. A generic `final` is not barge-in.
    interrupted: bool = False
    # Echo of the last consumed input.append `t` (Unix ms). Omitted when unknown.
    t: float | None = None
    turn_order: int | None = None
    diagnostic: dict[str, Any] | None = None
    # Opaque sequence pairing native generation-unit text with its audio.
    caption_unit: int | None = None


class InputTypedMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["input.typed"]
    request_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    text: str = Field(min_length=1, max_length=500)

    @field_validator("text")
    @classmethod
    def nonempty(cls, text: str) -> str:
        if not text.strip() or any(0xD800 <= ord(c) <= 0xDFFF for c in text):
            raise ValueError("Invalid text")
        return text


class InputMicrophoneMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["input.microphone"]
    generation: int = Field(ge=0, le=9007199254740991)
    sequence: int = Field(ge=0, le=9007199254740991)
    enabled: bool
    pcm: str | None = Field(default=None, max_length=4268)

    @model_validator(mode="after")
    def valid_pcm(self) -> InputMicrophoneMessage:
        if self.pcm is not None:
            try:
                raw = base64.b64decode(self.pcm, validate=True)
            except (ValueError, binascii.Error):
                raise ValueError("Invalid PCM") from None
            if not self.enabled or not raw or len(raw) % 2 or len(raw) > 3200:
                raise ValueError("Invalid PCM")
        return self


class ErrorMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["error"] = "error"
    session_id: str | None
    fatal: bool
    message: str


InboundMessage = Annotated[
    Union[SessionStartMessage, SessionEndMessage, InputAppendMessage, InputTypedMessage, InputMicrophoneMessage],
    Field(discriminator="type"),
]

_INBOUND_ADAPTER: TypeAdapter[
    SessionStartMessage | SessionEndMessage | InputAppendMessage | InputTypedMessage | InputMicrophoneMessage
] = TypeAdapter(InboundMessage)


def parse_inbound(
    raw: str,
) -> SessionStartMessage | SessionEndMessage | InputAppendMessage | InputTypedMessage | InputMicrophoneMessage:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SessionError("Malformed JSON", fatal=False) from exc
    try:
        return _INBOUND_ADAPTER.validate_python(payload)
    except ValidationError as exc:
        raise SessionError("Invalid message", fatal=False) from exc
