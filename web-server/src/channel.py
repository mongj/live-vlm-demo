from __future__ import annotations

import asyncio
import json
from collections.abc import MutableMapping
from typing import Any, Protocol

from .codecs import encode_media_b64
from .protocol import (
    ErrorMessage,
    ResponseChunkMessage,
    SessionEndedMessage,
    SessionStartedMessage,
)
from .types import Reply, SessionError

ORDINARY_WRITE_TIMEOUT_SECONDS = 5.0
TERMINAL_WRITE_TIMEOUT_SECONDS = 2.0
CLOSE_TIMEOUT_SECONDS = 2.0


class ClientSocket(Protocol):
    async def accept(self) -> None: ...

    async def receive(self) -> MutableMapping[str, Any]: ...

    async def send_text(self, data: str) -> None: ...

    async def close(self, code: int = 1000) -> None: ...


class ClientChannel:
    def __init__(self, websocket: ClientSocket) -> None:
        self._websocket = websocket
        self._lock = asyncio.Lock()
        self.session_id: str | None = None

    def adopt_session_id(self, session_id: str) -> None:
        self.session_id = session_id

    async def send_started(self, model: str, config: dict[str, Any]) -> None:
        if self.session_id is None:
            raise SessionError("Session ID missing before acknowledgement", fatal=True)
        message = SessionStartedMessage(
            session_id=self.session_id,
            model=model,
            config=config,
        )
        await self._send(message.model_dump(), ORDINARY_WRITE_TIMEOUT_SECONDS)

    async def send_reply(self, reply: Reply) -> None:
        if self.session_id is None:
            raise SessionError("Session ID missing before Reply", fatal=True)
        audio = encode_media_b64(reply.audio) if reply.audio is not None else None
        message = ResponseChunkMessage(
            session_id=self.session_id,
            text=reply.text,
            audio=audio,
            raw=reply.raw,
            final=reply.final,
            interrupted=reply.interrupted,
            t=reply.t,
        )
        payload = message.model_dump()
        if reply.t is None:
            payload.pop("t", None)
        if not reply.interrupted:
            payload.pop("interrupted", None)
        await self._send(payload, ORDINARY_WRITE_TIMEOUT_SECONDS)

    async def send_error(self, message: str, *, fatal: bool) -> None:
        payload = ErrorMessage(
            session_id=self.session_id,
            fatal=fatal,
            message=message,
        )
        await self._send(payload.model_dump(), ORDINARY_WRITE_TIMEOUT_SECONDS)

    async def send_terminal_error(self, message: str) -> None:
        payload = ErrorMessage(
            session_id=self.session_id,
            fatal=True,
            message=message,
        )
        await self._send(payload.model_dump(), TERMINAL_WRITE_TIMEOUT_SECONDS)

    async def send_ended(self) -> None:
        payload = SessionEndedMessage(session_id=self.session_id)
        await self._send(payload.model_dump(), TERMINAL_WRITE_TIMEOUT_SECONDS)

    async def close_socket(self, code: int) -> None:
        await asyncio.wait_for(self._websocket.close(code=code), timeout=CLOSE_TIMEOUT_SECONDS)

    async def _send(self, payload: dict[str, Any], timeout: float) -> None:
        text = json.dumps(payload)

        async def locked_send() -> None:
            async with self._lock:
                await self._websocket.send_text(text)

        try:
            await asyncio.wait_for(locked_send(), timeout=timeout)
        except TimeoutError as exc:
            raise SessionError("Outbound write timed out", fatal=True) from exc
