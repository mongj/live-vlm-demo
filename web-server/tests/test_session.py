from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, ClassVar

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

import live_vlm_server.channel as channel_mod
import live_vlm_server.session as session_mod
from live_vlm_server.adapters.base import Adapter
from live_vlm_server.adapters.mock import MockAdapter, MockConfig, mock_turn_payload
from live_vlm_server.buffers import AudioBuffer, FrameBuffer
from live_vlm_server.catalog import Catalog
from live_vlm_server.channel import ClientChannel
from live_vlm_server.codecs import encode_media_b64
from live_vlm_server.main import create_app
from live_vlm_server.session import OPEN_TIMEOUT_SECONDS, run_session
from live_vlm_server.types import ModelSpec, Reply, SessionError, VideoFrame

MIN_JPEG = b"\xff\xd8\xff\xd9"
JPEG_B64 = encode_media_b64(MIN_JPEG)
PCM_TWO_SLICES = bytes(12_800)
SHIPPED = Path(__file__).resolve().parents[1] / "config.toml"
MOCK_SPEC = ModelSpec(id="mock", adapter="mock", label="Mock")


class FakeWebSocket:
    def __init__(self) -> None:
        self._incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.sent: list[str] = []
        self.closed_with: int | None = None
        self.hang_send = False
        self.fail_send = False
        self.fail_close = False
        self.on_send: Callable[[str], None] | None = None

    async def accept(self) -> None:
        return None

    async def receive(self) -> dict[str, Any]:
        return await self._incoming.get()

    async def send_text(self, data: str) -> None:
        if self.hang_send:
            await asyncio.Event().wait()
        if self.fail_send:
            raise RuntimeError("send failed")
        if self.on_send is not None:
            self.on_send(data)
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        if self.fail_close:
            raise RuntimeError("peer gone")
        self.closed_with = code

    def push_json(self, payload: dict[str, Any]) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    def push_text(self, raw: str) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "text": raw})

    def push_bytes(self, data: bytes) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "bytes": data})

    def push_disconnect(self) -> None:
        self._incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})


async def wait_json(websocket: FakeWebSocket, count: int, timeout: float = 2.0) -> list[dict[str, Any]]:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if len(websocket.sent) >= count:
            return [json.loads(item) for item in websocket.sent[:count]]
        await asyncio.sleep(0.01)
    raise AssertionError(f"wanted {count} messages, got {websocket.sent!r}")


