from __future__ import annotations

import asyncio
import socket
from typing import Any

import pytest
from pydantic import ValidationError

from live_vlm_server.adapters.joyai import presentable_joyai_text
from live_vlm_server.adapters.mock import (
    MOCK_RESPONSE_TEXT,
    SILENCE_RAW,
    SILENT_PCM_CHUNK,
    MockAdapter,
    MockConfig,
    mock_turn_payload,
)
from live_vlm_server.buffers import AudioBuffer, FrameBuffer
from live_vlm_server.types import ModelSpec, Reply, VideoFrame

MIN_JPEG = b"\xff\xd8\xff\xd9"
SPEC = ModelSpec(id="mock", adapter="mock", label="Mock")
UNIX_MS = 1_726_700_000_123


def _frames(*timestamps: float) -> FrameBuffer:
    buffer = FrameBuffer(max_frames=4)
    for timestamp in timestamps:
        buffer.push(VideoFrame(jpeg=MIN_JPEG, t=timestamp))
    return buffer


def _audio(*chunks: bytes) -> AudioBuffer:
    buffer = AudioBuffer(seconds_per_request=0.2, retention_seconds=1.0)
    for chunk in chunks:
        buffer.push(chunk)
    return buffer


def _assert_joyai_shaped(reply: Reply, *, spoken: bool) -> None:
    text, raw = mock_turn_payload("query" if spoken else "")
    assert reply.text == text
    assert reply.raw == raw
    assert reply.final is True
    assert presentable_joyai_text(reply.raw) == reply.text
    if spoken:
        assert reply.text == MOCK_RESPONSE_TEXT
        assert reply.raw == f"</response> {MOCK_RESPONSE_TEXT}"
    else:
        assert reply.text == ""
        assert reply.raw == SILENCE_RAW


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def blocked(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("Mock adapter must not use the network")

    monkeypatch.setattr(socket.socket, "connect", blocked)


def test_config_defaults_and_unknown_key_rejection() -> None:
    config = MockConfig.model_validate({})
    assert config.latency_ms == 150
    with pytest.raises(ValidationError):
        MockConfig.model_validate({"latency_ms": 1, "unknown": True})


def test_payload_matches_joyai_presentable_raw_split() -> None:
    text, raw = mock_turn_payload("What is on the desk?")
    assert text == MOCK_RESPONSE_TEXT
    assert raw == f"</response> {MOCK_RESPONSE_TEXT}"
    assert presentable_joyai_text(raw) == text
    assert mock_turn_payload("") == ("", SILENCE_RAW)
    assert presentable_joyai_text(SILENCE_RAW) == ""


@pytest.mark.usefixtures("no_network")
async def test_open_feed_one_reply_close() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 0})
    session_id = await adapter.open()
    assert session_id.startswith("mock-")
    assert len(session_id.removeprefix("mock-")) == 32
    adapter.offer_text("hello")
    assert await adapter.send_feed(_frames(UNIX_MS), _audio()) is True
    reply = await anext(adapter.read_replies())
    expected_text, expected_raw = mock_turn_payload("hello")
    assert reply == Reply(
        text=expected_text,
        audio=SILENT_PCM_CHUNK,
        raw=expected_raw,
        final=True,
        t=UNIX_MS,
    )
    _assert_joyai_shaped(reply, spoken=True)
    assert reply.audio is not None and len(reply.audio) == 4800
    await adapter.close()


@pytest.mark.usefixtures("no_network")
async def test_frame_only_is_silence_audio_only_and_text_only() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 0})
    await adapter.open()
    assert await adapter.send_feed(_frames(UNIX_MS), _audio()) is True
    silent = await anext(adapter.read_replies())
    _assert_joyai_shaped(silent, spoken=False)
    assert silent.t == UNIX_MS

    audio = _audio(bytes(6400))
    assert await adapter.send_feed(_frames(), audio) is True
    audio_only = await anext(adapter.read_replies())
    _assert_joyai_shaped(audio_only, spoken=False)
    assert audio_only.t is None

    adapter.offer_text("only text")
    assert await adapter.send_feed(_frames(), _audio()) is False
    assert await adapter.send_feed(_frames(UNIX_MS + 1), _audio()) is True
    pending = await anext(adapter.read_replies())
    _assert_joyai_shaped(pending, spoken=True)
    assert pending.t == UNIX_MS + 1


