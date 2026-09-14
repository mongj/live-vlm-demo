from __future__ import annotations

from collections import deque

from .types import SessionError, VideoFrame

INBOUND_SAMPLE_RATE_HZ = 16_000
BYTES_PER_SAMPLE = 2


def seconds_to_samples(seconds: float) -> int:
    return int(seconds * INBOUND_SAMPLE_RATE_HZ)


class FrameBuffer:
    def __init__(self, max_frames: int) -> None:
        if max_frames < 0:
            raise ValueError("max_frames must be >= 0")
        self._max_frames = max_frames
        self._frames: deque[VideoFrame] = deque()

    def push(self, frame: VideoFrame) -> None:
        self._frames.append(frame)
        while len(self._frames) > self._max_frames:
            self._frames.popleft()

    def consume(self) -> list[VideoFrame]:
        frames = list(self._frames)
        self._frames.clear()
        return frames

    def clear(self) -> None:
        self._frames.clear()

    def __len__(self) -> int:
        return len(self._frames)


class AudioBuffer:
    def __init__(self, seconds_per_request: float, retention_seconds: float) -> None:
        if seconds_per_request < 0 or retention_seconds < 0:
            raise ValueError("audio durations must be >= 0")
        self._slice_samples = seconds_to_samples(seconds_per_request)
        self._capacity_samples = seconds_to_samples(retention_seconds)
        self._data = bytearray()

    @property
    def disabled(self) -> bool:
        return self._slice_samples == 0

    @property
    def slice_bytes(self) -> int:
        return self._slice_samples * BYTES_PER_SAMPLE

    @property
    def capacity_bytes(self) -> int:
        return self._capacity_samples * BYTES_PER_SAMPLE

    def push(self, pcm: bytes) -> None:
        if self.disabled:
            return
        if len(pcm) % BYTES_PER_SAMPLE != 0:
            raise SessionError("PCM must contain an even number of bytes", fatal=False)
        self._data.extend(pcm)
        overflow_samples = (len(self._data) // BYTES_PER_SAMPLE) - self._capacity_samples
        if overflow_samples > 0:
            del self._data[: overflow_samples * BYTES_PER_SAMPLE]

    def consume(self) -> bytes | None:
        if self.disabled:
            return None
        needed = self.slice_bytes
        if needed == 0 or len(self._data) < needed:
            return None
        result = bytes(self._data[:needed])
        del self._data[:needed]
        return result

    def clear(self) -> None:
        self._data.clear()

    def __len__(self) -> int:
        return len(self._data)
