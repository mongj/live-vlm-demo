"""E2: SPOT-Bench Detection (ABD, PNR) on Modal with the official SPOT inference harness.

  modal run scripts/spot_modal.py --system joyai --shards 16
  modal run scripts/spot_modal.py --system joyai-greedy --shards 16
  modal run scripts/spot_modal.py --system minicpm --shards 16
  modal run scripts/spot_modal.py --system joyai --limit-videos 4 --tasks ABD   # pilot

Needs the SPOT data in the `live-vlm-bench-data` Volume (scripts/bench_data_modal.py).

Systems:
  joyai         the app's JoyAI stack (joyai_modal.start_stack, release checkpoint) with
                KEEP_QA_HISTORY=false as SPOT's instructions set; SPOT's JoyAI_VL wrapper
                talks to its adapter over localhost. The adapter ignores the wrapper's
                per-request decoding settings by default, so it samples (T=0.8).
  joyai-greedy  same, with HONOR_INBOUND_GENERATION_PARAMS=true, so the wrapper's
                detection settings apply (temperature 0, max_tokens 4).
  minicpm       SPOT's MiniCPM_o wrapper, which loads the checkpoint in-process
                (duplex, audio off, greedy for detection), in the app's MiniCPM image.

Shards split each task's videos; the merged traces are scored with SPOT's score.py
and copied to logs/spot/<run-name>/.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import modal

import joyai_modal
import minicpm_modal
from modal_common import GPU_TYPES, MINUTES, gpu_info, wait_http

SPOT_REPO = "https://github.com/dibschat/SPOT-Bench.git"
SPOT_COMMIT = "a88b9e86b6d1ddd238f7203ed6d50cbd258dd8fe"
SPOT_ROOT = "/opt/SPOT-Bench"
DATA = "/data/spot"
RESULTS = "/results"
ROOT = Path(__file__).resolve().parent.parent
MODEL_NAMES = {"joyai": "JoyAI_VL", "joyai-greedy": "JoyAI_VL", "minicpm": "MiniCPM_o"}
JOYAI_ENV = {
    "joyai": {"KEEP_QA_HISTORY": "false"},
    "joyai-greedy": {"KEEP_QA_HISTORY": "false", "HONOR_INBOUND_GENERATION_PARAMS": "true"},
}

data = modal.Volume.from_name("live-vlm-bench-data", create_if_missing=True)
results = modal.Volume.from_name("live-vlm-bench-results", create_if_missing=True)


def with_spot(image: modal.Image, *packages: str) -> modal.Image:
    # decord 0.6.0 ships a py3-none wheel; SPOT's other client needs are requests/pillow.
    return (image.apt_install("git", "ffmpeg")
            .pip_install("decord==0.6.0", "requests", "pillow", "tqdm", *packages)
            .run_commands(f"git clone {SPOT_REPO} {SPOT_ROOT}",
                          f"git -C {SPOT_ROOT} checkout --detach {SPOT_COMMIT}"))


joyai_image = with_spot(joyai_modal.base_image).add_local_python_source(
    "modal_common", "joyai_modal", "minicpm_modal")
minicpm_image = with_spot(minicpm_modal.image).add_local_python_source("joyai_modal", "minicpm_modal")

app = modal.App("live-vlm-spot")


def run_shard(system: str, task: str, run_name: str, shard: int, keys: list[str]) -> dict:
    out = f"{RESULTS}/{run_name}/{task}/shard-{shard:03d}"
    Path(out).mkdir(parents=True, exist_ok=True)
    started = time.time()
    info = {"system": system, "task": task, "shard": shard, "videos": len(keys), "device": gpu_info()}
    annotations = json.loads(Path(f"{DATA}/{task.lower()}.json").read_text())
    subset = ({k: annotations[k] for k in keys} if isinstance(annotations, dict)
              else [annotations[int(k)] for k in keys])
    sub_path = Path(f"/tmp/{task.lower()}-{shard:03d}.json")
    sub_path.write_text(json.dumps(subset))
    command = ["python", "inference.py", "--task", task, "--model", MODEL_NAMES[system],
               "--annotation_path", str(sub_path), "--video_root", f"{DATA}/videos",
               "--result_dir", out, "--resume"]
    env = dict(os.environ)
    stack = None
    try:
        if system.startswith("joyai"):
            stack = joyai_modal.start_stack(JOYAI_ENV[system])
            wait_http(f"http://127.0.0.1:{joyai_modal.ADAPTER_PORT}/health", stack.procs[-1],
                      "adapter", 10 * MINUTES)
            info["settings"] = stack.settings
            env["JOYAI_VL_API_BASE"] = f"http://127.0.0.1:{joyai_modal.ADAPTER_PORT}/v1"
        else:
            command += ["--model_path", minicpm_modal.ensure_model("bf16")]
        info["boot_s"] = round(time.time() - started, 1)
        subprocess.run(command, cwd=SPOT_ROOT, env=env, check=True)
    finally:
        if stack is not None:
            stack.stop()
        results.commit()
    info["wall_s"] = round(time.time() - started, 1)
    return info


@app.function(image=joyai_image, gpu=GPU_TYPES["H100"], cpu=8, memory=64 * 1024, timeout=24 * 3600,
              volumes={joyai_modal.MODEL_ROOT: joyai_modal.models, "/root/.cache": joyai_modal.cache,
                       "/data": data, RESULTS: results})
def joyai_shard(system: str, task: str, run_name: str, shard: int, keys: list[str]) -> dict:
    return run_shard(system, task, run_name, shard, keys)


@app.function(image=minicpm_image, gpu=GPU_TYPES["H100"], cpu=8, memory=64 * 1024, timeout=24 * 3600,
              volumes={minicpm_modal.MODEL_ROOT: minicpm_modal.models,
                       minicpm_modal.CACHE_ROOT: minicpm_modal.cache, "/data": data, RESULTS: results})
def minicpm_shard(system: str, task: str, run_name: str, shard: int, keys: list[str]) -> dict:
    return run_shard(system, task, run_name, shard, keys)


@app.function(image=minicpm_image, cpu=4, memory=16 * 1024, timeout=3600,
              volumes={"/data": data, RESULTS: results})
def plan(tasks: list[str], shards: int, limit_videos: int) -> dict[str, list[list[str]]]:
    """Split each task's videos into shards, balanced by video duration."""
    import decord

    out = {}
    for task in tasks:
        annotations = json.loads(Path(f"{DATA}/{task.lower()}.json").read_text())
        keys = list(annotations) if isinstance(annotations, dict) else [str(i) for i in range(len(annotations))]
        if limit_videos:
            keys = keys[:limit_videos]
        cost = {}
        for k in keys:
            entry = annotations[k] if isinstance(annotations, dict) else annotations[int(k)]
            video = entry.get("video") or entry.get("video_id") or k
            path = Path(f"{DATA}/videos/{Path(str(video)).stem}.mp4")
            try:
                reader = decord.VideoReader(str(path))
                cost[k] = len(reader) / (reader.get_avg_fps() or 30.0)
            except Exception:
                cost[k] = 60.0
        buckets: list[list[str]] = [[] for _ in range(min(shards, len(keys)))]
        load = [0.0] * len(buckets)
        for k in sorted(keys, key=cost.get, reverse=True):
            i = load.index(min(load))
            buckets[i].append(k)
            load[i] += cost[k]
        out[task] = buckets
        print(task, len(keys), "videos,", round(sum(cost.values()) / 3600, 2), "h")
    return out


