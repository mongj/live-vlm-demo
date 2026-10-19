from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import math
import os
import time
from pathlib import Path
import struct
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any, ClassVar
from urllib.parse import parse_qs, urlparse

from pydantic import BaseModel, ConfigDict, Field
from websockets.asyncio.client import ClientConnection, connect

from .base import Adapter
from .minicpm_inputs import TypedAudioQueue, MicrophoneSegmenter
from .minicpm_diagnostics import MiniCPMDiagnostics
from ..speech_client import SpeechClient, SpeechUnavailable
from ..input_events import AdapterEvent, SpeechCapabilities, InputStatus, InputTranscription
from ..buffers import AudioBuffer, FrameBuffer
from ..types import ModelSpec, Reply, SessionError, VideoFrame, make_session_id

INPUT_SAMPLES = 16_000
INPUT_BYTES = INPUT_SAMPLES * 2
JITTER_BUFFER_BYTES = INPUT_BYTES * 2
SEND_INTERVAL_SECONDS = 1.0
REPLY_QUEUE_SIZE = 64
logger = logging.getLogger(__name__)


class MiniCPMConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    system_prompt: str = Field(
        default="",
        title="System prompt",
        description="Optional instruction sent once when the live-video session starts.",
    )
    startup_timeout_s: float = Field(
        default=8.0,
        ge=0.1,
        le=9.0,
        title="Startup timeout (seconds)",
        description="Maximum wait for queue admission and session creation; bounded by the gateway's 10-second startup window.",
    )


