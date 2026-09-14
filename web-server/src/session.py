from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from pydantic import BaseModel, ValidationError
from starlette.websockets import WebSocketDisconnect

from .adapters.base import Adapter
from .buffers import AudioBuffer, FrameBuffer
from .channel import ClientChannel, ClientSocket
from .codecs import decode_jpeg_b64, decode_pcm_b64
from .protocol import InputAppendMessage, SessionStartMessage, parse_inbound
from .types import ModelSpec, SessionError, VideoFrame

logger = logging.getLogger(__name__)

OPEN_TIMEOUT_SECONDS = 10.0
NORMAL_CLOSE_CODE = 1000
ERROR_CLOSE_CODE = 1011


class ClientDisconnected(Exception):
    pass


class SessionCatalog(Protocol):
    def get(self, model_id: str) -> ModelSpec | None: ...

    def config_model(self, adapter_key: str) -> type[BaseModel]: ...

    def build_adapter(
        self, spec: ModelSpec, raw_config: dict[str, Any]
    ) -> Adapter[Any]: ...


@dataclass
class Session:
    session_id: str
    model_id: str
    adapter: Adapter[Any]
    frames: FrameBuffer
    audio: AudioBuffer
    feed_ready: asyncio.Event
    started_at: float

    def ingest(self, feed: InputAppendMessage) -> None:
        if feed.frame is not None and self.adapter.max_frames_per_request > 0:
            jpeg = decode_jpeg_b64(feed.frame)
            timestamp = (
                feed.t if feed.t is not None else time.monotonic() - self.started_at
            )
            self.frames.push(VideoFrame(jpeg=jpeg, t=timestamp))
            self.feed_ready.set()
        if feed.audio is not None and self.adapter.audio_seconds_per_request > 0:
            pcm = decode_pcm_b64(feed.audio)
            self.audio.push(pcm)
            self.feed_ready.set()
        if feed.text is not None:
            self.adapter.offer_text(feed.text)


async def run_session(websocket: ClientSocket, catalog: SessionCatalog) -> None:
    await websocket.accept()
    channel = ClientChannel(websocket)
    adapter: Adapter[Any] | None = None
    session: Session | None = None
    tasks: list[asyncio.Task[None]] = []
    terminal: SessionError | None = None
    close_code = NORMAL_CLOSE_CODE
    cancelled = False
    try:
        try:
            start = await _read_start(websocket, channel)
            spec = catalog.get(start.model)
            if spec is None:
                raise SessionError(f"Unknown model: {start.model}", fatal=True)
            try:
                config = catalog.config_model(spec.adapter).model_validate(start.config)
            except ValidationError as exc:
                raise SessionError("Invalid Config", fatal=True) from exc
            adapter = catalog.build_adapter(spec, start.config)
            try:
                session_id = await asyncio.wait_for(
                    adapter.open(), timeout=OPEN_TIMEOUT_SECONDS
                )
            except TimeoutError as exc:
                raise SessionError("Session startup timed out", fatal=True) from exc
            except SessionError:
                raise
            except Exception as exc:
                raise SessionError(f"Session open failed: {exc}", fatal=True) from exc
            session = Session(
                session_id=session_id,
                model_id=spec.id,
                adapter=adapter,
                frames=FrameBuffer(adapter.max_frames_per_request),
                audio=AudioBuffer(
                    adapter.audio_seconds_per_request,
                    adapter.audio_retention_seconds,
                ),
                feed_ready=asyncio.Event(),
                started_at=time.monotonic(),
            )
            channel.adopt_session_id(session_id)
            await channel.send_started(spec.id, config.model_dump())
            tasks = [
                asyncio.create_task(_receiver(websocket, session, channel), name="receiver"),
                asyncio.create_task(_feeder(session, channel), name="feeder"),
                asyncio.create_task(_forwarder(session, channel), name="forwarder"),
            ]
            terminal = await _coordinate(tasks)
            if terminal is not None:
                close_code = ERROR_CLOSE_CODE
        except ClientDisconnected:
            close_code = NORMAL_CLOSE_CODE
        except SessionError as exc:
            terminal = exc
            close_code = ERROR_CLOSE_CODE
        except Exception as exc:
            logger.exception("Session failed")
            terminal = SessionError(f"Internal session failure: {exc}", fatal=True)
            close_code = ERROR_CLOSE_CODE
    except asyncio.CancelledError:
        cancelled = True
        close_code = ERROR_CLOSE_CODE
    await _cleanup(tasks, adapter, session, channel, terminal, close_code)
    if cancelled:
        raise asyncio.CancelledError


async def _receive_text(websocket: ClientSocket) -> str | None:
    try:
        message = await websocket.receive()
    except WebSocketDisconnect:
        return None
    if message.get("type") == "websocket.disconnect":
        return None
    text = message.get("text")
    if isinstance(text, str):
        return text
    raise SessionError("Binary messages are unsupported", fatal=False)