@app.function(image=minicpm_image, cpu=4, memory=16 * 1024, timeout=3600,
              volumes={"/data": data, RESULTS: results})
def score(system: str, tasks: list[str], run_name: str) -> str:
    """Merge shard traces per task and run SPOT's detection scorer."""
    run = Path(RESULTS) / run_name
    model = MODEL_NAMES[system]
    merged_dir = run / "merged"
    merged_dir.mkdir(parents=True, exist_ok=True)
    for task in tasks:
        merged: dict = {}
        for fp in sorted((run / task).glob(f"shard-*/{task}_{model}.json")):
            merged.update(json.loads(fp.read_text()))
        (merged_dir / f"{task}_{model}.json").write_text(json.dumps(merged, indent=1))
    proc = subprocess.run(["python", "score.py", "--tasks", *tasks, "--model", model,
                           "--result_dir", str(merged_dir), "--annotation_root", DATA,
                           "--dump_matches"],
                          cwd=SPOT_ROOT, capture_output=True, text=True)
    (run / "score.txt").write_text(proc.stdout + "\n" + proc.stderr)
    results.commit()
    return proc.stdout + proc.stderr[-2000:]


@app.local_entrypoint()
def main(system: str, tasks: str = "ABD,PNR", shards: int = 16, run_name: str = "",
         limit_videos: int = 0) -> None:
    if system not in MODEL_NAMES:
        raise SystemExit(f"--system must be one of {', '.join(MODEL_NAMES)}")
    task_list = [t.strip().upper() for t in tasks.split(",") if t.strip()]
    run_name = run_name or f"spot-{system}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}"
    buckets = plan.remote(task_list, shards, limit_videos)
    fn = joyai_shard if system.startswith("joyai") else minicpm_shard
    calls = [fn.spawn(system, task, run_name, i, keys)
             for task in task_list for i, keys in enumerate(buckets[task])]
    print(f"{system}: {len(calls)} shards, run {run_name}")
    infos = []
    for call in calls:
        try:
            infos.append(call.get())
        except Exception as exc:
            infos.append({"error": f"{type(exc).__name__}: {exc}"})
        print(infos[-1], flush=True)
    print(score.remote(system, task_list, run_name))
    local = ROOT / "logs" / "spot" / run_name
    local.mkdir(parents=True, exist_ok=True)
    (local / "shards.json").write_text(json.dumps(
        {"system": system, "spot_commit": SPOT_COMMIT, "shards": infos}, indent=2))
    subprocess.run(["modal", "volume", "get", "--force", "live-vlm-bench-results",
                    f"{run_name}/", str(local)], check=False)
    print(f"Results: {local}")
