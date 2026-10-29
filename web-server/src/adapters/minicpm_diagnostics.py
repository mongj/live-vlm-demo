"""Bounded, content-free observations; never part of assistant turn state."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from typing import Any

from ..types import Reply

logger = logging.getLogger(__name__)
EVENTS = frozenset({"startup", "admission", "session_ready", "input_sent", "model_output",
                    "input_drop", "asr_complete", "asr_failed", "tts_complete", "tts_failed", "error", "closed"})
STAGES = frozenset({"connecting", "queued", "connected", "listening", "responding", "error", "closed"})
METRICS = frozenset({"prefill_ms", "generate_ms", "wall_clock_ms", "cost_llm_ms", "kv_cache_length",
                     "n_tokens", "n_tts_tokens", "vision_slices", "vision_tokens"})


def _number(value: Any) -> bool:
    # Also cap integers to the browser's exact numeric range; enormous JSON
    # integers must neither overflow math.isfinite nor become Infinity in JS.
    return type(value) in (int, float) and 0 <= value <= 9007199254740991 and math.isfinite(value)


class MiniCPMDiagnostics:
    def __init__(self) -> None:
        self.started = time.monotonic()
        self.stage = "connecting"
        self.input = {"packets": 0, "frames": 0, "audio_ms": 0.0, "dropped_audio_ms": 0.0}
        self.output_counts = {"text_chunks": 0, "audio_chunks": 0, "audio_ms": 0.0}
        self.speech: dict[str, Any] = {"transcription": False, "typed_input": False}
        self.metrics: dict[str, int | float] = {}
        self.chunk_index: int | float | None = None
        self._input_sequence = 0
        self._inputs: dict[str, dict[str, Any]] = {}
        self._native: dict[str, Any] | None = None
        self._listen_events = 0
        self._listen_streak = 0
        self._last_content_at: float | None = None
        self._last_emit = -math.inf

    def register_input(self, *, audio_bytes: int, frames: int, force_source: str) -> str:
        """Bounded metadata keyed by the protocol's echoed input_id; no media.

        Register before awaiting send so a fast response cannot race the mapping.
        Age starts before send, therefore includes transport/queue/model time.
        This is not a native receipt timestamp or an inference-only latency.
        """
        if force_source not in {"none", "typed", "microphone"}:
            raise ValueError("Unknown force-listen source")
        self._input_sequence += 1
        input_id = f"diag-{self._input_sequence}"
        self._inputs[input_id] = {
            "input_sequence": self._input_sequence, "input_frames": frames,
            "input_audio_ms": audio_bytes / 32, "force_listen": force_source != "none",
            "force_source": force_source, "sent_at": time.monotonic(),
        }
        if len(self._inputs) > 256:
            del self._inputs[next(iter(self._inputs))]
        return input_id

    def sent(self, *, audio_bytes: int, frames: int, force_listen: bool | None = None) -> None:
        # 16 kHz signed16 PCM supplied by the client/TTS, BEFORE packet padding.
        # Silence supplied by the client still counts; this is not speech time.
        self.input["packets"] += 1
        self.input["frames"] += frames
        self.input["audio_ms"] += audio_bytes / 32
        # Last successfully sent packet, not native receipt or processing state.
        # Optional so older callers/snapshots do not invent a control decision.
        if type(force_listen) is bool:
            self.input["last_force_listen"] = force_listen
            self.input["forced_listen_packets"] = self.input.get("forced_listen_packets", 0) + int(force_listen)

    def dropped(self, audio_bytes: int) -> None:
        # Adapter jitter overflow only; browser/shared-buffer loss is not observed here.
        self.input["dropped_audio_ms"] += audio_bytes / 32

    def output(self, kind: str, event: dict[str, Any], *, audio_bytes: int = 0) -> None:
        if kind not in {"listen", "text", "audio"}:
            return
        now = time.monotonic()
        if kind == "listen":
            self._listen_events += 1
            self._listen_streak += 1
        else:
            self._listen_streak = 0
            self._last_content_at = now
        input_id = event.get("input_id")
        matched = self._inputs.get(input_id) if isinstance(input_id, str) else None
        self._native = {"kind": kind, "matched": matched is not None,
                        "listen_events": self._listen_events, "listen_streak": self._listen_streak}
        if matched is not None:
            self._native.update({key: value for key, value in matched.items() if key != "sent_at"})
            self._native["input_age_ms"] = max(0.0, (now - matched["sent_at"]) * 1000)
        self.stage = "listening" if kind == "listen" else "responding"
        if kind == "text": self.output_counts["text_chunks"] += 1
        if kind == "audio":
            self.output_counts["audio_chunks"] += 1
            self.output_counts["audio_ms"] += audio_bytes / 48  # 24 kHz signed16
        reported = event.get("metrics")
        if isinstance(reported, dict):
            # Last actual report, not fabricated or accumulated processing times.
            self.metrics = {key: value for key, value in reported.items() if key in METRICS and _number(value)}
        index = event.get("chunk_index")
        if _number(index): self.chunk_index = index

    def helper(self, kind: str, started: float) -> None:
        self.speech[f"{kind}_ms"] = max(0.0, (time.monotonic() - started) * 1000)

    def snapshot(self, event: str, *, stage: str | None = None) -> dict[str, Any]:
        if event not in EVENTS or (stage is not None and stage not in STAGES):
            raise ValueError("Unknown MiniCPM diagnostic label")
        if stage is not None: self.stage = stage
        result: dict[str, Any] = {
            "version": 1, "event": event, "elapsed_ms": max(0.0, (time.monotonic() - self.started) * 1000),
            "stage": self.stage, "input": dict(self.input), "output": dict(self.output_counts), "speech": dict(self.speech),
        }
        if self.metrics: result["metrics"] = dict(self.metrics)
        if self.chunk_index is not None: result["chunk_index"] = self.chunk_index
        if self._native is not None:
            result["native"] = dict(self._native)
            if self._last_content_at is not None:
                result["native"]["since_content_ms"] = max(0.0, (time.monotonic() - self._last_content_at) * 1000)
        return result

    def emit(self, queue: asyncio.Queue[Any], event: str, *, stage: str | None = None,
             force: bool = False, now: float | None = None) -> bool:
        if stage is not None:
            if stage not in STAGES: raise ValueError("Unknown MiniCPM diagnostic label")
            self.stage = stage
        current = time.monotonic() if now is None else now
        if not force and current - self._last_emit < 1:
            return False
        if queue.full(): return False
        snapshot = self.snapshot(event)
        try:
            queue.put_nowait(Reply(diagnostic=snapshot))
        except asyncio.QueueFull:
            return False
        self._last_emit = current
        logger.debug("MiniCPM diagnostic %s", json.dumps(snapshot, separators=(",", ":"), allow_nan=False))
        return True
