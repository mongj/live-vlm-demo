"""Optional input feedback; distinct from model replies and comprehension."""
from dataclasses import dataclass
from typing import Literal, NotRequired, TypedDict

from .types import Reply


class SpeechCapabilities(TypedDict):
    version: Literal[1]
    transcription: bool
    typed_input: bool
    spoken_interruption: NotRequired[bool]
    reason: NotRequired[str]


InputState = Literal["transcribing", "preparing", "sending", "sent", "waiting", "failed", "cancelled"]


@dataclass(frozen=True)
class InputTranscription:
    utterance_id: str
    generation: int
    turn_order: int
    revision: int
    text: str
    final: bool
    source: Literal["voice"] = "voice"
    type: Literal["input.transcription"] = "input.transcription"


@dataclass(frozen=True)
class InputStatus:
    input_id: str
    source: Literal["voice", "typed"]
    turn_order: int
    state: InputState
    generation: int | None = None
    detail: str | None = None
    type: Literal["input.status"] = "input.status"


AdapterEvent = Reply | InputTranscription | InputStatus
