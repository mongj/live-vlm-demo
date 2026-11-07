"""Bounded input buffers, separate from MiniCPM's live-audio jitter buffer."""
from collections import deque
from dataclasses import dataclass
import math
import re
import struct
from uuid import uuid4

from ..types import SessionError

_STOP_WORDS = frozenset("stop pause wait quiet silence enough hush".split())
_STOP_PHRASES = ("hold on", "shut up")
_STOP_EXTRAS = frozenset("a be counting hey hold it just minute moment no now ok okay on please right second shut talking that the up wrong you".split())


def is_stop_request(text: str) -> bool:
    """True only for short speech made entirely of stop words, so "wait, tell me the story" stays a request."""
    words = re.findall(r"[a-z']+", text.lower())
    if not 1 <= len(words) <= 8 or any(word not in _STOP_WORDS and word not in _STOP_EXTRAS for word in words):
        return False
    return any(word in _STOP_WORDS for word in words) or any(phrase in " ".join(words) for phrase in _STOP_PHRASES)


_NUMBER_WORDS = frozenset("zero no one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
                          "sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred".split())


_NUMBER_PATTERN = re.compile("|".join(sorted(_NUMBER_WORDS, key=len, reverse=True)))


def sentence_shape(sentence: str) -> str:
    """A sentence's letters without numbers, spaces or s, so "Two fingers." and "One finger." match.

    Some sessions lose the spaces between words, so this cannot rely on them.
    """
    return _NUMBER_PATTERN.sub("", re.sub(r"[^a-z]", "", sentence.lower())).replace("s", "")


class ReplyController:
    """Turn-taking rules applied through force_listen and the per-input listen scale.

    Voice stop and the reply push act only on transcribed speech. The run-on guard reads the model's own text.
    """

    def __init__(self, *, voice_stop: bool, request_scale: float, request_window: float,
                 runon_guard: bool = False, runon_quiet: float = 8.0):
        self.voice_stop = voice_stop
        self.request_scale = request_scale
        self.request_window = request_window
        self.runon_guard = runon_guard
        self.runon_quiet = runon_quiet
        self.held = False
        self.request_until = float("-inf")
        self.quiet_until = float("-inf")
        self.reply_end_shape: str | None = None
        self.partial = ""

    def heard(self, text: str, final: bool, now: float) -> None:
        if not text.strip():
            return
        if self.voice_stop and is_stop_request(text):
            self.held = True
            self.request_until = float("-inf")
            return
        if final:
            self.held = False
            self.quiet_until = float("-inf")
        if not self.held:
            self.request_until = now + self.request_window

    def model_spoke(self) -> None:
        self.request_until = float("-inf")

    def model_said(self, text: str, now: float) -> None:
        """Ends a turn that keeps repeating one sentence pattern, such as an endless count."""
        self.model_spoke()
        if not self.runon_guard:
            return
        self.partial += text
        while (match := re.search(r"[.?!](\s|$|(?=[A-Z]))", self.partial)):
            sentence, self.partial = self.partial[:match.end()], self.partial[match.end():]
            shape = sentence_shape(sentence)
            if shape == self.reply_end_shape:
                self.quiet_until = now + self.runon_quiet
            self.reply_end_shape = shape

    def reply_ended(self) -> None:
        self.reply_end_shape = None
        self.partial = ""

    def force_source(self, now: float) -> str | None:
        return "stop" if self.held else "runon" if now < self.quiet_until else None

    def listen_scale(self, now: float) -> float | None:
        return self.request_scale if self.request_scale != 1.0 and now < self.request_until else None


class MicrophoneActivity:
    """Content-free, bounded native interruption; independent of ASR results."""
    def __init__(self):
        self.generation = self.sequence = -1
        self.clear()

    def clear(self):
        self.hot_samples = self.quiet_samples = 0
        self.history = deque()
        self.window_samples = self.window_energy = 0
        self.active = False
        self.last_packet = self.pending_until = float('-inf')

    def offer(self, pcm: bytes, *, generation: int, sequence: int,
              enabled: bool, now: float) -> None:
        if generation < self.generation or (generation == self.generation and sequence <= self.sequence):
            return
        if generation != self.generation or sequence != self.sequence + 1 or not enabled:
            self.clear()
        self.generation, self.sequence = generation, sequence
        if not enabled or not pcm:
            return
        if now - self.last_packet > .75:
            self.hot_samples = self.quiet_samples = 0
            self.history.clear()
            self.window_samples = self.window_energy = 0
            self.active = False
        self.last_packet = now
        # Match browser qualification in 10ms windows. Packet-level RMS would
        # credit a short click as an entire 100ms block. Retain only statistics.
        for (sample,) in struct.iter_unpack('<h', pcm):
            self.window_energy += sample * sample
            self.window_samples += 1
            if self.window_samples < 160:
                continue
            rms = math.sqrt(self.window_energy / 160) / 32768
            self.window_samples = self.window_energy = 0
            # Match the browser: 200ms hot within the latest 30 x 10ms
            # windows. Retain classifications only, never microphone PCM.
            hot_samples = 160 if rms >= .045 else 0
            self.history.append(hot_samples)
            self.hot_samples += hot_samples
            if len(self.history) > 30:
                self.hot_samples -= self.history.popleft()
            if rms >= .045:
                self.quiet_samples = 0
                if self.hot_samples >= 3200:
                    self.active = True
                    # Short speech can finish before the next paced input tick.
                    self.pending_until = now + 2.0
            else:
                self.quiet_samples = min(4800, self.quiet_samples + 160)
                if self.quiet_samples >= 4800:
                    self.active = False

    def take_force_listen(self, now: float) -> bool:
        force = (self.active and now - self.last_packet <= .75) or now < self.pending_until
        self.pending_until = float('-inf')
        return force


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