async def _read_start(
    websocket: ClientSocket, channel: ClientChannel
) -> SessionStartMessage:
    while True:
        try:
            raw = await _receive_text(websocket)
        except SessionError as exc:
            if exc.fatal:
                raise
            await channel.send_error(exc.message, fatal=False)
            continue
        if raw is None:
            raise ClientDisconnected
        try:
            parsed = parse_inbound(raw)
        except SessionError as exc:
            await channel.send_error(exc.message, fatal=False)
            continue
        if isinstance(parsed, InputAppendMessage):
            await channel.send_error("Feed before Start is ignored", fatal=False)
            continue
        return parsed


async def _receiver(
    websocket: ClientSocket, session: Session, channel: ClientChannel
) -> None:
    while True:
        try:
            raw = await _receive_text(websocket)
        except SessionError as exc:
            if exc.fatal:
                raise
            await channel.send_error(exc.message, fatal=False)
            continue
        if raw is None:
            return
        try:
            parsed = parse_inbound(raw)
        except SessionError as exc:
            await channel.send_error(exc.message, fatal=False)
            continue
        if isinstance(parsed, SessionStartMessage):
            await channel.send_error("Session already started", fatal=False)
            continue
        try:
            session.ingest(parsed)
        except SessionError as exc:
            if exc.fatal:
                raise
            await channel.send_error(exc.message, fatal=False)


async def _feeder(session: Session, channel: ClientChannel) -> None:
    while True:
        await session.feed_ready.wait()
        session.feed_ready.clear()
        while True:
            try:
                progressed = await session.adapter.send_feed(session.frames, session.audio)
            except SessionError as exc:
                if exc.fatal:
                    raise
                await channel.send_error(exc.message, fatal=False)
                continue
            if not progressed:
                break


async def _forwarder(session: Session, channel: ClientChannel) -> None:
    async for reply in session.adapter.read_replies():
        await channel.send_reply(reply)
    raise SessionError("Model reply stream ended", fatal=True)


async def _coordinate(tasks: Sequence[asyncio.Task[None]]) -> SessionError | None:
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    terminal = _inspect_tasks(done)
    for task in pending:
        task.cancel()
    if pending:
        gathered = await asyncio.gather(*pending, return_exceptions=True)
        for task, outcome in zip(pending, gathered, strict=True):
            terminal = _retain(terminal, _inspect_outcome(task.get_name(), outcome))
    return terminal


def _inspect_tasks(tasks: set[asyncio.Task[None]]) -> SessionError | None:
    terminal: SessionError | None = None
    for task in tasks:
        if task.cancelled():
            continue
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            continue
        if exc is None:
            terminal = _retain(terminal, _normal_completion(task.get_name()))
        else:
            terminal = _retain(terminal, _inspect_outcome(task.get_name(), exc))
    return terminal


def _normal_completion(name: str) -> SessionError | None:
    if name == "receiver":
        return None
    return SessionError(f"{name} ended unexpectedly", fatal=True)


def _inspect_outcome(name: str, outcome: object) -> SessionError | None:
    if outcome is None or isinstance(outcome, asyncio.CancelledError):
        return None
    if isinstance(outcome, SessionError):
        return outcome
    if isinstance(outcome, BaseException):
        logger.error("%s failed: %s", name, outcome, exc_info=outcome)
        return SessionError(f"{name} failed: {outcome}", fatal=True)
    return None


def _retain(current: SessionError | None, new: SessionError | None) -> SessionError | None:
    return current if current is not None else new


async def _cleanup(
    tasks: Sequence[asyncio.Task[None]],
    adapter: Adapter[Any] | None,
    session: Session | None,
    channel: ClientChannel,
    terminal: SessionError | None,
    close_code: int,
) -> None:
    for task in tasks:
        task.cancel()
    if tasks:
        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
        for task, outcome in zip(tasks, outcomes, strict=True):
            unexpected = _inspect_outcome(task.get_name(), outcome)
            if unexpected is not None and (
                terminal is None or unexpected.message != terminal.message
            ):
                logger.error("Cleanup saw %s: %s", task.get_name(), unexpected.message)
    close_cancelled = False
    if adapter is not None:
        try:
            await adapter.close()
        except asyncio.CancelledError:
            close_cancelled = True
        except Exception:
            logger.exception("Adapter close failed")
    try:
        if terminal is not None:
            await channel.send_terminal_error(terminal.message)
    except Exception:
        logger.exception("Failed to deliver terminal error")
    finally:
        try:
            await channel.close_socket(close_code)
        except Exception:
            logger.exception("WebSocket close failed")
        if session is not None:
            session.frames.clear()
            session.audio.clear()
    if close_cancelled:
        raise asyncio.CancelledError
