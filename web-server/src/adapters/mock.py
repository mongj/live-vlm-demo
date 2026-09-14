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


class MockConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    latency_ms: int = Field(default=150, ge=0, le=5000)


def mock_turn_chunks(frame_count: int, audio_bytes: int, query: str) -> tuple[str, str]:
    sentence = f"Mock turn: frames={frame_count} audio_bytes={audio_bytes} text={query!r}"
    mid = max(1, len(sentence) // 2)
    return sentence[:mid], sentence[mid:]


class MockAdapter(Adapter[MockConfig]):
    config_model: ClassVar[type[BaseModel]] = MockConfig

    def __init__(self, spec: ModelSpec, raw_config: dict[str, Any]) -> None:
        super().__init__(spec, raw_config)
        self.max_frames_per_request = MOCK_MAX_FRAMES
        self.audio_seconds_per_request = MOCK_AUDIO_SLICE_SECONDS
        self.audio_retention_seconds = MOCK_AUDIO_RETENTION_SECONDS
        self.session_id = ""
        self._query = ""
        self._replies: asyncio.Queue[Reply] = asyncio.Queue(maxsize=REPLY_QUEUE_SIZE)

    async def open(self) -> str:
        self.session_id = make_session_id(self.spec.id)
        return self.session_id

    def offer_text(self, text: str) -> None:
        stripped = text.strip()
        if stripped:
            self._query = stripped

    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool:
        batch = frames.consume()
        pcm_slice = audio.consume()
        if not batch and pcm_slice is None:
            return False
        query = self._query
        frame_count = len(batch)
        audio_bytes = len(pcm_slice) if pcm_slice is not None else 0
        await asyncio.sleep(self.config.latency_ms / 1000)
        first, second = mock_turn_chunks(frame_count, audio_bytes, query)
        await self._replies.put(
            Reply(text=first, audio=SILENT_PCM_CHUNK, raw=first, final=False)
        )
        await self._replies.put(
            Reply(text=second, audio=SILENT_PCM_CHUNK, raw=second, final=True)
        )
        return True

    async def read_replies(self) -> AsyncIterator[Reply]:
        while True:
            yield await self._replies.get()

    async def close(self) -> None:
        self._query = ""
