"""E4: InteractionBench on Modal, sharded across GPU containers, with the paper's runners.

  modal run scripts/interactionbench_modal.py --system joyai-preview --shards 20
  modal run scripts/interactionbench_modal.py --system minicpm-sliding --shards 20
  modal run scripts/interactionbench_modal.py --system joyai-release --limit-videos 4  # pilot

Systems (official InteractionBench code at IB_COMMIT; settings from its paper runs):
  joyai-preview   JoyAI-VL-Interaction-Preview, baselines/joyai/run.py, 4 fps, 448 px,
                  serve.sh options (max-model-len 262144, memory 0.65 + 0.20 of one B200)
  joyai-release   same, with the JoyAI-VL-Interaction release checkpoint that the app
                  serves; the checkpoint is the only difference
  minicpm-sliding MiniCPM-o 4.5 polled once per second, `ibench run --protocol sliding`

Each shard streams a disjoint set of videos and writes preds.jsonl to the Volume
`live-vlm-bench-results`; rerunning the same --run-name resumes. The merged
predictions are scored with `ibench eval --mcq-key --judge hf:Qwen/Qwen3-14B` and
copied to logs/interactionbench/<run-name>/.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import modal

import joyai_modal
import minicpm_modal
from modal_common import GPU_TYPES, MINUTES, gpu_info, wait_http

IB_REPO = "https://github.com/Espere-1119-Song/InteractionBench.git"
IB_COMMIT = "f1bf0a44410e5c76f277019549b5365403c492da"
IB_ROOT = "/opt/InteractionBench"
DATA = "/data/interactionbench"
RESULTS = "/results"
JUDGE = "hf:Qwen/Qwen3-14B"
ROOT = Path(__file__).resolve().parent.parent

JOYAI_CHECKPOINTS = {
    "joyai-preview": ("jdopensource/JoyAI-VL-Interaction-Preview",
                      "ad70e6f0ed63ec1a337bb1c67b82539b42f12d50", "JoyAI-VL-Interaction-Preview"),
    "joyai-release": (joyai_modal.MAIN_REPO, joyai_modal.MAIN_REVISION, "JoyAI-VL-Interaction"),
}
SYSTEMS = {"joyai-preview": "B200", "joyai-release": "B200", "minicpm-sliding": "H100"}

data = modal.Volume.from_name("live-vlm-bench-data", create_if_missing=True)
results = modal.Volume.from_name("live-vlm-bench-results", create_if_missing=True)


def with_ib(image: modal.Image) -> modal.Image:
    # IB's only base dependency is pillow; install without touching the model stack.
    return (image.apt_install("ffmpeg", "git")
            .run_commands(f"git clone {IB_REPO} {IB_ROOT}",
                          f"git -C {IB_ROOT} checkout --detach {IB_COMMIT}",
                          f"pip install --no-deps -e {IB_ROOT}"))


joyai_image = with_ib(joyai_modal.base_image).add_local_python_source("modal_common", "joyai_modal", "minicpm_modal")
minicpm_image = with_ib(minicpm_modal.image).add_local_python_source("joyai_modal", "minicpm_modal")

# The judge code needs a newer transformers (it passes `dtype=`) than MiniCPM's 4.51;
# resolve PyPI as of IB_COMMIT's date.
IB_DATE = "2026-10-21T16:22:31Z"
judge_image = with_ib(
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("torch==2.8.0", index_url="https://download.pytorch.org/whl/cu128")
    .uv_pip_install("transformers>=4.56,<5", "accelerate", "pillow", "huggingface_hub[hf_xet]",
                    extra_options=f"--exclude-newer {IB_DATE}")
).add_local_python_source("modal_common", "joyai_modal", "minicpm_modal")

app = modal.App("live-vlm-interactionbench")


def start_joyai_paper_stack(system: str) -> list[subprocess.Popen[bytes]]:
    """baselines/joyai/serve.sh (KERNEL=native) on one GPU, with the chosen checkpoint."""
    repo, revision, served = JOYAI_CHECKPOINTS[system]
    path = f"{joyai_modal.MODEL_ROOT}/{repo.split('/')[1]}"
    joyai_modal.ensure_model(repo, revision, path)
    joyai_modal.ensure_model(joyai_modal.SUMMARY_REPO, joyai_modal.SUMMARY_REVISION,
                             joyai_modal.SUMMARY_PATH)
    env = {**os.environ, "VLLM_USE_FLASHINFER_SAMPLER": "0"}
    summ = "Qwen3-VL-4B-Instruct"

    def vllm(model: str, name: str, port: int, fraction: str, max_len: str,
             extra: list[str]) -> list[str]:
        return ["python", "-m", "vllm.entrypoints.cli.main", "serve", model, "--port", str(port),
                "--max-model-len", max_len, "--served-model-name", name,
                "--gpu-memory-utilization", fraction, *extra]

    procs = [
        subprocess.Popen(vllm(path, served, 7060, "0.65", "262144", [
            "--enable-prefix-caching", "--enable-chunked-prefill",
            "--limit-mm-per-prompt", '{"image":2048,"video":1}']), env=env),
    ]
    wait_http("http://127.0.0.1:7060/v1/models", procs[0], "main vLLM", 30 * MINUTES)
    # Deviation from serve.sh: vLLM 0.22 reserves CUDA-graph memory and refuses a
    # 262144 context in 0.20 of a B200 (36 GiB KV needed, 23 GiB left). Summary
    # prompts are short memory-compression requests, so 131072 is ample.
    procs.append(subprocess.Popen(vllm(joyai_modal.SUMMARY_PATH, summ, 8065, "0.20", "131072", []),
                                  env=env))
    wait_http("http://127.0.0.1:8065/v1/models", procs[1], "summary vLLM", 30 * MINUTES)
    procs.append(subprocess.Popen([
        "python", f"{joyai_modal.WEBINFER}/live_adapter.py", "--host", "127.0.0.1", "--port", "8070",
        "--adapter-model", "streaming-infer-adapter",
        "--main-api-base", "http://127.0.0.1:7060/v1", "--main-model", served,
        "--summarizer-api-base", "http://127.0.0.1:8065/v1", "--summarizer-model", summ,
        "--longterm-model", summ], env=env, cwd=joyai_modal.WEBINFER))
    wait_http("http://127.0.0.1:8070/health", procs[2], "adapter", 10 * MINUTES)
    return procs


def run_shard(system: str, run_name: str, shard: int, item_ids: list[str]) -> dict:
    out = f"{RESULTS}/{run_name}/shard-{shard:03d}"
    started = time.time()
    info = {"system": system, "shard": shard, "items": len(item_ids), "device": gpu_info()}
    # Item ids go in a file: some video ids start with "-" and would parse as flags.
    items_file = Path(f"/tmp/shard-{shard:03d}.txt")
    items_file.write_text("\n".join(item_ids) + "\n")
    procs: list[subprocess.Popen[bytes]] = []
    try:
        if system.startswith("joyai"):
            procs = start_joyai_paper_stack(system)
            info["boot_s"] = round(time.time() - started, 1)
            command = ["python", f"{IB_ROOT}/baselines/joyai/run.py", "--data", DATA,
                       "--base", "http://127.0.0.1:8070/v1",
                       "--served-model", JOYAI_CHECKPOINTS[system][2],
                       "--sample-fps", "4", "--max-long-side", "448",
                       "--mcq", f"{DATA}/mcq/mcq_options_v4.jsonl", "--out", out,
                       "--items", str(items_file)]
            cwd = f"{IB_ROOT}/baselines/joyai"
        else:
            model_path = minicpm_modal.ensure_model("bf16")
            command = ["ibench", "run", "--model", "minicpm-o-4.5", "--model-path", model_path,
                       "--protocol", "sliding", "--mcq", "--data", DATA, "--out", out,
                       "--items", str(items_file)]
            cwd = IB_ROOT
        subprocess.run(command, cwd=cwd, check=True)
    finally:
        for proc in reversed(procs):
            proc.terminate()
        results.commit()
    info["wall_s"] = round(time.time() - started, 1)
    return info


@app.function(image=joyai_image, gpu=GPU_TYPES["B200"], cpu=8, memory=64 * 1024, timeout=24 * 3600,
              volumes={joyai_modal.MODEL_ROOT: joyai_modal.models, "/root/.cache": joyai_modal.cache,
                       "/data": data, RESULTS: results})
def joyai_shard(system: str, run_name: str, shard: int, item_ids: list[str]) -> dict:
    return run_shard(system, run_name, shard, item_ids)


@app.function(image=minicpm_image, gpu=GPU_TYPES["H100"], cpu=8, memory=64 * 1024, timeout=24 * 3600,
              volumes={minicpm_modal.MODEL_ROOT: minicpm_modal.models, minicpm_modal.CACHE_ROOT: minicpm_modal.cache,
                       "/data": data, RESULTS: results})
def minicpm_shard(system: str, run_name: str, shard: int, item_ids: list[str]) -> dict:
    return run_shard(system, run_name, shard, item_ids)


@app.function(image=judge_image, gpu=GPU_TYPES["H100"], cpu=8, memory=64 * 1024, timeout=12 * 3600,
              volumes={"/data": data, RESULTS: results, "/root/.cache/huggingface": minicpm_modal.cache})
def evaluate(run_name: str) -> str:
    """Merge shard predictions and score them with the paper's judge."""
    run = Path(RESULTS) / run_name
    lines = []
    for preds in sorted(run.glob("shard-*/preds.jsonl")):
        lines += [l for l in preds.read_text().splitlines() if l.strip()]
    (run / "preds.jsonl").write_text("\n".join(lines) + "\n")
    subprocess.run(["ibench", "eval", str(run / "preds.jsonl"), "--data", DATA, "--mcq-key",
                    "--judge", JUDGE, "--judge-cache", str(run / "judge_cache.jsonl"),
                    "--out", str(run / "eval")], cwd=IB_ROOT, check=True)
    results.commit()
    return f"{len(lines)} predictions scored"


