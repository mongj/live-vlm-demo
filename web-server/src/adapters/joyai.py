from __future__ import annotations

import asyncio
import base64
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Any, ClassVar, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .base import Adapter
from ..buffers import AudioBuffer, FrameBuffer
from ..types import ModelSpec, Reply, SessionError, VideoFrame, make_session_id

logger = logging.getLogger(__name__)

JOYAI_MODEL_NAME = "JoyAI-VL-Interaction"
JOYAI_TURN_TIMEOUT_SECONDS = 60.0
JOYAI_RESET_TIMEOUT_SECONDS = 2.0
REPLY_QUEUE_SIZE = 64
SESSION_HEADER = "x-streaming-session"
PROMPT_HEADER = "x-system-prompt-key"


class JoyAIConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    system_prompt_key: Literal[
        "DEFAULT_SYSTEM_PROMPT_EN",
        "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION",
    ] = "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION"
    max_frames_per_request: int = Field(default=1, ge=1, le=8)


def jpeg_data_url(jpeg: bytes) -> str:
    encoded = base64.b64encode(jpeg).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def presentable_joyai_text(content: str) -> str:
    text = content.strip()
    if text == "</silence>":
        return ""
    if text.startswith("</response>"):
        text = text.removeprefix("</response>").lstrip()
    return text.replace("</delegation>", "").replace("<delegation>", "")


def session_seconds_from_unix_ms(t_unix_ms: float, origin_unix_ms: float) -> float:
    # Playground protocol `t` is absolute Unix time in milliseconds.
    # JoyAI/webinfer `frame_time_ranges` expects session-relative seconds
    # from adapter open (same string format as the original JoyAI web UI).
    return max(0.0, (t_unix_ms - origin_unix_ms) / 1000.0)


def build_joyai_chat_body(
    frames: list[VideoFrame],
    query: str,
    *,
    origin_unix_ms: float,
) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    if query:
        content.append({"type": "text", "text": query})
    for frame in frames:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": jpeg_data_url(frame.jpeg)},
            }
        )
    return {
        "model": JOYAI_MODEL_NAME,
        "messages": [{"role": "user", "content": content}],
        "frame_time_ranges": [
            f"{session_seconds_from_unix_ms(frame.t, origin_unix_ms):.1f} seconds"
            for frame in frames
        ],
    }


def parse_joyai_reply(payload: object) -> Reply:
    if not isinstance(payload, dict):
        raise SessionError("JoyAI response missing required content fields", fatal=False)
    try:
        content = payload["choices"][0]["message"]["content"]
        raw = payload["streamingharness"]["raw_content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise SessionError(
            "JoyAI response missing required content fields", fatal=False
        ) from exc
    if not isinstance(content, str) or not isinstance(raw, str):
        raise SessionError("JoyAI response missing required content fields", fatal=False)
    return Reply(
        text=presentable_joyai_text(content),
        audio=None,
        raw=raw,
        final=True,
    )


class JoyAIAdapter(Adapter[JoyAIConfig]):
    config_model: ClassVar[type[BaseModel]] = JoyAIConfig

    def __init__(
        self,
        spec: ModelSpec,
        raw_config: dict[str, Any],
        *,
        http_transport: httpx.AsyncBaseTransport | httpx.BaseTransport | None = None,
    ) -> None:
        super().__init__(spec, raw_config)
        self.max_frames_per_request = self.config.max_frames_per_request
        self.audio_seconds_per_request = 0.0
        self.audio_retention_seconds = 0.0
        self.session_id = ""
        self._standing = ""
        self._query = ""
        self._http: httpx.AsyncClient | None = None
        self._http_transport = http_transport
        self._replies: asyncio.Queue[Reply] = asyncio.Queue(maxsize=REPLY_QUEUE_SIZE)
        self._origin_unix_ms = 0.0

    def _session_headers(self) -> dict[str, str]:
        return {
            SESSION_HEADER: self.session_id,
            PROMPT_HEADER: self.config.system_prompt_key,
        }

    async def open(self) -> str:
        if self.spec.base_url is None:
            raise SessionError("JoyAI base_url is missing", fatal=True)
        self.session_id = make_session_id(self.spec.id)
        client_kwargs: dict[str, Any] = {"base_url": self.spec.base_url}
        if self._http_transport is not None:
            client_kwargs["transport"] = self._http_transport
        self._http = httpx.AsyncClient(**client_kwargs)
        try:
            response = await self._http.post(
                "/streaming/reset",
                headers={SESSION_HEADER: self.session_id},
                json={},
            )
        except httpx.HTTPError as exc:
            raise SessionError(f"JoyAI open failed: {exc}", fatal=True) from exc
        if response.status_code == 404:
            raise SessionError("JoyAI session binding failed", fatal=True)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise SessionError(f"JoyAI open failed: {exc}", fatal=True) from exc
        self._origin_unix_ms = time.time() * 1000.0
        return self.session_id

    def offer_text(self, text: str) -> None:
        stripped = text.strip()
        if not stripped:
            return
        # webinfer replaces current_query_text on every nonempty prompt.
        # Chat follow-ups must append so a standing task is not wiped by
        # "hello?". The original UI has one prompt box, not a transcript.
        if self._standing:
            self._standing = f"{self._standing}\n{stripped}"
        else:
            self._standing = stripped
        self._query = self._standing

    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool:
        del audio
        batch = frames.consume()
        if not batch:
            return False
        # Send pending text once. Image-only turns keep webinfer's cached
        # query; resending the same prompt re-injects it every frame.
        query = self._query
        self._query = ""
        client = self._http
        if client is None:
            raise SessionError("JoyAI HTTP client is not open", fatal=True)
        body = build_joyai_chat_body(batch, query, origin_unix_ms=self._origin_unix_ms)
        try:
            response = await asyncio.wait_for(
                client.post(
                    "/chat/completions",
                    headers=self._session_headers(),
                    json=body,
                ),
                timeout=JOYAI_TURN_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            reply = replace(parse_joyai_reply(response.json()), t=batch[-1].t)
        except SessionError:
            raise
        except (httpx.HTTPError, TimeoutError, ValueError) as exc:
            raise SessionError(f"JoyAI turn failed: {exc}", fatal=False) from exc
        await self._replies.put(reply)
        return True

    async def read_replies(self) -> AsyncIterator[Reply]:
        while True:
            yield await self._replies.get()

    async def close(self) -> None:
        self._standing = ""
        self._query = ""
        self._origin_unix_ms = 0.0
        client = self._http
        session_id = self.session_id
        if client is None:
            return
        reset_error: BaseException | None = None
        try:
            if session_id:
                try:
                    await asyncio.wait_for(
                        client.post(
                            "/streaming/reset",
                            headers={SESSION_HEADER: session_id},
                            json={},
                        ),
                        timeout=JOYAI_RESET_TIMEOUT_SECONDS,
                    )
                except BaseException as exc:
                    reset_error = exc
        finally:
            self._http = None
            try:
                await client.aclose()
            except Exception:
                logger.exception("JoyAI HTTP client close failed")
            if isinstance(reset_error, asyncio.CancelledError):
                raise reset_error
            if reset_error is not None:
                logger.warning("JoyAI reset during close failed: %s", reset_error)