@pytest.mark.usefixtures("no_network")
async def test_query_is_consumed_once_later_frames_are_silence() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 0})
    await adapter.open()
    adapter.offer_text("hello")
    assert await adapter.send_feed(_frames(1.0), _audio()) is True
    spoken = await anext(adapter.read_replies())
    _assert_joyai_shaped(spoken, spoken=True)

    assert await adapter.send_feed(_frames(2.0), _audio()) is True
    quiet = await anext(adapter.read_replies())
    _assert_joyai_shaped(quiet, spoken=False)
    await adapter.close()


@pytest.mark.usefixtures("no_network")
async def test_standing_query_accumulates_and_is_sent_once() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 0})
    await adapter.open()
    adapter.offer_text("count my fingers")
    assert await adapter.send_feed(_frames(1.0), _audio()) is True
    first = await anext(adapter.read_replies())
    _assert_joyai_shaped(first, spoken=True)

    adapter.offer_text("hello?")
    assert adapter._standing == "count my fingers\nhello?"
    assert adapter._query == "count my fingers\nhello?"
    assert await adapter.send_feed(_frames(2.0), _audio()) is True
    second = await anext(adapter.read_replies())
    _assert_joyai_shaped(second, spoken=True)
    assert adapter._query == ""

    assert await adapter.send_feed(_frames(3.0), _audio()) is True
    later = await anext(adapter.read_replies())
    _assert_joyai_shaped(later, spoken=False)
    await adapter.close()


@pytest.mark.usefixtures("no_network")
async def test_incomplete_audio_is_preserved() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 0})
    await adapter.open()
    audio = _audio(bytes(1000))
    assert await adapter.send_feed(_frames(), audio) is False
    assert len(audio) == 1000
    audio.push(bytes(5400))
    assert await adapter.send_feed(_frames(), audio) is True
    assert len(audio) == 0


@pytest.mark.usefixtures("no_network")
async def test_text_is_snapshotted_before_latency() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 80})
    await adapter.open()
    adapter.offer_text("first")
    frames = _frames(0.0)
    audio = _audio()
    task = asyncio.create_task(adapter.send_feed(frames, audio))
    await asyncio.sleep(0.02)
    adapter.offer_text("second")
    assert await task is True
    first = await anext(adapter.read_replies())
    _assert_joyai_shaped(first, spoken=True)
    assert adapter._standing == "first\nsecond"
    assert adapter._query == "first\nsecond"
    assert await adapter.send_feed(_frames(1.0), _audio()) is True
    second = await anext(adapter.read_replies())
    _assert_joyai_shaped(second, spoken=True)
    assert adapter._query == ""


@pytest.mark.usefixtures("no_network")
async def test_bounded_reply_queue_and_close_clears_text() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 0})
    await adapter.open()
    for _ in range(64):
        assert await adapter.send_feed(_frames(0.0), _audio()) is True
    assert adapter._replies.full()
    assert adapter._replies.qsize() == 64
    adapter.offer_text("remembered")
    await adapter.close()
    leftover = await anext(adapter.read_replies())
    assert adapter._replies.qsize() == 63
    assert leftover.final is True
    assert leftover.raw == SILENCE_RAW
    assert await adapter.send_feed(_frames(2.0), _audio()) is True
    after_close = await anext(adapter.read_replies())
    assert "remembered" not in after_close.text
    assert after_close.raw == SILENCE_RAW
    _assert_joyai_shaped(after_close, spoken=False)