def shard_items(shards: int, limit_videos: int) -> list[list[str]]:
    """Item ids per shard, whole videos per shard, balanced by streamed seconds
    (A items stop 10 s after their question)."""
    items = [json.loads(l) for l in (Path(os.environ["IB_ITEMS"])).read_text().splitlines() if l.strip()]
    cost: dict[str, float] = {}
    by_video: dict[str, list[str]] = {}
    for it in items:
        d = float(it["duration_s"])
        span = min(d, float(it.get("question_time_s") or 0) + 10) if it["time_type"] == "A" else d
        cost[it["video_id"]] = cost.get(it["video_id"], 0.0) + span
        by_video.setdefault(it["video_id"], []).append(it["item_id"])
    ordered = sorted(cost, key=cost.get, reverse=True)
    if limit_videos:
        ordered = sorted(cost, key=cost.get)[:limit_videos]  # pilot: shortest videos
    buckets: list[list[str]] = [[] for _ in range(min(shards, len(ordered)))]
    load = [0.0] * len(buckets)
    for vid in ordered:
        i = load.index(min(load))
        buckets[i] += by_video[vid]
        load[i] += cost[vid]
    return buckets


@app.local_entrypoint()
def main(system: str, shards: int = 20, run_name: str = "", limit_videos: int = 0,
         skip_eval: bool = False, eval_only: bool = False) -> None:
    if system not in SYSTEMS:
        raise SystemExit(f"--system must be one of {', '.join(SYSTEMS)}")
    run_name = run_name or f"{system}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}"
    if "IB_ITEMS" not in os.environ:
        raise SystemExit("set IB_ITEMS to a local copy of interactionbench/items.jsonl")
    buckets = [] if eval_only else shard_items(shards, limit_videos)
    print(f"{system}: {len(buckets)} shards, run {run_name}")
    fn = joyai_shard if system.startswith("joyai") else minicpm_shard
    calls = [fn.spawn(system, run_name, i, ids) for i, ids in enumerate(buckets)]
    infos = []
    for call in calls:
        try:
            infos.append(call.get())
        except Exception as exc:
            infos.append({"error": f"{type(exc).__name__}: {exc}"})
        print(infos[-1], flush=True)
    if not skip_eval:
        print(evaluate.remote(run_name))
    local = ROOT / "logs" / "interactionbench" / run_name
    local.mkdir(parents=True, exist_ok=True)
    if infos:
        (local / "shards.json").write_text(json.dumps(
            {"system": system, "ib_commit": IB_COMMIT, "judge": JUDGE, "shards": infos}, indent=2))
    subprocess.run(["modal", "volume", "get", "--force", "live-vlm-bench-results",
                    f"{run_name}/", str(local)], check=False)
    print(f"Results: {local}")
