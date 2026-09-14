from __future__ import annotations

import pytest

from live_vlm_server.buffers import AudioBuffer, FrameBuffer
from live_vlm_server.types import SessionError, VideoFrame

MIN_JPEG = b"\xff\xd8\xff\xd9"


def test_frame_buffer_drops_oldest_and_keeps_newest() -> None:
    buffer = FrameBuffer(max_frames=1)
    buffer.push(VideoFrame(jpeg=MIN_JPEG, t=0.1))
    buffer.push(VideoFrame(jpeg=MIN_JPEG + b"\x00", t=0.2))
    buffer.push(VideoFrame(jpeg=MIN_JPEG + b"\x01", t=0.3))
    consumed = buffer.consume()
    assert len(consumed) == 1
    assert consumed[0].t == 0.3
    assert consumed[0].jpeg.endswith(b"\x01")
    assert buffer.consume() == []


def test_partial_batch_is_immediately_eligible() -> None:
    buffer = FrameBuffer(max_frames=8)
    buffer.push(VideoFrame(jpeg=MIN_JPEG, t=1.0))
    consumed = buffer.consume()
    assert len(consumed) == 1
    assert consumed[0].t == 1.0


def test_frame_overflow_preserves_capture_order() -> None:
    buffer = FrameBuffer(max_frames=2)
    buffer.push(VideoFrame(jpeg=MIN_JPEG, t=1.0))
    buffer.push(VideoFrame(jpeg=MIN_JPEG, t=2.0))
    buffer.push(VideoFrame(jpeg=MIN_JPEG, t=3.0))
    consumed = buffer.consume()
    assert [frame.t for frame in consumed] == [2.0, 3.0]


def test_audio_complete_slice_remainder_and_overflow() -> None:
    buffer = AudioBuffer(seconds_per_request=0.2, retention_seconds=1.0)
    assert buffer.slice_bytes == 6400
    assert buffer.capacity_bytes == 32_000
    assert buffer.consume() is None
    buffer.push(bytes(1000))
    assert buffer.consume() is None
    assert len(buffer) == 1000
    buffer.push(bytes(5400))
    first = buffer.consume()
    assert first is not None
    assert len(first) == 6400
    assert len(buffer) == 0
    buffer.push(bytes(8000))
    second = buffer.consume()
    assert second is not None
    assert len(second) == 6400
    assert len(buffer) == 1600
    buffer.push(bytes(32_000))
    assert len(buffer) == 32_000
    third = buffer.consume()
    assert third is not None
    assert len(third) == 6400
    assert len(buffer) == 32_000 - 6400


def test_audio_overflow_keeps_sample_alignment() -> None:
    buffer = AudioBuffer(seconds_per_request=0.2, retention_seconds=1.0)
    buffer.push(bytes(32_002))
    assert len(buffer) == 32_000
    assert len(buffer) % 2 == 0


def test_odd_pcm_is_rejected() -> None:
    buffer = AudioBuffer(seconds_per_request=0.2, retention_seconds=1.0)
    with pytest.raises(SessionError, match="even"):
        buffer.push(b"\x00")


def test_disabled_audio_never_retains_samples() -> None:
    buffer = AudioBuffer(seconds_per_request=0.0, retention_seconds=0.0)
    assert buffer.disabled is True
    buffer.push(bytes(6400))
    assert len(buffer) == 0
    assert buffer.consume() is None