async def wait_type(
    websocket: FakeWebSocket, message_type: str, timeout: float = 2.0
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        for item in websocket.sent:
            payload = json.loads(item)
            if isinstance(payload, dict) and payload.get("type") == message_type:
                return payload
        await asyncio.sleep(0.01)
    raise AssertionError(f"wanted {message_type}, got {websocket.sent!r}")


def mock_catalog() -> Catalog:
    return Catalog(specs=(MOCK_SPEC,), registry={"mock": MockAdapter})


class ScriptedAdapter(Adapter[MockConfig]):  # type: ignore[misc]
    config_model: ClassVar[type[BaseModel]] = MockConfig
    instances: ClassVar[list[ScriptedAdapter]] = []
    open_delay: ClassVar[float] = 0.0
    open_error: ClassVar[BaseException | None] = None
    feed_error: ClassVar[BaseException | None] = None
    feed_block: ClassVar[asyncio.Event | None] = None
    emit_before_block: ClassVar[bool] = False
    finite_replies: ClassVar[list[Reply] | None] = None
    fail_after_consume: ClassVar[bool] = False

    def __init__(self, spec: ModelSpec, raw_config: dict[str, Any]) -> None:
        super().__init__(spec, raw_config)
        self.max_frames_per_request = 4
        self.audio_seconds_per_request = 0.2
        self.audio_retention_seconds = 1.0
        self.session_id = ""
        self._query = ""
        self._replies: asyncio.Queue[Reply] = asyncio.Queue(maxsize=64)
        self.closed = False
        self.feed_calls = 0
        self.snapshotted_text: list[str] = []
        ScriptedAdapter.instances.append(self)

    @classmethod
    def reset(cls) -> None:
        cls.instances = []
        cls.open_delay = 0.0
        cls.open_error = None
        cls.feed_error = None
        cls.feed_block = None
        cls.emit_before_block = False
        cls.finite_replies = None
        cls.fail_after_consume = False

    async def open(self) -> str:
        if self.open_delay:
            await asyncio.sleep(self.open_delay)
        if self.open_error is not None:
            raise self.open_error
        self.session_id = f"{self.spec.id}-scripted"
        return self.session_id

    def offer_text(self, text: str) -> None:
        stripped = text.strip()
        if stripped:
            self._query = stripped

    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool:
        batch = frames.consume()
        pcm = audio.consume()
        if not batch and pcm is None:
            return False
        self.feed_calls += 1
        self.snapshotted_text.append(self._query)
        if self.fail_after_consume:
            raise SessionError("turn failed", fatal=False)
        if self.feed_error is not None:
            raise self.feed_error
        if self.emit_before_block:
            await self._replies.put(
                Reply(
                    text="early",
                    raw="early",
                    final=True,
                    t=batch[-1].t if batch else None,
                )
            )
        if self.feed_block is not None:
            await self.feed_block.wait()
        return True

    async def read_replies(self) -> AsyncIterator[Reply]:
        if self.finite_replies is not None:
            for reply in self.finite_replies:
                yield reply
            return
        while True:
            yield await self._replies.get()

    async def close(self) -> None:
        self.closed = True
        self._query = ""


def scripted_catalog() -> Catalog:
    return Catalog(
        specs=(ModelSpec(id="test", adapter="test", label="Test"),),
        registry={"test": ScriptedAdapter},
    )


@pytest.fixture(autouse=True)
def _reset_scripted() -> None:
    ScriptedAdapter.reset()


async def test_acknowledged_start_effective_config_and_normal_close(
    caplog: pytest.LogCaptureFixture,
) -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.start", "model": "mock", "config": {}})
    started = (await wait_json(websocket, 1))[0]
    assert started["type"] == "session.started"
    assert started["model"] == "mock"
    assert started["config"] == {"latency_ms": 150}
    assert started["session_id"].startswith("mock-")
    websocket.push_disconnect()
    with caplog.at_level(logging.INFO, logger="live_vlm_server.session"):
        await asyncio.wait_for(task, timeout=2)
    assert websocket.closed_with == 1000
    assert all(json.loads(item)["type"] != "error" for item in websocket.sent)
    assert all(json.loads(item)["type"] != "session.ended" for item in websocket.sent)
    assert f"WebSocket closed session_id={started['session_id']}" in caplog.text
    assert "WebSocket close failed" not in caplog.text


async def test_session_end_acks_after_adapter_cleanup(
    caplog: pytest.LogCaptureFixture,
) -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    started = (await wait_json(websocket, 1))[0]
    adapter = ScriptedAdapter.instances[-1]
    ended_after_close: list[bool] = []

    def on_send(data: str) -> None:
        payload = json.loads(data)
        if payload["type"] == "session.ended":
            ended_after_close.append(adapter.closed)

    websocket.on_send = on_send
    websocket.push_json({"type": "session.end"})
    with caplog.at_level(logging.INFO, logger="live_vlm_server.session"):
        ended = await wait_type(websocket, "session.ended")
        assert ended["session_id"] == started["session_id"]
        await asyncio.wait_for(task, timeout=2)
    assert ended_after_close == [True]
    assert adapter.closed is True
    assert websocket.closed_with == 1000
    assert all(json.loads(item)["type"] != "error" for item in websocket.sent)
    sent_types = [json.loads(item)["type"] for item in websocket.sent]
    assert sent_types[-1] == "session.ended"
    assert "WebSocket close failed" not in caplog.text
    assert f"WebSocket closed session_id={started['session_id']}" in caplog.text


async def test_session_end_before_start() -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.end"})
    ended = (await wait_json(websocket, 1))[0]
    assert ended == {"type": "session.ended", "session_id": None}
    await asyncio.wait_for(task, timeout=2)
    assert websocket.closed_with == 1000


async def test_session_end_after_feed_preserves_consume_once() -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.start", "model": "mock", "config": {"latency_ms": 0}})
    started = (await wait_json(websocket, 1))[0]
    sent_t = 1_726_700_000_123
    websocket.push_json({"type": "input.append", "frame": JPEG_B64, "t": sent_t})
    chunk = await wait_type(websocket, "response.chunk")
    expected_text, expected_raw = mock_turn_payload("")
    assert chunk["session_id"] == started["session_id"]
    assert chunk["t"] == sent_t
    assert chunk["text"] == expected_text
    assert chunk["raw"] == expected_raw
    assert chunk["final"] is True
    websocket.push_json({"type": "session.end"})
    ended = await wait_type(websocket, "session.ended")
    assert ended["session_id"] == started["session_id"]
    await asyncio.wait_for(task, timeout=2)
    assert websocket.closed_with == 1000


async def test_websocket_close_failure_is_logged_loudly(
    caplog: pytest.LogCaptureFixture,
) -> None:
    websocket = FakeWebSocket()
    websocket.fail_close = True
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.start", "model": "mock", "config": {}})
    await wait_json(websocket, 1)
    websocket.push_disconnect()
    with caplog.at_level(logging.INFO, logger="live_vlm_server.session"):
        await asyncio.wait_for(task, timeout=2)
    assert "WebSocket close failed" in caplog.text
    assert "peer gone" in caplog.text
    assert "WebSocket closed session_id=" not in caplog.text


async def test_protocol_errors_second_start_and_feed_before_start() -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_text("{")
    websocket.push_bytes(b"nope")
    websocket.push_json({"type": "input.append", "text": "early"})
    websocket.push_json({"type": "session.start", "model": "mock", "config": {"latency_ms": 0}})
    started_messages = await wait_json(websocket, 4)
    assert [message["type"] for message in started_messages[:3]] == ["error", "error", "error"]
    assert started_messages[0]["fatal"] is False
    assert started_messages[0]["session_id"] is None
    assert "Feed before Start" in started_messages[2]["message"]
    assert started_messages[3]["type"] == "session.started"
    websocket.push_json({"type": "session.start", "model": "mock"})
    messages = await wait_json(websocket, 5)
    assert messages[4]["type"] == "error"
    assert messages[4]["fatal"] is False
    assert "already started" in messages[4]["message"]
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)


