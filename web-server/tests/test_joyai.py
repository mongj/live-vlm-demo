from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from live_vlm_server.adapters.joyai import (
    JOYAI_MODEL_NAME,
    JOYAI_TURN_TIMEOUT_SECONDS,
    JoyAIAdapter,
    JoyAIConfig,
    build_joyai_chat_body,
    parse_joyai_reply,
    presentable_joyai_text,
)
from live_vlm_server.buffers import AudioBuffer, FrameBuffer
from live_vlm_server.catalog import Catalog
from live_vlm_server.codecs import encode_media_b64
from live_vlm_server.session import run_session
from live_vlm_server.types import ModelSpec, Reply, SessionError, VideoFrame

MIN_JPEG = b"\xff\xd8\xff\xd9"
SPEC = ModelSpec(
    id="joyai-vl",
    adapter="joyai",
    label="JoyAI-VL-Interaction",
    base_url="http://127.0.0.1:8070/v1",
)


def _frames(*timestamps: float) -> FrameBuffer:
    buffer = FrameBuffer(max_frames=8)
    for timestamp in timestamps:
        buffer.push(VideoFrame(jpeg=MIN_JPEG, t=timestamp))
    return buffer


def _disabled_audio() -> AudioBuffer:
    return AudioBuffer(seconds_per_request=0.0, retention_seconds=0.0)


def _completion(
    content: str, raw: str
) -> dict[str, Any]:
    return {
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "streamingharness": {"raw_content": raw},
    }


class ScriptedTransport(httpx.AsyncBaseTransport):
    def __init__(
        self, handler: Callable[[httpx.Request], Any]
    ) -> None:
        self.handler = handler
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        result = self.handler(request)
        if asyncio.iscoroutine(result):
            result = await result
        assert isinstance(result, httpx.Response)
        return result


def _reset_ok(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"ok": True, "removed": False, "session_id": "x"})


class _FakeWebSocket:
    def __init__(self) -> None:
        self._incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.sent: list[str] = []
        self.closed_with: int | None = None
        self.hang_send = False
        self.fail_send = False

    async def accept(self) -> None:
        return None

    async def receive(self) -> dict[str, Any]:
        return await self._incoming.get()

    async def send_text(self, data: str) -> None:
        if self.hang_send:
            await asyncio.Event().wait()
        if self.fail_send:
            raise RuntimeError("send failed")
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed_with = code

    def push_json(self, payload: dict[str, Any]) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    def push_disconnect(self) -> None:
        self._incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})


async def _wait_json(websocket: _FakeWebSocket, count: int, timeout: float = 2.0) -> list[dict[str, Any]]:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if len(websocket.sent) >= count:
            return [json.loads(item) for item in websocket.sent[:count]]
        await asyncio.sleep(0.01)
    raise AssertionError(f"wanted {count} messages, got {websocket.sent!r}")


def test_config_defaults_and_schema() -> None:
    config = JoyAIConfig.model_validate({})
    assert config.system_prompt_key == "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION"
    assert config.max_frames_per_request == 1
    with pytest.raises(Exception):
        JoyAIConfig.model_validate({"max_frames_per_request": 1, "unknown": True})


def test_presentable_text_and_raw_table() -> None:
    assert presentable_joyai_text("</response> A laptop.") == "A laptop."
    assert presentable_joyai_text("</silence>") == ""
    reply = parse_joyai_reply(
        _completion("</response> A laptop.", "  </response> A laptop.  ")
    )
    assert reply == Reply(
        text="A laptop.", audio=None, raw="  </response> A laptop.  ", final=True
    )
    silent = parse_joyai_reply(_completion("</silence>", "</silence>"))
    assert silent.text == ""
    assert silent.raw == "</silence>"
    forced = parse_joyai_reply(_completion("</silence>", ""))
    assert forced.text == ""
    assert forced.raw == ""
    delegated = presentable_joyai_text(
        "</response> Calling helper. </delegation> <what is 2+2>"
    )
    assert "</delegation>" not in delegated
    assert "<delegation>" not in delegated
    assert "Calling helper." in delegated
    assert "what is 2+2" in delegated
    with pytest.raises(SessionError, match="required content fields"):
        parse_joyai_reply({})


