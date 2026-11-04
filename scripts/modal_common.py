"""Shared pieces of the Modal model stacks and their benchmarks.

Images that import this module at container start add it with
`.add_local_python_source("modal_common")`.
"""

from __future__ import annotations

import statistics
import subprocess
import threading
import time
import urllib.request
from dataclasses import dataclass, field

MINUTES = 60

GPU_TYPES = {
    "H100": "H100!",  # "!" stops Modal from upgrading the request to an H200.
    "H200": "H200",
    "B200": "B200",
    "B300": "B300",
}


def gpu_info() -> str:
    """nvidia-smi "name, memory.total [MiB], compute_cap" for the one visible GPU."""
    return subprocess.run(
        ["nvidia-smi", "--query-gpu=name,memory.total,compute_cap", "--format=csv,noheader"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def wait_http(url: str, proc: subprocess.Popen[bytes], name: str, timeout: float,
              ready=lambda body: True) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"{name} exited with {proc.returncode} before becoming ready")
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if ready(response.read()):
                    print(f"{name} ready", flush=True)
                    return
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError(f"timed out waiting for {name}")


class Phases:
    """Wall-clock seconds per startup phase, in order."""

    def __init__(self) -> None:
        self.durations: dict[str, float] = {}
        self._mark = time.monotonic()

    def __call__(self, name: str) -> None:
        now = time.monotonic()
        self.durations[name] = round(now - self._mark, 3)
        self._mark = now


@dataclass
class Stack:
    gpu: str  # gpu_info()
    procs: list[subprocess.Popen[bytes]]
    phases: dict[str, float]
    settings: dict = field(default_factory=dict)  # model/precision/memory knobs, logged

    def stop(self) -> None:
        for proc in reversed(self.procs):
            proc.terminate()
        for proc in self.procs:
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()


class VramSampler:
    """Samples GPU memory in use (MiB, all processes) on a background thread."""

    def __init__(self, interval: float = 0.25) -> None:
        self.interval = interval
        self.samples: list[tuple[float, int]] = []  # (unix time, MiB used)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                capture_output=True, text=True,
            ).stdout.strip()
            if out.isdigit():
                self.samples.append((time.time(), int(out)))
            self._stop.wait(self.interval)

    def __enter__(self) -> "VramSampler":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join()

    def peak_between(self, start: float, end: float) -> int | None:
        values = [mib for t, mib in self.samples if start <= t <= end]
        return max(values) if values else None


def stats(values: list[float]) -> dict:
    values = sorted(v for v in values if v is not None)
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "median": round(statistics.median(values), 4),
        "p90": round(values[min(len(values) - 1, int(0.9 * len(values)))], 4),
        "min": round(values[0], 4),
        "max": round(values[-1], 4),
    }