async def test_unknown_model_and_invalid_config_are_fatal() -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.start", "model": "nope"})
    error = (await wait_json(websocket, 1))[0]
    assert error["type"] == "error"
    assert error["fatal"] is True
    await asyncio.wait_for(task, timeout=2)
    assert websocket.closed_with == 1011

    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.start", "model": "mock", "config": {"nope": 1}})
    error = (await wait_json(websocket, 1))[0]
    assert error["fatal"] is True
    assert "Invalid Config" in error["message"]
    await asyncio.wait_for(task, timeout=2)
    assert websocket.closed_with == 1011


async def test_accepted_field_error_keeps_earlier_frame() -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.start", "model": "mock", "config": {"latency_ms": 0}})
    started = (await wait_json(websocket, 1))[0]
    websocket.push_json({"type": "input.append", "frame": JPEG_B64, "audio": "!!!!", "t": 1.25})
    messages = await wait_json(websocket, 3)
    error = next(message for message in messages if message["type"] == "error")
    chunks = [message for message in messages if message["type"] == "response.chunk"]
    expected_text, expected_raw = mock_turn_payload("")
    assert error["fatal"] is False
    assert len(chunks) == 1
    assert chunks[0]["session_id"] == started["session_id"]
    assert chunks[0]["text"] == expected_text
    assert chunks[0]["raw"] == expected_raw
    assert chunks[0]["final"] is True
    assert chunks[0]["t"] == 1.25
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)


async def test_client_and_server_timestamp_modes() -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.start", "model": "mock", "config": {"latency_ms": 0}})
    await wait_json(websocket, 1)
    websocket.push_json({"type": "input.append", "frame": JPEG_B64, "t": 9.0})
    await wait_json(websocket, 2)
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)

    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.start", "model": "mock", "config": {"latency_ms": 0}})
    await wait_json(websocket, 1)
    websocket.push_json({"type": "input.append", "frame": JPEG_B64})
    await wait_json(websocket, 2)
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)


async def test_one_notification_drains_complete_audio_slices() -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, mock_catalog()))
    websocket.push_json({"type": "session.start", "model": "mock", "config": {"latency_ms": 0}})
    await wait_json(websocket, 1)
    websocket.push_json({"type": "input.append", "audio": encode_media_b64(PCM_TWO_SLICES)})
    messages = await wait_json(websocket, 3)
    chunks = [message for message in messages if message["type"] == "response.chunk"]
    assert len(chunks) == 2
    assert chunks[0]["final"] is True
    assert chunks[1]["final"] is True
    assert chunks[0]["raw"] == "</silence>"
    assert chunks[1]["raw"] == "</silence>"
    assert chunks[0]["text"] == ""
    assert chunks[1]["text"] == ""
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)


