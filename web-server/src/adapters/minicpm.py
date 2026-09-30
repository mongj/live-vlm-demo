from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import math
import struct
from collections.abc import AsyncIterator
from typing import Any, ClassVar
from urllib.parse import parse_qs, urlparse

from pydantic import BaseModel, ConfigDict, Field
from websockets.asyncio.client import ClientConnection, connect

from .base import Adapter
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
        self._replies: asyncio.Queue[Reply | SessionError | None] = asyncio.Queue(maxsize=REPLY_QUEUE_SIZE)
        self._tasks: list[asyncio.Task[None]] = []
        self._closing = False
        self._output_open = False
        self._drop_warned = False

    async def open(self) -> str:
        self.session_id = make_session_id(self.spec.id)
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
            await self.close()
            raise SessionError("MiniCPM startup timed out while waiting for queue/session", fatal=True) from exc
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception as exc:
            await self.close()
            if isinstance(exc, SessionError):
                raise
            raise SessionError(f"MiniCPM startup failed: {exc}", fatal=True) from exc
        self._closing = False
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
                continue
            if kind == "session.queue_done":
                if queued:
                    raise SessionError("MiniCPM repeated queue admission", fatal=True)
                queued = True
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

    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool:
        if self._ws is None or self._closing:
            raise SessionError("MiniCPM session is not open", fatal=True)
        batch = frames.consume()
        pcm = audio.consume()
        if batch:
            self._frame = batch[-1]
            self._last_t = batch[-1].t
        if pcm:
            self._audio.extend(pcm)
            if len(self._audio) > JITTER_BUFFER_BYTES:
                dropped_bytes = len(self._audio) - JITTER_BUFFER_BYTES
                del self._audio[:dropped_bytes]
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
                if ws is None:
                    return
                pcm = bytes(self._audio[:INPUT_BYTES])
                del self._audio[:len(pcm)]
                self._drop_warned = False
                pcm += bytes(INPUT_BYTES - len(pcm))
                frame = self._frame
                self._frame = None
                body: dict[str, Any] = {"audio": base64.b64encode(s16le_to_f32le(pcm)).decode("ascii"), "max_slice_nums": 1}
                if frame is not None:
                    body["video_frames"] = [base64.b64encode(frame.jpeg).decode("ascii")]
                await ws.send(json.dumps({"type": "input.append", "input": body}))
                next_deadline += SEND_INTERVAL_SECONDS
                if next_deadline <= loop.time():
                    # A slow upstream send missed the next slot. Resume one
                    # interval from now instead of firing a catch-up burst.
                    next_deadline = loop.time() + SEND_INTERVAL_SECONDS
        except asyncio.CancelledError:
            raise
        except Exception as exc:
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
            if not self._output_open:
                return None
            self._output_open = False
            return Reply(final=True, t=self._last_t)
        if kind == "text":
            text = event.get("text")
            if not isinstance(text, str):
                raise SessionError("MiniCPM text delta is malformed", fatal=True)
            if not text:
                return None
            self._output_open = True
            return Reply(text=text, raw=text, t=self._last_t)
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
            self._output_open = True
            return Reply(audio=pcm, t=self._last_t)
        raise SessionError(f"MiniCPM unknown output delta kind: {kind}", fatal=True)

    async def read_replies(self) -> AsyncIterator[Reply]:
        while True:
            item = await self._replies.get()
            if item is None:
                return
            if isinstance(item, SessionError):
                raise item
            yield item

    async def close(self) -> None:
        self._closing = True
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
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
