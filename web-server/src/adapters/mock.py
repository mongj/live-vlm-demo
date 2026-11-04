from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field

from .base import Adapter
from .minicpm_diagnostics import MiniCPMDiagnostics
from ..buffers import AudioBuffer, FrameBuffer
from ..input_events import AdapterEvent, InputStatus, SpeechCapabilities
from ..types import ModelSpec, Reply, SessionError, make_session_id

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
# Scripted procedure narration: paced like a live unit, always canned text.
NARRATION_UNIT_SECONDS = 1.0
NARRATION_WORDS_PER_UNIT = 3
NARRATION_PCM_UNIT = bytes(OUTBOUND_SAMPLE_RATE_HZ * 2)
STEP_LINE = re.compile(r"^\s*\d+[.)]\s+(.+?)\s*$", re.MULTILINE)
PREPARING_FRACTION = 0.2


class MockConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    latency_ms: int = Field(default=150, ge=0, le=5000)
    system_prompt: str = Field(
        default="",
        title="System prompt",
        description="Numbered steps in this text make Mock narrate them with canned replies, for testing. Mock does not read the video.",
    )
    response_policy: Literal["current_request", "none"] = Field(
        default="current_request",
        title="Response policy",
        description="Accepted for parity with MiniCPM. Mock ignores it.",
    )
    typed_delivery_s: float = Field(
        default=3.0,
        ge=0,
        le=30,
        title="Typed delivery (seconds)",
        description="Simulated time to prepare and send a typed request.",
    )
    narration_interval_s: float = Field(
        default=10.0,
        ge=2,
        le=120,
        title="Narration interval (seconds)",
        description="Simulated time spent on each listed step.",
    )


def mock_turn_payload(query: str) -> tuple[str, str]:
    # Same presentable/raw split the client uses for JoyAI: tagged raw, display text.
    if not query:
        return "", SILENCE_RAW
    return MOCK_RESPONSE_TEXT, f"{RESPONSE_RAW_PREFIX}{MOCK_RESPONSE_TEXT}"


def mock_unit_compute_ms(unit: int) -> float:
    # A fixed pattern, so Debug shows every state. These are not measurements.
    return 1240.0 if unit % 23 == 22 else 420.0 + 35.0 * (unit % 9)


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
        self._replies: asyncio.Queue[AdapterEvent] = asyncio.Queue(maxsize=REPLY_QUEUE_SIZE)
        self._steps: list[str] = STEP_LINE.findall(self.config.system_prompt)
        self._typed_task: asyncio.Task[None] | None = None
        self._narrator: asyncio.Task[None] | None = None
        self._order = 0
        self._asked: list[str] = []
        self._last_t: float | None = None

    async def open(self) -> str:
        self.session_id = make_session_id(self.spec.id)
        return self.session_id

    def speech_capabilities(self) -> SpeechCapabilities | None:
        if not self._steps:
            return None
        return {"version": 1, "transcription": False, "typed_input": True}

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

    def offer_typed(self, text: str, request_id: str) -> None:
        if not self._steps:
            raise SessionError("Typed speech is unavailable", fatal=False)
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
        if self._narrator is None:
            self._narrator = asyncio.create_task(self._narrate())
        else:
            self._asked.append(request_id)

    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool:
        batch = frames.consume()
        pcm_slice = audio.consume()
        if not batch and pcm_slice is None:
            return False
        if self._steps:
            # Narration owns turn boundaries; a per-frame final would split replies.
            if batch:
                self._last_t = batch[-1].t
            return True
        query = self._query
        self._query = ""
        turn_t = batch[-1].t if batch else None
        await asyncio.sleep(self.config.latency_ms / 1000)
        text, raw = mock_turn_payload(query)
        await self._replies.put(
            Reply(text=text, audio=SILENT_PCM_CHUNK, raw=raw, final=True, t=turn_t)
        )
        return True

    def _narration_line(self, unit: int) -> str | None:
        """Canned text for this unit: each step once, some filler, answers to check-ins."""
        interval = max(1, round(self.config.narration_interval_s / NARRATION_UNIT_SECONDS))
        index = min(len(self._steps) - 1, unit // interval)
        if self._asked:
            self._asked.pop(0)
            following = self._steps[min(len(self._steps) - 1, index + 1)]
            return f"Next, {following[0].lower()}{following[1:]}"
        if unit % interval == 0 and unit // interval < len(self._steps):
            return self._steps[index]
        if unit % interval == interval // 2 and unit // interval < len(self._steps):
            return "Still watching, nothing has changed."
        return None

    async def _narrate(self) -> None:
        diagnostics = MiniCPMDiagnostics()
        diagnostics.speech.update({"typed_input": True})
        words: list[str] = []
        unit = 0
        caption_unit = 0
        order = 0
        while True:
            metrics = {"wall_clock_ms": mock_unit_compute_ms(unit)}
            input_id = diagnostics.register_input(audio_bytes=0, frames=1, force_source="none")
            event: dict[str, Any] = {"input_id": input_id, "metrics": metrics, "chunk_index": unit}
            diagnostics.sent(audio_bytes=0, frames=1, force_listen=False)
            if not words:
                line = self._narration_line(unit)
                if line is not None:
                    words = line.split()
                    self._order += 1
                    order = self._order
            if words:
                part, words = words[:NARRATION_WORDS_PER_UNIT], words[NARRATION_WORDS_PER_UNIT:]
                text = " ".join(part) + (" " if words else "")
                caption_unit += 1
                diagnostics.output("text", event)
                diagnostics.output("audio", event, audio_bytes=len(NARRATION_PCM_UNIT))
                await self._replies.put(Reply(text=text, audio=NARRATION_PCM_UNIT, raw=text, t=self._last_t,
                                              turn_order=order, caption_unit=caption_unit))
                if not words:
                    await self._replies.put(Reply(final=True, t=self._last_t, turn_order=order))
            else:
                diagnostics.output("listen", event)
            await self._replies.put(Reply(diagnostic=diagnostics.snapshot("model_output")))
            unit += 1
            await asyncio.sleep(NARRATION_UNIT_SECONDS)

    async def read_events(self) -> AsyncIterator[AdapterEvent]:
        while True:
            yield await self._replies.get()

    async def read_replies(self) -> AsyncIterator[Reply]:
        while True:
            item = await self._replies.get()
            if isinstance(item, Reply):
                yield item

    async def close(self) -> None:
        self._standing = ""
        self._query = ""
        tasks = [task for task in (self._typed_task, self._narrator) if task is not None]
        self._typed_task = self._narrator = None
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