async def test_input_during_blocked_turn_and_text_snapshot() -> None:
    ScriptedAdapter.feed_block = asyncio.Event()
    ScriptedAdapter.emit_before_block = True
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    started = (await wait_json(websocket, 1))[0]
    websocket.push_json({"type": "input.append", "frame": JPEG_B64, "text": "first"})
    early = await wait_json(websocket, 2)
    assert early[1]["text"] == "early"
    websocket.push_json({"type": "input.append", "text": "second"})
    adapter = ScriptedAdapter.instances[-1]
    deadline = asyncio.get_running_loop().time() + 2
    while adapter._query != "second" and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)
    assert adapter.snapshotted_text == ["first"]
    assert adapter._query == "second"
    assert adapter.feed_calls == 1
    ScriptedAdapter.feed_block.set()
    websocket.push_json({"type": "input.append", "frame": JPEG_B64})
    deadline = asyncio.get_running_loop().time() + 2
    while adapter.feed_calls < 2 and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)
    assert adapter.feed_calls == 2
    assert adapter.snapshotted_text == ["first", "second"]
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)
    assert started["session_id"] == "test-scripted"


async def test_recoverable_turn_failure_does_not_retry_consumed_media() -> None:
    ScriptedAdapter.fail_after_consume = True
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await wait_json(websocket, 1)
    websocket.push_json({"type": "input.append", "frame": JPEG_B64})
    error = (await wait_json(websocket, 2))[1]
    assert error["type"] == "error"
    assert error["fatal"] is False
    adapter = ScriptedAdapter.instances[-1]
    assert adapter.feed_calls == 1
    ScriptedAdapter.fail_after_consume = False
    websocket.push_json({"type": "input.append", "frame": JPEG_B64})
    deadline = asyncio.get_running_loop().time() + 2
    while adapter.feed_calls < 2 and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)
    assert adapter.feed_calls == 2
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)


async def test_idle_waiting_does_not_spin() -> None:
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await wait_json(websocket, 1)
    await asyncio.sleep(0.1)
    assert ScriptedAdapter.instances[-1].feed_calls == 0
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)


async def test_concurrent_reply_while_feed_blocked() -> None:
    ScriptedAdapter.feed_block = asyncio.Event()
    ScriptedAdapter.emit_before_block = True
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await wait_json(websocket, 1)
    websocket.push_json({"type": "input.append", "frame": JPEG_B64})
    messages = await wait_json(websocket, 2)
    assert messages[1]["type"] == "response.chunk"
    assert ScriptedAdapter.instances[-1].feed_block is not None
    assert not ScriptedAdapter.instances[-1].feed_block.is_set()
    ScriptedAdapter.feed_block.set()
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)


async def test_channel_serializes_writes_and_times_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket = FakeWebSocket()
    channel = ClientChannel(websocket)
    channel.adopt_session_id("mock-1")
    await channel.send_error("one", fatal=False)
    await channel.send_reply(
        Reply(text="two", raw="two", final=True, audio=b"\x00\x00", t=1_726_700_000_123)
    )
    await channel.send_ended()
    payloads = [json.loads(item) for item in websocket.sent]
    assert payloads[0]["type"] == "error"
    assert payloads[1]["type"] == "response.chunk"
    assert payloads[1]["audio"] == encode_media_b64(b"\x00\x00")
    assert payloads[1]["t"] == 1_726_700_000_123
    assert payloads[2] == {"type": "session.ended", "session_id": "mock-1"}
    await channel.send_reply(Reply(text="three", raw="three", final=True))
    payloads = [json.loads(item) for item in websocket.sent]
    assert "t" not in payloads[3]
    websocket.hang_send = True
    monkeypatch.setattr(channel_mod, "ORDINARY_WRITE_TIMEOUT_SECONDS", 0.05)
    with pytest.raises(SessionError, match="timed out"):
        await channel.send_error("late", fatal=False)


