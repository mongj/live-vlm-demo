from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict, Field

from .base import Adapter
from ..buffers import AudioBuffer, FrameBuffer
from ..types import ModelSpec, Reply, make_session_id

REPLY_QUEUE_SIZE = 64
MOCK_MAX_FRAMES = 4
MOCK_AUDIO_SLICE_SECONDS = 0.2
MOCK_AUDIO_RETENTION_SECONDS = 1.0
OUTBOUND_SAMPLE_RATE_HZ = 24_000
SILENT_CHUNK_SECONDS = 0.1
SILENT_PCM_CHUNK = bytes(int(OUTBOUND_SAMPLE_RATE_HZ * SILENT_CHUNK_SECONDS) * 2)
SILENCE_RAW = "</silence>"
RESPONSE_RAW_PREFIX = "</response> "
MOCK_RESPONSE_TEXT = "This is a mock response"


class MockConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    latency_ms: int = Field(default=150, ge=0, le=5000)


def mock_turn_payload(query: str) -> tuple[str, str]:
    # Same presentable/raw split the client uses for JoyAI: tagged raw, display text.
    if not query:
        return "", SILENCE_RAW
    return MOCK_RESPONSE_TEXT, f"{RESPONSE_RAW_PREFIX}{MOCK_RESPONSE_TEXT}"


class MockAdapter(Adapter[MockConfig]):
    config_model: ClassVar[type[BaseModel]] = MockConfig

    def __init__(self, spec: ModelSpec, raw_config: dict[str, Any]) -> None:
        super().__init__(spec, raw_config)
        self.max_frames_per_request = MOCK_MAX_FRAMES
        self.audio_seconds_per_request = MOCK_AUDIO_SLICE_SECONDS
        self.audio_retention_seconds = MOCK_AUDIO_RETENTION_SECONDS
        self.session_id = ""
        self._standing = ""
        self._query = ""
        self._replies: asyncio.Queue[Reply] = asyncio.Queue(maxsize=REPLY_QUEUE_SIZE)

    async def open(self) -> str:
        self.session_id = make_session_id(self.spec.id)
        return self.session_id

    def offer_text(self, text: str) -> None:
        stripped = text.strip()
        if not stripped:
            return
        # Match JoyAI: chat lines accumulate as a standing query, then the
        # next send_feed consumes that blob once (later frames stay silent).
        if self._standing:
            self._standing = f"{self._standing}\n{stripped}"
        else:
            self._standing = stripped
        self._query = self._standing

    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool:
        batch = frames.consume()
        pcm_slice = audio.consume()
        if not batch and pcm_slice is None:
            return False
        query = self._query
        self._query = ""
        turn_t = batch[-1].t if batch else None
        await asyncio.sleep(self.config.latency_ms / 1000)
        text, raw = mock_turn_payload(query)
        await self._replies.put(
            Reply(text=text, audio=SILENT_PCM_CHUNK, raw=raw, final=True, t=turn_t)
        )
        return True

    async def read_replies(self) -> AsyncIterator[Reply]:
        while True:
            yield await self._replies.get()

    async def close(self) -> None:
        self._standing = ""
        self._query = ""