async def test_open_reset_and_visual_turn_contract() -> None:
    transport = ScriptedTransport(
        lambda request: _reset_ok(request)
        if request.url.path.endswith("/streaming/reset")
        else httpx.Response(
            200,
            json=_completion("</response> A laptop.", "  </response> A laptop.  "),
        )
    )
    adapter = JoyAIAdapter(
        SPEC,
        {"system_prompt_key": "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION", "max_frames_per_request": 2},
        http_transport=transport,
    )
    session_id = await adapter.open()
    assert session_id.startswith("joyai-vl-")
    reset = transport.requests[0]
    assert str(reset.url) == "http://127.0.0.1:8070/v1/streaming/reset"
    assert json.loads(reset.content) == {}
    assert reset.headers["x-streaming-session"] == session_id
    adapter.offer_text("What is on the desk?")
    adapter.offer_text("   ")
    adapter.offer_text("latest question")
    frames = _frames(1.5, 2.0)
    assert await adapter.send_feed(frames, _disabled_audio()) is True
    turn = transport.requests[1]
    assert str(turn.url) == "http://127.0.0.1:8070/v1/chat/completions"
    assert turn.headers["x-streaming-session"] == session_id
    assert turn.headers["x-system-prompt-key"] == "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION"
    body = json.loads(turn.content)
    assert set(body) == {"model", "messages", "frame_time_ranges"}
    assert body["model"] == JOYAI_MODEL_NAME
    assert body["frame_time_ranges"] == ["1.5 seconds", "2.0 seconds"]
    content = body["messages"][0]["content"]
    assert content[0] == {"type": "text", "text": "latest question"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    expected = build_joyai_chat_body(
        [VideoFrame(MIN_JPEG, 1.5), VideoFrame(MIN_JPEG, 2.0)],
        "latest question",
    )
    assert body == expected
    reply = await anext(adapter.read_replies())
    assert reply.text == "A laptop."
    assert reply.raw == "  </response> A laptop.  "
    assert reply.audio is None
    assert reply.final is True
    await adapter.close()
    closing_reset = transport.requests[-1]
    assert closing_reset.url.path.endswith("/streaming/reset")
    assert json.loads(closing_reset.content) == {}


async def test_recoverable_http_failure_and_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/streaming/reset"):
            return _reset_ok(request)
        return httpx.Response(500, json={"error": "nope"})

    adapter = JoyAIAdapter(SPEC, {}, http_transport=ScriptedTransport(handler))
    await adapter.open()
    with pytest.raises(SessionError) as failed:
        await adapter.send_feed(_frames(0.0), _disabled_audio())
    assert failed.value.fatal is False
    await adapter.close()

    async def slow(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/streaming/reset"):
            return _reset_ok(request)
        await asyncio.Event().wait()
        return httpx.Response(200, json=_completion("</silence>", "</silence>"))

    monkeypatch.setattr(
        "live_vlm_server.adapters.joyai.JOYAI_TURN_TIMEOUT_SECONDS", 0.05
    )
    adapter = JoyAIAdapter(SPEC, {}, http_transport=ScriptedTransport(slow))
    await adapter.open()
    with pytest.raises(SessionError) as timed_out:
        await adapter.send_feed(_frames(0.0), _disabled_audio())
    assert timed_out.value.fatal is False
    await adapter.close()
    assert JOYAI_TURN_TIMEOUT_SECONDS == 60.0


async def test_failed_reset_is_binding_failure_and_close_releases_client() -> None:
    closed = {"count": 0}

    class TrackingTransport(ScriptedTransport):
        async def aclose(self) -> None:
            closed["count"] += 1
            await super().aclose()

    transport = TrackingTransport(lambda _request: httpx.Response(404, json={"ok": False}))
    adapter = JoyAIAdapter(SPEC, {}, http_transport=transport)
    with pytest.raises(SessionError, match="binding failed") as exc:
        await adapter.open()
    assert exc.value.fatal is True
    await adapter.close()
    assert adapter._http is None
    assert closed["count"] >= 1


async def test_session_quiet_drops_audio_and_forwards_normalized_reply() -> None:
    transport = ScriptedTransport(
        lambda request: _reset_ok(request)
        if request.url.path.endswith("/streaming/reset")
        else httpx.Response(200, json=_completion("</response> A laptop.", "raw"))
    )

    class FakeJoyAI(JoyAIAdapter):  # type: ignore[misc]
        def __init__(self, spec: ModelSpec, raw_config: dict[str, Any]) -> None:
            super().__init__(spec, raw_config, http_transport=transport)

    catalog = Catalog(specs=(SPEC,), registry={"joyai": FakeJoyAI})
    websocket = _FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, catalog))
    websocket.push_json(
        {"type": "session.start", "model": "joyai-vl", "config": {"max_frames_per_request": 2}}
    )
    started = await _wait_json(websocket, 1)
    assert started[0]["type"] == "session.started"
    assert started[0]["config"]["system_prompt_key"] == "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION"
    websocket.push_json(
        {
            "type": "input.append",
            "frame": encode_media_b64(MIN_JPEG),
            "audio": "this is not valid base64!!!",
            "text": "What is on the desk?",
            "t": 1.5,
        }
    )
    messages = await _wait_json(websocket, 2)
    types = [message["type"] for message in messages]
    assert "error" not in types
    chunk = next(message for message in messages if message["type"] == "response.chunk")
    assert chunk["text"] == "A laptop."
    assert chunk["raw"] == "raw"
    assert chunk["audio"] is None
    assert chunk["final"] is True
    assert chunk["session_id"] == started[0]["session_id"]
    turn = next(
        request
        for request in transport.requests
        if request.url.path.endswith("/chat/completions")
    )
    body = json.loads(turn.content)
    assert body["frame_time_ranges"] == ["1.5 seconds"]
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)
    assert websocket.closed_with == 1000
    assert any(request.url.path.endswith("/streaming/reset") for request in transport.requests[-2:])