def validate_video_url(url: str | None) -> str:
    if not url:
        raise SessionError("MiniCPM WebSocket URL is missing", fatal=True)
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query, strict_parsing=True)
        _ = parsed.port
    except ValueError as exc:
        raise SessionError("MiniCPM WebSocket URL is malformed", fatal=True) from exc
    if (
        parsed.scheme not in {"ws", "wss"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/v1/realtime"
        or query != {"mode": ["video"]}
        or parsed.fragment
    ):
        raise SessionError("MiniCPM WebSocket URL must end in /v1/realtime?mode=video", fatal=True)
    return url


def s16le_to_f32le(pcm: bytes) -> bytes:
    if len(pcm) % 2:
        raise SessionError("MiniCPM input PCM must contain an even number of bytes", fatal=False)
    return b"".join(struct.pack("<f", sample[0] / 32768.0) for sample in struct.iter_unpack("<h", pcm))


def f32le_to_s16le(pcm: bytes) -> bytes:
    if len(pcm) % 4:
        raise SessionError("MiniCPM output audio is not float32 PCM", fatal=True)
    result = bytearray()
    for (sample,) in struct.iter_unpack("<f", pcm):
        if not math.isfinite(sample):
            raise SessionError("MiniCPM output audio has a non-finite sample", fatal=True)
        quantized = max(-32768, min(32767, round(sample * 32768)))
        result.extend(struct.pack("<h", quantized))
    return bytes(result)


def _event(raw: str | bytes) -> dict[str, Any]:
    if not isinstance(raw, str):
        raise SessionError("MiniCPM sent a binary event", fatal=True)
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise SessionError("MiniCPM sent malformed JSON", fatal=True) from exc
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise SessionError("MiniCPM sent a malformed event", fatal=True)
    return value


def _failure(event: dict[str, Any]) -> SessionError:
    if event["type"] == "session.closed":
        reason = event.get("reason")
        if reason == "timeout":
            return SessionError("MiniCPM 300-second live-video session limit reached (timeout)", fatal=True)
        diagnostic = event.get("diagnostic")
        detail = diagnostic.get("message") if isinstance(diagnostic, dict) else None
        summary = reason if isinstance(reason, str) and reason else "unknown reason"
        if isinstance(detail, str) and detail:
            summary += f": {detail[:200]}"
        return SessionError(f"MiniCPM session closed: {summary}", fatal=True)
    error = event.get("error")
    detail = error.get("message") if isinstance(error, dict) else event.get("message")
    return SessionError(f"MiniCPM error: {detail or 'unknown error'}", fatal=True)


class MiniCPMAdapter(Adapter[MiniCPMConfig]):
    config_model: ClassVar[type[BaseModel]] = MiniCPMConfig

    def __init__(self, spec: ModelSpec, raw_config: dict[str, Any]) -> None:
        super().__init__(spec, raw_config)
        self._url = validate_video_url(spec.base_url)
        self.max_frames_per_request = 1
        self.audio_seconds_per_request = 0.1
        self.audio_retention_seconds = 2.0
        self.session_id = ""
        self._ws: ClientConnection | None = None
        self._frame: VideoFrame | None = None
        self._last_t: float | None = None
        self._audio = bytearray()
        self._replies: asyncio.Queue[AdapterEvent | SessionError | None] = asyncio.Queue(maxsize=REPLY_QUEUE_SIZE)
        # Telemetry cannot consume capacity reserved for real model/input events.
        self._diagnostic_replies: asyncio.Queue[Reply] = asyncio.Queue(maxsize=8)
        self._tasks: list[asyncio.Task[None]] = []
        self._closing = False
        self._output_open = False
        self._drop_warned = False
        self._speech: SpeechClient | None = None
        self._speech_caps: SpeechCapabilities = {"version":1, "transcription":False, "typed_input":False,
                                                "reason":"Self-hosted speech is not configured"}
        self._typed = TypedAudioQueue()
        self._typed_finishing = False
        self._tts_task: asyncio.Task[None] | None = None
        self._asr_task: asyncio.Task[None] | None = None
        self._asr_pending: tuple[Any, int, int, int] | None = None
        self._segmenter = MicrophoneSegmenter()
        self._asr_epoch = 0
        self._voice_orders: dict[str, int] = {}
        self._seen_requests: set[str] = set()
        self._turn_order = self._assistant_order = self._typed_order = 0
        self._diagnostics = MiniCPMDiagnostics()

    async def open(self) -> str:
        self.session_id = make_session_id(self.spec.id)
        self._diagnostics = MiniCPMDiagnostics()
        self._diagnostics.emit(self._diagnostic_replies, "startup", stage="connecting", force=True)
        try:
            async with asyncio.timeout(self.config.startup_timeout_s):
                self._ws = await connect(
                    self._url,
                    open_timeout=self.config.startup_timeout_s,
                    close_timeout=1,
                    max_size=64 * 1024 * 1024,
                )
                await self._handshake()
        except TimeoutError as exc:
            self._diagnostics.emit(self._diagnostic_replies, "error", stage="error", force=True)
            await self.close()
            raise SessionError("MiniCPM startup timed out while waiting for queue/session", fatal=True) from exc
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception as exc:
            self._diagnostics.emit(self._diagnostic_replies, "error", stage="error", force=True)
            await self.close()
            if isinstance(exc, SessionError):
                raise
            raise SessionError(f"MiniCPM startup failed: {exc}", fatal=True) from exc
        self._closing = False
        token_path = os.environ.get("MINICPM_SPEECH_TOKEN_FILE")
        if token_path:
            try:
                self._speech = SpeechClient(self._url, Path(token_path))
                capabilities = await self._speech.capabilities()
                if capabilities["typed_input"] or capabilities["transcription"]:
                    await self._speech.open_session(self.session_id)
                    self._speech_caps = capabilities
            except (SpeechUnavailable, TimeoutError):
                self._speech_caps = {"version":1, "transcription":False, "typed_input":False,
                                     "reason":"Self-hosted speech is unavailable"}
        self._diagnostics.speech.update({key: self._speech_caps[key] for key in ("transcription", "typed_input")})
        self._diagnostics.emit(self._diagnostic_replies, "session_ready", stage="connected", force=True)
        self._tasks = [
            asyncio.create_task(self._send_loop(), name="minicpm-send"),
            asyncio.create_task(self._receive_loop(), name="minicpm-receive"),
        ]
        return self.session_id

    async def _handshake(self) -> None:
        ws = self._ws
        if ws is None:
            raise SessionError("MiniCPM WebSocket is not open", fatal=True)
        queued = False
        async for raw in ws:
            event = _event(raw)
            kind = event["type"]
            if kind in {"session.queued", "session.queue_update"}:
                self._diagnostics.emit(self._diagnostic_replies, "admission", stage="queued")
                continue
            if kind == "session.queue_done":
                if queued:
                    raise SessionError("MiniCPM repeated queue admission", fatal=True)
                queued = True
                self._diagnostics.emit(self._diagnostic_replies, "admission", stage="connected", force=True)
                payload: dict[str, Any] = {}
                if self.config.system_prompt.strip():
                    payload["system_prompt"] = self.config.system_prompt.strip()
                await ws.send(json.dumps({"type": "session.init", "payload": payload}))
                continue
            if kind == "session.created" and queued:
                if not isinstance(event.get("session_id"), str) or not event["session_id"]:
                    raise SessionError("MiniCPM session.created lacks session_id", fatal=True)
                return
            if kind in {"error", "session.closed"}:
                raise _failure(event)
            raise SessionError(f"MiniCPM unexpected startup event: {kind}", fatal=True)
        raise SessionError("MiniCPM disconnected during startup", fatal=True)

    def offer_text(self, text: str) -> None:
        if text.strip():
            raise SessionError("MiniCPM typed text is not supported in live-video mode; speak through the microphone", fatal=False)

    def speech_capabilities(self) -> SpeechCapabilities:
        return self._speech_caps

    def _next_order(self) -> int:
        self._turn_order += 1
        return self._turn_order

    def _invalidate_asr(self) -> None:
        self._asr_epoch += 1
        self._asr_pending = None
        self._voice_orders.clear()
        self._segmenter.reset(self._segmenter.generation)

    def offer_typed(self, text: str, request_id: str) -> None:
        if self._closing or self._ws is None or not self._speech or not self._speech_caps["typed_input"]:
            raise SessionError("Self-hosted typed speech is unavailable", fatal=False)
        if not text.strip() or len(text) > 500:
            raise SessionError("Use 1–500 characters for a typed instruction", fatal=False)
        if request_id in self._seen_requests or len(self._seen_requests) >= 128:
            raise SessionError("Typed instruction already submitted; start a new session if needed", fatal=False)
        if self._typed_finishing:
            raise SessionError("A typed instruction is already being sent", fatal=False)
        self._typed.begin(request_id)
        self._seen_requests.add(request_id)
        self._typed_order = self._next_order()
        self._audio.clear()
        self._invalidate_asr()
        self._tts_task = asyncio.create_task(self._prepare_typed(text, request_id, self._typed_order))

    async def _prepare_typed(self, text: str, request_id: str, order: int) -> None:
        started = time.monotonic()
        try:
            await self._replies.put(InputStatus(request_id, "typed", order, "preparing"))
            assert self._speech is not None
            started = time.monotonic()
            pcm = await self._speech.synthesize(self.session_id, request_id, text)
            if not self._closing and self._typed.install(request_id, pcm):
                self._diagnostics.helper("tts", started)
                self._diagnostics.emit(self._diagnostic_replies, "tts_complete", force=True)
                await self._replies.put(InputStatus(request_id, "typed", order, "sending"))
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self._closing and self._typed.request_id == request_id:
                self._diagnostics.helper("tts", started)
                self._diagnostics.emit(self._diagnostic_replies, "tts_failed", force=True)
                self._typed.cancel()
                self._audio.clear()
                await self._replies.put(InputStatus(request_id, "typed", order, "failed",
                    detail="Typed speech unavailable or over 30 seconds; edit and send again"))

    def offer_microphone(self, pcm: bytes, *, generation: int, sequence: int, enabled: bool) -> None:
        if self._closing or not self._speech_caps["transcription"]:
            return
        if generation < self._segmenter.generation:
            return
        if generation > self._segmenter.generation or not enabled:
            self._invalidate_asr()
            self._segmenter.reset(generation)
        if not enabled or self._typed.busy or self._typed_finishing or not pcm:
            return
        for update in self._segmenter.offer(pcm, generation=generation, sequence=sequence):
            if update.revision == 0:
                self._voice_orders[update.utterance_id] = self._next_order()
                continue
            order = self._voice_orders.get(update.utterance_id, self._turn_order)
            if self._asr_pending is not None and self._asr_pending[0].final:
                # Bounded queue: report loss instead of implying a complete transcription.
                if update.final and not self._replies.full():
                    self._replies.put_nowait(InputStatus(update.utterance_id, "voice", order, "failed", generation,
                                                        "Transcription skipped: speech worker is busy"))
                if update.final:
                    self._voice_orders.pop(update.utterance_id, None)
                continue
            self._asr_pending = (update, self._asr_epoch, generation, order)
            if update.final: self._voice_orders.pop(update.utterance_id, None)
            if self._asr_task is None or self._asr_task.done():
                self._asr_task = asyncio.create_task(self._transcribe())

    async def _transcribe(self) -> None:
        while self._asr_pending is not None and not self._closing:
            update, epoch, generation, order = self._asr_pending
            self._asr_pending = None
            started = time.monotonic()
            try:
                if not update.final and self._replies.qsize() >= 48: continue
                await self._replies.put(InputStatus(update.utterance_id, "voice", order, "transcribing", generation))
                assert self._speech is not None
                started = time.monotonic()
                text = await self._speech.transcribe(self.session_id, update.utterance_id, update.revision, update.pcm, update.final)
                if epoch != self._asr_epoch or self._closing: continue
                self._diagnostics.helper("asr", started)
                self._diagnostics.emit(self._diagnostic_replies, "asr_complete")
                await self._replies.put(InputTranscription(update.utterance_id, generation, order, update.revision, text, update.final))
            except asyncio.CancelledError:
                raise
            except Exception:
                if epoch == self._asr_epoch and not self._closing:
                    self._diagnostics.helper("asr", started)
                    self._diagnostics.emit(self._diagnostic_replies, "asr_failed", force=True)
                    await self._replies.put(InputStatus(update.utterance_id, "voice", order, "failed", generation,
                                                        "Transcription unavailable"))

    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool:
        if self._ws is None or self._closing:
            raise SessionError("MiniCPM session is not open", fatal=True)
        batch = frames.consume()
        pcm = audio.consume()
        if batch:
            self._frame = batch[-1]
            self._last_t = batch[-1].t
        if pcm and not self._typed.busy and not self._typed_finishing:
            self._audio.extend(pcm)
            if len(self._audio) > JITTER_BUFFER_BYTES:
                dropped_bytes = len(self._audio) - JITTER_BUFFER_BYTES
                del self._audio[:dropped_bytes]
                self._diagnostics.dropped(dropped_bytes)
                self._diagnostics.emit(self._diagnostic_replies, "input_drop")
                # Two seconds absorbs ordinary boundary jitter. Beyond that,
                # preserve live speech by dropping oldest samples rather than
                # letting latency grow without bound.
                if not self._drop_warned:
                    logger.warning(
                        "MiniCPM input overloaded; dropping oldest audio (%d ms)",
                        dropped_bytes * 1000 // INPUT_BYTES,
                    )
                    self._drop_warned = True
        return bool(batch or pcm)

    async def _send_loop(self) -> None:
        try:
            loop = asyncio.get_running_loop()
            next_deadline = loop.time() + SEND_INTERVAL_SECONDS
            while True:
                await asyncio.sleep(max(0.0, next_deadline - loop.time()))
                ws = self._ws
                if ws is None or self._closing:
                    return
                typed_id = self._typed.request_id
                typed_order = self._typed_order
                force_listen = self._typed.busy
                final_typed_packet = False
                if force_listen:
                    genuine_bytes = min(INPUT_BYTES, len(self._typed.pcm) - self._typed.offset) if self._typed.ready else 0
                    packet = self._typed.next_packet()
                    pcm = packet or b""
                    final_typed_packet = packet is not None and not self._typed.busy
                    self._typed_finishing = final_typed_packet
                    self._audio.clear()
                else:
                    pcm = bytes(self._audio[:INPUT_BYTES])
                    del self._audio[:len(pcm)]
                    genuine_bytes = len(pcm)
                self._drop_warned = False
                pcm += bytes(INPUT_BYTES - len(pcm))
                frame = self._frame
                self._frame = None
                body: dict[str, Any] = {"audio": base64.b64encode(s16le_to_f32le(pcm)).decode("ascii"), "max_slice_nums": 1}
                if force_listen:
                    body["force_listen"] = True
                if frame is not None:
                    body["video_frames"] = [base64.b64encode(frame.jpeg).decode("ascii")]
                await ws.send(json.dumps({"type": "input.append", "input": body}))
                self._diagnostics.sent(audio_bytes=genuine_bytes, frames=int(frame is not None))
                self._diagnostics.emit(self._diagnostic_replies, "input_sent")
                if final_typed_packet and typed_id is not None and not self._closing:
                    self._audio.clear()
                    self._invalidate_asr()
                    await self._replies.put(InputStatus(typed_id, "typed", typed_order, "sent"))
                    await self._replies.put(InputStatus(typed_id, "typed", typed_order, "waiting"))
                    self._typed_finishing = False
                next_deadline += SEND_INTERVAL_SECONDS
                if next_deadline <= loop.time():
                    # A slow upstream send missed the next slot. Resume one
                    # interval from now instead of firing a catch-up burst.
                    next_deadline = loop.time() + SEND_INTERVAL_SECONDS
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._diagnostics.emit(self._diagnostic_replies, "error", stage="error", force=True)
            await self._replies.put(SessionError(f"MiniCPM send failed: {exc}", fatal=True))

    async def _receive_loop(self) -> None:
        try:
            ws = self._ws
            if ws is None:
                raise SessionError("MiniCPM WebSocket is not open", fatal=True)
            async for raw in ws:
                event = _event(raw)
                kind = event["type"]
                if kind == "response.output.delta":
                    reply = self._delta_reply(event)
                    if reply is not None:
                        await self._replies.put(reply)
                elif kind in {"error", "session.closed"}:
                    self._diagnostics.emit(self._diagnostic_replies, "closed" if kind == "session.closed" else "error",
                                           stage="closed" if kind == "session.closed" else "error", force=True)
                    raise _failure(event)
                elif kind in {"response.done", "session.queue_update"}:
                    continue
                else:
                    raise SessionError(f"MiniCPM unexpected event: {kind}", fatal=True)
            if not self._closing:
                raise SessionError("MiniCPM connection closed unexpectedly", fatal=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self._diagnostics.stage not in {"error", "closed"}:
                self._diagnostics.emit(self._diagnostic_replies, "error", stage="error", force=True)
            if isinstance(exc, SessionError):
                await self._replies.put(exc)
            else:
                await self._replies.put(SessionError(f"MiniCPM receive failed: {exc}", fatal=True))
        finally:
            if not self._closing:
                await self._replies.put(None)

    def _delta_reply(self, event: dict[str, Any]) -> Reply | None:
        kind = event.get("kind")
        if kind == "listen":
            self._diagnostics.output(kind, event)
            self._diagnostics.emit(self._diagnostic_replies, "model_output")
            if not self._output_open:
                return None
            self._output_open = False
            return Reply(final=True, t=self._last_t, turn_order=self._assistant_order)
        if kind == "text":
            text = event.get("text")
            if not isinstance(text, str):
                raise SessionError("MiniCPM text delta is malformed", fatal=True)
            if not text:
                return None
            self._diagnostics.output(kind, event)
            self._diagnostics.emit(self._diagnostic_replies, "model_output")
            if not self._output_open: self._assistant_order = self._next_order()
            self._output_open = True
            return Reply(text=text, raw=text, t=self._last_t, turn_order=self._assistant_order)
        if kind == "audio":
            encoded = event.get("audio")
            if not isinstance(encoded, str):
                raise SessionError("MiniCPM audio delta is malformed", fatal=True)
            try:
                f32 = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise SessionError("MiniCPM audio delta has invalid base64", fatal=True) from exc
            pcm = f32le_to_s16le(f32)
            if not pcm:
                return None
            self._diagnostics.output(kind, event, audio_bytes=len(pcm))
            self._diagnostics.emit(self._diagnostic_replies, "model_output")
            if not self._output_open: self._assistant_order = self._next_order()
            self._output_open = True
            return Reply(audio=pcm, t=self._last_t, turn_order=self._assistant_order)
        raise SessionError(f"MiniCPM unknown output delta kind: {kind}", fatal=True)

    async def read_replies(self) -> AsyncIterator[Reply]:
        async with aclosing(self.read_events()) as events:
            async for item in events:
                if isinstance(item, Reply) and item.diagnostic is None: yield item

    async def read_events(self) -> AsyncIterator[AdapterEvent]:
        actual = asyncio.create_task(self._replies.get())
        diagnostic = asyncio.create_task(self._diagnostic_replies.get())
        try:
            while True:
                await asyncio.wait((actual, diagnostic), return_when=asyncio.FIRST_COMPLETED)
                if actual.done():
                    item = actual.result()
                    if item is None or isinstance(item, SessionError):
                        # Best effort queued summaries precede a terminal error;
                        # never wait for telemetry that has not already arrived.
                        if diagnostic.done(): yield diagnostic.result()
                        while not self._diagnostic_replies.empty():
                            yield self._diagnostic_replies.get_nowait()
                        if isinstance(item, SessionError): raise item
                        return
                    yield item
                    actual = asyncio.create_task(self._replies.get())
                elif diagnostic.done():
                    yield diagnostic.result()
                    diagnostic = asyncio.create_task(self._diagnostic_replies.get())
        finally:
            actual.cancel()
            diagnostic.cancel()
            await asyncio.gather(actual, diagnostic, return_exceptions=True)

    async def close(self) -> None:
        if not self._closing and self._diagnostics.stage not in {"error", "closed"}:
            self._diagnostics.emit(self._diagnostic_replies, "closed", stage="closed", force=True)
        self._closing = True
        self._typed.cancel()
        self._typed_finishing = False
        self._invalidate_asr()
        self._frame = None
        self._audio.clear()
        tasks, self._tasks = self._tasks, []
        extra, self._tts_task, self._asr_task = [self._tts_task, self._asr_task], None, None
        for task in tasks + extra:
            if task is not None: task.cancel()
        await asyncio.gather(*(task for task in tasks + extra if task is not None), return_exceptions=True)
        if self._speech:
            try: await self._speech.cancel_session(self.session_id)
            except Exception: pass
            await self._speech.close()
            self._speech = None
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                await asyncio.wait_for(ws.send(json.dumps({"type": "session.close", "reason": "user_stop"})), timeout=1)
            except Exception:
                pass
            try:
                await asyncio.wait_for(ws.close(), timeout=2)
            except Exception:
                pass
        self._frame = None
        self._audio.clear()
