"""Benchmark JoyAI webinfer on several Modal GPUs in parallel.

Run with `make joyai-modal-bench` (or `modal run scripts/joyai_modal_bench.py --gpus H100,B200`).
Each GPU gets its own container that boots the same stack as `joyai_modal.py`,
then replays a fixed session against the adapter on localhost, timing every turn
inside the container so network latency is excluded. One warm-up session is
discarded; the measured sessions follow.

Results go to logs/joyai-modal-bench/<UTC time>/:
  turns.jsonl   one row per turn, including the full adapter response
  boots.jsonl   one row per GPU: scheduling and startup phase times, GPU, versions, errors
  metrics/      Prometheus snapshots of both vLLM servers after every session
  summary.json  per-GPU medians (also printed)
"""

from __future__ import annotations

import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import modal

from joyai_bench_workload import WARMUP_TURNS, config, run_session, summarize
from joyai_modal import (
    ADAPTER_PORT,
    MAIN_PORT,
    MODEL_ROOT,
    SUMMARY_PORT,
    cache,
    image,
    models,
    start_stack,
)
from modal_common import GPU_TYPES, MINUTES, VramSampler, wait_http

ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT = ROOT / "logs" / "joyai-modal-bench"
BASE_URL = f"http://127.0.0.1:{ADAPTER_PORT}/v1"

app = modal.App("live-vlm-joyai-bench")
bench_image = image.add_local_python_source("joyai_modal", "joyai_bench_workload")


def scrape(port: int) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=10) as response:
        return response.read().decode()


@app.cls(
    image=bench_image,
    gpu=GPU_TYPES["H100"],  # replaced per call with with_options
    cpu=8,
    memory=64 * 1024,
    volumes={MODEL_ROOT: models, "/root/.cache": cache},
    timeout=60 * MINUTES,
)
class Bench:
    @modal.method()
    def run(self, label: str, sessions: int, turns: int, query_all: str = "") -> dict:
        import importlib.metadata as md

        started = time.monotonic()
        result: dict = {"gpu": label, "requested": GPU_TYPES[label], "turns": [], "metrics": {},
                        "container_started_unix": time.time(), "vram": {}}
        stack = None
        with VramSampler() as vram:
            try:
                stack = start_stack()
                wait_http(f"http://127.0.0.1:{ADAPTER_PORT}/health", stack.procs[-1], "adapter",
                          10 * MINUTES)
                result["boot"] = {**stack.phases, "total": round(time.monotonic() - started, 3)}
                result["device"] = stack.gpu
                result["settings"] = stack.settings
                result["versions"] = {p: md.version(p) for p in ("vllm", "torch", "transformers")}
                result["vram"]["after_load_mib"] = vram.samples[-1][1] if vram.samples else None
                for index in range(sessions + 1):
                    t_start = time.time()
                    result["turns"] += run_session(BASE_URL, label, index,
                                                   turns if index else WARMUP_TURNS,
                                                   query_all=query_all)
                    result["vram"][f"session{index}_peak_mib"] = vram.peak_between(t_start, time.time())
                    for name, port in (("main", MAIN_PORT), ("summary", SUMMARY_PORT)):
                        result["metrics"][f"session{index}-{name}"] = scrape(port)
            except Exception as exc:  # keep partial results from the other phases
                result["error"] = f"{type(exc).__name__}: {exc}"
            finally:
                if stack is not None:
                    stack.stop()
        result["vram"]["peak_mib"] = max((m for _, m in vram.samples), default=None)
        result["vram_samples"] = vram.samples
        return result


@app.local_entrypoint()
def main(gpus: str = "H100,H200,B200,B300", sessions: int = 3, turns: int = 30,
         query_all: str = "") -> None:
    labels = [g.strip().upper() for g in gpus.replace(" ", ",").split(",") if g.strip()]
    unknown = [g for g in labels if g not in GPU_TYPES]
    if unknown:
        raise SystemExit(f"unknown GPU(s) {unknown}; choose from {', '.join(GPU_TYPES)}")
    out = OUT_ROOT / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (out / "metrics").mkdir(parents=True)
    (out / "config.json").write_text(json.dumps(
        {"gpus": labels, **config(sessions, turns, query_all)}, indent=2))
    print(f"Benchmarking {', '.join(labels)} in parallel; writing to {out}")

    spawned = time.time()
    calls = {g: Bench.with_options(gpu=GPU_TYPES[g])().run.spawn(g, sessions, turns, query_all)
             for g in labels}
    summary = {}
    for label, call in calls.items():
        try:
            result = call.get()
        except Exception as exc:
            result = {"gpu": label, "turns": [], "metrics": {}, "error": f"{type(exc).__name__}: {exc}"}
        result["spawned_unix"] = spawned  # container_started_unix - spawned = scheduling + image load
        with open(out / "turns.jsonl", "a") as f:
            for row in result.pop("turns"):
                f.write(json.dumps(row) + "\n")
                summary.setdefault(label, []).append(row)
        for name, text in result.pop("metrics").items():
            (out / "metrics" / f"{label}-{name}.prom").write_text(text)
        with open(out / "boots.jsonl", "a") as f:
            f.write(json.dumps(result) + "\n")
        print(f"{label}: {'error: ' + result['error'] if 'error' in result else 'done'}")

    report = {label: {"boot": None, **summarize(rows)} for label, rows in summary.items()}
    for line in (out / "boots.jsonl").read_text().splitlines():
        boot = json.loads(line)
        if boot["gpu"] in report:
            report[boot["gpu"]]["boot"] = boot.get("boot")
    (out / "summary.json").write_text(json.dumps(report, indent=2))

    print(f"\n{'GPU':<6} {'boot s':>7} {'all':>8} {'query':>8} {'silent':>8} {'spoken':>8}  "
          f"session medians (s)   median latency, measured sessions")
    for label in labels:
        r = report.get(label)
        if r is None:
            print(f"{label:<6} no results")
            continue
        med = lambda k: f"{r[k]['median_s']:.3f}" if r[k]["n"] else "-"  # noqa: E731
        boot = f"{r['boot']['total']:.0f}" if r["boot"] else "-"
        print(f"{label:<6} {boot:>7} {med('all'):>8} {med('query'):>8} {med('frame_silent'):>8} "
              f"{med('frame_spoken'):>8}  {r['session_medians_s']}")
    print(f"\nFull logs: {out}")