async def test_partial_open_timeout_and_failed_ack(monkeypatch: pytest.MonkeyPatch) -> None:
    ScriptedAdapter.open_error = SessionError("open failed", fatal=True)
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await asyncio.wait_for(task, timeout=2)
    assert ScriptedAdapter.instances[-1].closed is True
    assert websocket.closed_with == 1011

    ScriptedAdapter.reset()
    ScriptedAdapter.open_delay = 1.0
    monkeypatch.setattr(session_mod, "OPEN_TIMEOUT_SECONDS", 0.05)
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await asyncio.wait_for(task, timeout=2)
    assert ScriptedAdapter.instances[-1].closed is True
    error = json.loads(websocket.sent[0])
    assert error["fatal"] is True
    assert "timed out" in error["message"]
    monkeypatch.setattr(session_mod, "OPEN_TIMEOUT_SECONDS", OPEN_TIMEOUT_SECONDS)

    ScriptedAdapter.reset()
    websocket = FakeWebSocket()
    websocket.fail_send = True
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await asyncio.wait_for(task, timeout=2)
    assert ScriptedAdapter.instances[-1].closed is True
    assert websocket.closed_with == 1011


async def test_startup_cancellation_closes_adapter() -> None:
    ScriptedAdapter.open_delay = 1.0
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert ScriptedAdapter.instances[-1].closed is True


async def test_worker_failure_reply_eof_and_failed_terminal_error() -> None:
    ScriptedAdapter.feed_error = RuntimeError("boom")
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await wait_json(websocket, 1)
    websocket.push_json({"type": "input.append", "frame": JPEG_B64})
    await asyncio.wait_for(task, timeout=2)
    assert websocket.closed_with == 1011
    assert ScriptedAdapter.instances[-1].closed is True
    assert any(json.loads(item)["type"] == "error" for item in websocket.sent)

    ScriptedAdapter.reset()
    ScriptedAdapter.finite_replies = []
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await asyncio.wait_for(task, timeout=2)
    error = next(json.loads(item) for item in websocket.sent if json.loads(item)["type"] == "error")
    assert error["fatal"] is True
    assert "reply stream ended" in error["message"]
    assert websocket.closed_with == 1011

    ScriptedAdapter.reset()
    ScriptedAdapter.finite_replies = []
    websocket = FakeWebSocket()
    websocket.fail_send = True
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    await asyncio.wait_for(task, timeout=2)
    assert ScriptedAdapter.instances[-1].closed is True
    assert websocket.closed_with == 1011


async def test_simultaneous_disconnect_and_eof() -> None:
    ScriptedAdapter.finite_replies = [Reply(text="bye", raw="bye", final=True)]
    websocket = FakeWebSocket()
    task = asyncio.create_task(run_session(websocket, scripted_catalog()))
    websocket.push_json({"type": "session.start", "model": "test"})
    websocket.push_disconnect()
    await asyncio.wait_for(task, timeout=2)
    assert ScriptedAdapter.instances[-1].closed is True
    assert websocket.closed_with in {1000, 1011}


def test_mock_websocket_e2e_with_test_client() -> None:
    with TestClient(create_app(SHIPPED)) as client:
        with client.websocket_connect("/v1/realtime") as websocket:
            websocket.send_json(
                {"type": "session.start", "model": "mock", "config": {"latency_ms": 0}}
            )
            started = websocket.receive_json()
            assert started["type"] == "session.started"
            assert started["config"]["latency_ms"] == 0
            sent_t = 1_726_700_000_123
            websocket.send_json(
                {
                    "type": "input.append",
                    "frame": JPEG_B64,
                    "text": "What is on the desk?",
                    "t": sent_t,
                }
            )
            chunk = websocket.receive_json()
            expected_text, expected_raw = mock_turn_payload("What is on the desk?")
            assert chunk["type"] == "response.chunk"
            assert chunk["final"] is True
            assert chunk["session_id"] == started["session_id"]
            assert chunk["t"] == sent_t
            assert chunk["text"] == expected_text
            assert chunk["raw"] == expected_raw
            assert chunk["audio"] is not None


def test_session_end_websocket_e2e_with_test_client() -> None:
    with TestClient(create_app(SHIPPED)) as client:
        with client.websocket_connect("/v1/realtime") as websocket:
            websocket.send_json(
                {"type": "session.start", "model": "mock", "config": {"latency_ms": 0}}
            )
            started = websocket.receive_json()
            assert started["type"] == "session.started"
            websocket.send_json({"type": "session.end"})
            ended = websocket.receive_json()
            assert ended["type"] == "session.ended"
            assert ended["session_id"] == started["session_id"]
