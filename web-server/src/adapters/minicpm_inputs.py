"""Bounded input buffers, separate from MiniCPM's live-audio jitter buffer."""
from collections import deque
from dataclasses import dataclass
import math
import struct
from uuid import uuid4

from ..types import SessionError


class TypedAudioQueue:
    def __init__(self):
        self.request_id = None
        self.pcm = b""
        self.offset = 0
        self.ready = False

    @property
    def busy(self): return self.request_id is not None

    def begin(self, request_id: str):
        if self.busy: raise SessionError("A typed instruction is already being sent", fatal=False)
        self.request_id, self.pcm, self.offset, self.ready = request_id, b"", 0, False

    def install(self, request_id: str, pcm: bytes):
        if request_id != self.request_id: return False
        if not pcm or len(pcm) % 2 or len(pcm) > 960000:
            raise SessionError("Typed speech must fit within 30 seconds", fatal=False)
        self.pcm, self.ready = pcm, True
        return True

    def next_packet(self):
        if not self.ready: return None
        packet = self.pcm[self.offset:self.offset + 32000]
        self.offset += len(packet)
        if self.offset == len(self.pcm): self.cancel()
        return packet + bytes(32000 - len(packet))

    def cancel(self):
        self.request_id, self.pcm, self.offset, self.ready = None, b"", 0, False


@dataclass(frozen=True)
class SegmentUpdate:
    utterance_id: str
    revision: int
    final: bool
    pcm: bytes


class MicrophoneSegmenter:
    def __init__(self):
        self.generation = -1
        self.sequence = -1
        self._clear()

    def _clear(self):
        self.preroll = deque(maxlen=3)
        self.audio = bytearray()
        self.hot_samples = self.silent_samples = self.last_update = 0
        self.utterance_id = None
        self.revision = 0

    def reset(self, generation: int):
        self.generation, self.sequence = generation, -1
        self._clear()

    def offer(self, pcm: bytes, *, generation: int, sequence: int) -> list[SegmentUpdate]:
        if generation < self.generation or (generation == self.generation and sequence <= self.sequence): return []
        if generation != self.generation:
            self.reset(generation)
        elif self.sequence >= 0 and sequence != self.sequence + 1:
            self._clear()
        self.sequence = sequence
        if not pcm: return []
        samples = len(pcm) // 2
        rms = math.sqrt(sum(x*x for (x,) in struct.iter_unpack('<h', pcm)) / samples) / 32768
        hot = rms >= .015
        updates = []
        if self.utterance_id is None:
            self.preroll.append(pcm)
            self.hot_samples = self.hot_samples + samples if hot else 0
            if self.hot_samples < 3200: return []
            self.utterance_id = "v-" + uuid4().hex
            self.audio.extend(b''.join(self.preroll))
            self.last_update = len(self.audio)
            updates.append(SegmentUpdate(self.utterance_id, 0, False, b""))
        else:
            self.audio.extend(pcm)
        self.silent_samples = 0 if hot else self.silent_samples + samples
        final = self.silent_samples >= 9600 or len(self.audio) >= 480000
        if final or len(self.audio) - self.last_update >= 64000:
            self.revision += 1
            updates.append(SegmentUpdate(self.utterance_id, self.revision, final, bytes(self.audio[:480000])))
            self.last_update = len(self.audio)
            if final: self._clear()
        return updates
