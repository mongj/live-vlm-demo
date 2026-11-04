"""Wizard of Oz: a human operator types every reply. No model runs and no reply is invented."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict, Field

from .base import Adapter
from ..buffers import AudioBuffer, FrameBuffer
from ..input_events import AdapterEvent, InputStatus, SpeechCapabilities
from ..types import ModelSpec, Reply, SessionError, make_session_id

REPLY_QUEUE_SIZE = 64
MAX_FRAMES = 4
AUDIO_SLICE_SECONDS = 0.2
AUDIO_RETENTION_SECONDS = 1.0
OPERATOR_RAW_PREFIX = "[operator] "
PREPARING_FRACTION = 0.2


class WizardConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    typed_delivery_s: float = Field(
        default=1.0,
        ge=0,
        le=30,
        title="Typed delivery (seconds)",
        description="Simulated time to send a typed request. A library video waits this long in Procedure Mode.",
    )


class WizardAdapter(Adapter[WizardConfig]):
    config_model: ClassVar[type[BaseModel]] = WizardConfig

    def __init__(self, spec: ModelSpec, raw_config: dict[str, Any]) -> None:
        super().__init__(spec, raw_config)
        self.max_frames_per_request = MAX_FRAMES
        self.audio_seconds_per_request = AUDIO_SLICE_SECONDS
        self.audio_retention_seconds = AUDIO_RETENTION_SECONDS
        self.session_id = ""
        self._replies: asyncio.Queue[AdapterEvent] = asyncio.Queue(maxsize=REPLY_QUEUE_SIZE)
        self._typed_task: asyncio.Task[None] | None = None
        self._order = 0
        self._last_t: float | None = None

    async def open(self) -> str:
        self.session_id = make_session_id(self.spec.id)
        return self.session_id

    def speech_capabilities(self) -> SpeechCapabilities:
        return {"version": 1, "transcription": False, "typed_input": True}

    def offer_text(self, text: str) -> None:
        # The operator reads typed input in the transcript. Nothing answers it here.
        return

    def offer_operator(self, text: str) -> None:
        stripped = text.strip()
        if not stripped:
            return
        self._order += 1
        try:
            self._replies.put_nowait(Reply(text=stripped, raw=f"{OPERATOR_RAW_PREFIX}{stripped}", final=True,
                                           t=self._last_t, turn_order=self._order))
        except asyncio.QueueFull as exc:
            raise SessionError("Operator reply was not sent. Try again.", fatal=False) from exc

    def offer_typed(self, text: str, request_id: str) -> None:
        if self._typed_task is not None and not self._typed_task.done():
            raise SessionError("A typed instruction is already being sent", fatal=False)
        self._order += 1
        self._typed_task = asyncio.create_task(self._deliver_typed(request_id, self._order))

    async def _deliver_typed(self, request_id: str, order: int) -> None:
        delay = self.config.typed_delivery_s
        await self._replies.put(InputStatus(request_id, "typed", order, "preparing"))
        await asyncio.sleep(delay * PREPARING_FRACTION)
        await self._replies.put(InputStatus(request_id, "typed", order, "sending"))
        await asyncio.sleep(delay * (1 - PREPARING_FRACTION))
        await self._replies.put(InputStatus(request_id, "typed", order, "sent"))
        await self._replies.put(InputStatus(request_id, "typed", order, "waiting"))

    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool:
        batch = frames.consume()
        pcm_slice = audio.consume()
        if not batch and pcm_slice is None:
            return False
        if batch:
            self._last_t = batch[-1].t
        return True

    async def read_events(self) -> AsyncIterator[AdapterEvent]:
        while True:
            yield await self._replies.get()

    async def read_replies(self) -> AsyncIterator[Reply]:
        while True:
            item = await self._replies.get()
            if isinstance(item, Reply):
                yield item

    async def close(self) -> None:
        task, self._typed_task = self._typed_task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
