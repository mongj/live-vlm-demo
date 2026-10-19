from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any, ClassVar, Generic, TypeVar, cast

from pydantic import BaseModel

from ..buffers import AudioBuffer, FrameBuffer
from ..types import ModelSpec, Reply, SessionError
from ..input_events import AdapterEvent, SpeechCapabilities

ConfigT = TypeVar("ConfigT", bound=BaseModel)


class Adapter(ABC, Generic[ConfigT]):
    config_model: ClassVar[type[BaseModel]]
    spec: ModelSpec
    config: ConfigT
    max_frames_per_request: int
    audio_seconds_per_request: float
    audio_retention_seconds: float

    def __init__(self, spec: ModelSpec, raw_config: dict[str, Any]) -> None:
        self.spec = spec
        self.config = cast(ConfigT, self.config_model.model_validate(raw_config))

    def speech_capabilities(self) -> SpeechCapabilities | None:
        return None

    def offer_typed(self, text: str, request_id: str) -> None:
        raise SessionError("Typed speech is unavailable", fatal=False)

    def offer_microphone(self, pcm: bytes, *, generation: int, sequence: int, enabled: bool) -> None:
        raise SessionError("Input transcription is unavailable", fatal=False)

    async def read_events(self) -> AsyncIterator[AdapterEvent]:
        async for reply in self.read_replies():
            yield reply

    @abstractmethod
    async def open(self) -> str: ...

    @abstractmethod
    def offer_text(self, text: str) -> None: ...

    @abstractmethod
    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool: ...

    @abstractmethod
    def read_replies(self) -> AsyncIterator[Reply]: ...

    @abstractmethod
    async def close(self) -> None: ...
