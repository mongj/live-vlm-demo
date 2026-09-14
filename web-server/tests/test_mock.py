from __future__ import annotations

import asyncio
import socket
from typing import Any

import pytest
from pydantic import ValidationError

from live_vlm_server.adapters.mock import (
    SILENT_PCM_CHUNK,
    MockAdapter,
    MockConfig,
    mock_turn_chunks,
)
from live_vlm_server.buffers import AudioBuffer, FrameBuffer
from live_vlm_server.types import ModelSpec, Reply, VideoFrame

MIN_JPEG = b"\xff\xd8\xff\xd9"
SPEC = ModelSpec(id="mock", adapter="mock", label="Mock")


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


@pytest.mark.usefixtures("no_network")
async def test_open_feed_two_replies_close() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 0})
    session_id = await adapter.open()
    assert session_id.startswith("mock-")
    assert len(session_id.removeprefix("mock-")) == 32
    adapter.offer_text("hello")
    assert await adapter.send_feed(_frames(0.0), _audio()) is True
    first = await anext(adapter.read_replies())
    second = await anext(adapter.read_replies())
    expected_first, expected_second = mock_turn_chunks(1, 0, "hello")
    assert first == Reply(
        text=expected_first, audio=SILENT_PCM_CHUNK, raw=expected_first, final=False
    )
    assert second == Reply(
        text=expected_second, audio=SILENT_PCM_CHUNK, raw=expected_second, final=True
    )
    assert first.audio is not None and len(first.audio) == 4800
    await adapter.close()


@pytest.mark.usefixtures("no_network")
async def test_frame_only_audio_only_and_text_only() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 0})
    await adapter.open()
    assert await adapter.send_feed(_frames(1.0), _audio()) is True
    first = await anext(adapter.read_replies())
    second = await anext(adapter.read_replies())
    assert (first.text + second.text) == mock_turn_chunks(1, 0, "")[0] + mock_turn_chunks(1, 0, "")[1]
    audio = _audio(bytes(6400))
    assert await adapter.send_feed(_frames(), audio) is True
    third = await anext(adapter.read_replies())
    fourth = await anext(adapter.read_replies())
    assert "audio_bytes=6400" in (third.text + fourth.text)
    adapter.offer_text("only text")
    assert await adapter.send_feed(_frames(), _audio()) is False


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
    second = await anext(adapter.read_replies())
    combined = first.text + second.text
    assert "first" in combined
    assert "second" not in combined
    assert await adapter.send_feed(_frames(1.0), _audio()) is True
    third = await anext(adapter.read_replies())
    fourth = await anext(adapter.read_replies())
    assert "second" in (third.text + fourth.text)


@pytest.mark.usefixtures("no_network")
async def test_bounded_reply_queue_and_close_clears_text() -> None:
    adapter = MockAdapter(SPEC, {"latency_ms": 0})
    await adapter.open()
    for _ in range(32):
        assert await adapter.send_feed(_frames(0.0), _audio()) is True
    assert adapter._replies.full()
    assert adapter._replies.qsize() == 64
    adapter.offer_text("remembered")
    await adapter.close()
    first = await anext(adapter.read_replies())
    second = await anext(adapter.read_replies())
    assert adapter._replies.qsize() == 62
    assert await adapter.send_feed(_frames(2.0), _audio()) is True
    third = await anext(adapter.read_replies())
    fourth = await anext(adapter.read_replies())
    combined = third.text + fourth.text
    assert "remembered" not in combined
    assert first.final is False
    assert second.final is True
