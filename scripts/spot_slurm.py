#!/usr/bin/env python3
"""E2: SPOT-Bench Detection (ABD, PNR) on the SoC Slurm cluster with the official SPOT harness.

Layout on the cluster (WORK, default ~/spot-e2):
  SPOT-Bench/            harness at SPOT_COMMIT
  JoyAI-VL-Interaction/  webinfer at JOYAI_COMMIT
  envs/{joyai,minicpm}/  Python environments (build_envs.sh)
  models/                checkpoints at the Modal revisions (get_models.sh)
  data/                  abd.json, pnr.json, videos/
  runs/<run>/            shards, claims, traces, logs

  python3 spot_slurm.py submit --system joyai --run spot-joyai-1
  python3 spot_slurm.py status --run spot-joyai-1
  python3 spot_slurm.py score  --run spot-joyai-1

`submit` splits each task into shards and queues worker chains (one chain per GPU
type in WORKERS, each a run of 3 h jobs linked with afterany). A worker starts the
model stack once, then claims unfinished shards until its time is nearly up. SPOT
checkpoints after every video and resumes with --resume, so a job that hits its
time limit loses only the video in progress.

Systems:
  joyai         the JoyAI webinfer stack with KEEP_QA_HISTORY=false, as SPOT's
                instructions set; the adapter ignores the wrapper's decoding
                settings by default, so it samples (T=0.8).
  joyai-greedy  same, with HONOR_INBOUND_GENERATION_PARAMS=true (temperature 0).
  minicpm       SPOT's in-process MiniCPM_o wrapper.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

WORK = Path(os.environ.get("SPOT_WORK", Path.home() / "spot-e2"))
SPOT_COMMIT = "a88b9e86b6d1ddd238f7203ed6d50cbd258dd8fe"
JOYAI_COMMIT = "5519d35375d2f95ec1c30fa176b514bc158b1e15"
MODEL_NAMES = {"joyai": "JoyAI_VL", "joyai-greedy": "JoyAI_VL", "minicpm": "MiniCPM_o"}
JOYAI_ENV = {
    "joyai": {"KEEP_QA_HISTORY": "false"},
    "joyai-greedy": {"KEEP_QA_HISTORY": "false", "HONOR_INBOUND_GENERATION_PARAMS": "true"},
}
# Per-user GPU limits (QOS normal): h100-47 2, h100-96 1, h200-141 1, a100-80 1, a100-40 2.
# JoyAI gets one full GPU (both models share it, as on Modal) or two MIG slices
# (one model each); MiniCPM needs ~25 GB on one GPU.
WORKERS = {
    "joyai": ["h100-96:1", "h200-141:1", "h100-47:2"],
    "minicpm": ["a100-80:1", "a100-40:1", "a100-40:1"],
}
WORKERS["joyai-greedy"] = WORKERS["joyai"]
JOB_SECONDS = 3 * 3600
# Stop claiming new shards this long before the time limit.
CLAIM_MARGIN = 40 * 60
SERVED_MODEL_NAME = "JoyAI-VL-Interaction"


def run_dir(run: str) -> Path:
    return WORK / "runs" / run


def shard_done(shard: Path, model: str, task: str) -> bool:
    out = shard / "out"
    return (out / f"{task}_{model}.json").exists() and not (out / f"{task}_{model}.temp.json").exists()


def job_state(job_id: str) -> str:
    proc = subprocess.run(["squeue", "-h", "-j", job_id, "-o", "%T"], capture_output=True, text=True)
    return proc.stdout.strip()


# ---------------------------------------------------------------- submit


def submit(system: str, run: str, tasks: list[str], shards: int, chain: int, dry: bool) -> None:
    root = run_dir(run)
    if root.exists():
        raise SystemExit(f"{root} exists; pick another --run or use `resubmit`")
    for task in tasks:
        annotations = json.loads((WORK / "data" / f"{task.lower()}.json").read_text())
        # Video lengths are not known without decoding; the last annotated event is a
        # lower bound and good enough to balance shards.
        cost = {k: max([t["ask_time"] for t in e["turns"]] +
                       [x for t in e["turns"] for x in t["response_time"]])
                for k, e in annotations.items()}
        buckets: list[dict] = [{} for _ in range(min(shards, len(annotations)))]
        load = [0.0] * len(buckets)
        for k in sorted(annotations, key=cost.get, reverse=True):
            i = load.index(min(load))
            buckets[i][k] = annotations[k]
            load[i] += cost[k]
        for i, bucket in enumerate(buckets):
            shard = root / task / f"shard-{i:03d}"
            (shard / "out").mkdir(parents=True)
            (shard / "annotations.json").write_text(json.dumps(bucket))
        print(f"{task}: {len(annotations)} videos in {len(buckets)} shards, "
              f"~{sum(cost.values()) / 3600:.1f} h of video")
    (root / "logs").mkdir()
    (root / "run.json").write_text(json.dumps(
        {"system": system, "model": MODEL_NAMES[system], "tasks": tasks, "shards": shards,
         "spot_commit": SPOT_COMMIT, "joyai_commit": JOYAI_COMMIT,
         "joyai_env": JOYAI_ENV.get(system), "workers": WORKERS[system],
         "created": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, indent=2))
    queue_workers(system, run, chain, dry)


def queue_workers(system: str, run: str, chain: int, dry: bool) -> None:
    root = run_dir(run)
    for slot, gres in enumerate(WORKERS[system]):
        previous = ""
        for _ in range(chain):
            command = [
                "sbatch", "--parsable", "-p", "gpu,gpu-long", "-t", "3:00:00",
                f"--gres=gpu:{gres}", "-c", "8", "--mem=96G",
                "-J", f"e2-{system}-{slot}", "-o", str(root / "logs" / "%j.log"),
                *([f"--dependency=afterany:{previous}"] if previous else []),
                "--wrap", shlex.join([sys.executable, str(Path(__file__).resolve()),
                                      "worker", "--run", run]),
            ]
            if dry:
                print(shlex.join(command))
                continue
            previous = subprocess.run(command, check=True, capture_output=True,
                                      text=True).stdout.strip().split(";")[0]
            print(f"queued {previous} {gres}")


# ---------------------------------------------------------------- worker


def claim(root: Path, model: str, tasks: list[str], job_id: str) -> Path | None:
    for task in tasks:
        for shard in sorted((root / task).glob("shard-*")):
            if shard_done(shard, model, task):
                continue
            lock = shard / "claim"
            for _ in range(2):
                try:
                    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                except FileExistsError:
                    owner = lock.read_text().strip() if lock.exists() else ""
                    if owner and job_state(owner) == "RUNNING":
                        break
                    lock.unlink(missing_ok=True)  # stale: its job ended
                    continue
                os.write(fd, job_id.encode())
                os.close(fd)
                return shard
    return None


def wait_http(url: str, proc: subprocess.Popen, name: str, timeout: float) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"{name} exited with {proc.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=5):
                return
        except Exception:
            time.sleep(2)
    raise TimeoutError(f"{name} not ready after {timeout:.0f} s")


def joyai_ready(base: str, timeout: float) -> None:
    """The adapter answers /health before vLLM serves; wait for a real chat turn."""
    import base64
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (90, 90, 90)).save(buf, "JPEG")
    body = json.dumps({
        "model": SERVED_MODEL_NAME,
        "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {
            "url": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()}}]}],
        "frame_time_ranges": ["0.0 seconds"],
    }).encode()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            request = urllib.request.Request(
                f"{base}/chat/completions", data=body, method="POST",
                headers={"content-type": "application/json", "x-streaming-session": "ready-check"})
            with urllib.request.urlopen(request, timeout=60) as response:
                if json.loads(response.read()).get("choices"):
                    return
        except Exception:
            pass
        time.sleep(5)
    raise TimeoutError("JoyAI adapter never answered a chat turn")


def start_joyai(system: str, log_dir: Path, port_base: int) -> tuple[list[subprocess.Popen], dict, dict]:
    devices = [d for d in os.environ.get("CUDA_VISIBLE_DEVICES", "0").split(",") if d]
    models = WORK / "models"
    main_path, summary_path = models / "JoyAI-VL-Interaction", models / "Qwen3-VL-4B-Instruct"
    main_port, summary_port, adapter_port = port_base, port_base + 1, port_base + 2
    if len(devices) >= 2:
        # Two MIG slices (47 GB each): one model per slice.
        layout = {"main_device": devices[0], "summary_device": devices[1],
                  "main_util": "0.88", "summary_util": "0.88"}
    else:
        # One full GPU (>= 80 GB): the Modal split.
        layout = {"main_device": devices[0], "summary_device": devices[0],
                  "main_util": "0.6", "summary_util": "0.25"}
    webinfer = WORK / "JoyAI-VL-Interaction" / "services" / "webinfer"
    frames = Path(f"/tmp/joyai-frames-{os.environ.get('SLURM_JOB_ID', 'local')}")
    frames.mkdir(parents=True, exist_ok=True)
    env_bin = WORK / "envs" / "joyai" / "bin"
    base_env = {**os.environ, "PATH": f"{env_bin}:{os.environ['PATH']}",
                "HF_HUB_OFFLINE": "1", "VLLM_CACHE_ROOT": str(WORK / "cache" / "vllm")}

    def vllm(path: Path, port: int, max_len: str, util: str, device: str, name: str) -> subprocess.Popen:
        log = open(log_dir / f"{name}.log", "w")
        return subprocess.Popen(
            [str(env_bin / "python"), "-m", "vllm.entrypoints.openai.api_server",
             "--model", str(path), "--served-model-name", SERVED_MODEL_NAME if name == "main" else str(path),
             "--host", "127.0.0.1", "--port", str(port), "--max-model-len", max_len,
             "--gpu-memory-utilization", util, "--enable-prefix-caching", "--enable-chunked-prefill"],
            env={**base_env, "CUDA_VISIBLE_DEVICES": device}, stdout=log, stderr=subprocess.STDOUT)

    procs = []
    summary = vllm(summary_path, summary_port, "32768", layout["summary_util"], layout["summary_device"], "summary")
    procs.append(summary)
    wait_http(f"http://127.0.0.1:{summary_port}/v1/models", summary, "summary vLLM", 30 * 60)
    main = vllm(main_path, main_port, "65536", layout["main_util"], layout["main_device"], "main")
    procs.append(main)
    wait_http(f"http://127.0.0.1:{main_port}/v1/models", main, "main vLLM", 30 * 60)
    adapter_env = {
        **base_env,
        "PYTHON_BIN": str(env_bin / "python"), "VENV_ACTIVATE": "",
        "ADAPTER_HOST": "127.0.0.1", "ADAPTER_PORT": str(adapter_port),
        "MAIN_API_BASE": f"http://127.0.0.1:{main_port}/v1", "MAIN_MODEL": SERVED_MODEL_NAME,
        "SERVED_MODEL_NAME": SERVED_MODEL_NAME,
        "SUMMARIZER_API_BASE": f"http://127.0.0.1:{summary_port}/v1", "SUMMARIZER_MODEL": str(summary_path),
        "LIVE_SAVE_OUTPUTS": "false", "LIVE_SAVE_DEBUG_INPUTS": "false", "SAVE_MODEL_INPUTS": "false",
        "FRAME_SAVE_DIR": str(frames), "ALLOWED_LOCAL_IMAGE_ROOTS": str(frames),
        "FORCE_SILENCE_BEFORE_QUERY": "true",
        **JOYAI_ENV[system],
    }
    adapter = subprocess.Popen(["bash", str(webinfer / "scripts" / "start_adapter.sh")], env=adapter_env,
                               cwd=webinfer, stdout=open(log_dir / "adapter.log", "w"),
                               stderr=subprocess.STDOUT)
    procs.append(adapter)
    api = f"http://127.0.0.1:{adapter_port}/v1"
    wait_http(f"http://127.0.0.1:{adapter_port}/health", adapter, "adapter", 10 * 60)
    joyai_ready(api, 15 * 60)
    settings = {**layout, "main_max_model_len": 65536, "summary_max_model_len": 32768,
                "adapter_env": JOYAI_ENV[system]}
    return procs, {"JOYAI_VL_API_BASE": api}, settings


def worker(run: str) -> None:
    started = time.time()
    root = run_dir(run)
    meta = json.loads((root / "run.json").read_text())
    system, model, tasks = meta["system"], meta["model"], meta["tasks"]
    job_id = os.environ.get("SLURM_JOB_ID", "local")
    log_dir = root / "logs" / job_id
    log_dir.mkdir(parents=True, exist_ok=True)
    gpu = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True).stdout.strip()
    record = {"job": job_id, "host": os.uname().nodename, "gpu": gpu,
              "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"), "shards": []}
    print(json.dumps(record), flush=True)
    if not any(not shard_done(s, model, t) for t in tasks for s in (root / t).glob("shard-*")):
        print("all shards done")
        return

    procs: list[subprocess.Popen] = []
    env = dict(os.environ)
    try:
        if system.startswith("joyai"):
            port_base = 20000 + int(job_id) % 4000 * 10 if job_id.isdigit() else 20000
            procs, extra, record["settings"] = start_joyai(system, log_dir, port_base)
            env.update(extra)
            python = WORK / "envs" / "joyai" / "bin" / "python"
            model_args: list[str] = []
        else:
            python = WORK / "envs" / "minicpm" / "bin" / "python"
            model_args = ["--model_path", str(WORK / "models" / "MiniCPM-o-4_5")]
            env["HF_HUB_OFFLINE"] = "1"
        record["boot_s"] = round(time.time() - started, 1)
        while time.time() - started < JOB_SECONDS - CLAIM_MARGIN:
            shard = claim(root, model, tasks, job_id)
            if shard is None:
                break
            task = shard.parent.name
            t0 = time.time()
            with open(shard / f"inference-{job_id}.log", "w") as log:
                code = subprocess.run(
                    [str(python), "inference.py", "--task", task, "--model", model, "--resume",
                     "--annotation_path", str(shard / "annotations.json"),
                     "--video_root", str(WORK / "data" / "videos"),
                     "--result_dir", str(shard / "out"), *model_args],
                    cwd=WORK / "SPOT-Bench", env=env, stdout=log, stderr=subprocess.STDOUT).returncode
            (shard / "claim").unlink(missing_ok=True)
            record["shards"].append({"shard": f"{task}/{shard.name}", "exit": code,
                                     "seconds": round(time.time() - t0, 1)})
            print(json.dumps(record["shards"][-1]), flush=True)
            if code != 0:
                break  # leave the shard for another worker; don't spin on a broken stack
    finally:
        for proc in reversed(procs):
            proc.terminate()
        for proc in procs:
            try:
                proc.wait(30)
            except subprocess.TimeoutExpired:
                proc.kill()
        record["wall_s"] = round(time.time() - started, 1)
        with open(root / "jobs.jsonl", "a") as f:
            f.write(json.dumps(record) + "\n")


# ---------------------------------------------------------------- status / score


def status(run: str) -> None:
    root = run_dir(run)
    meta = json.loads((root / "run.json").read_text())
    model = meta["model"]
    for task in meta["tasks"]:
        done_videos = total = done_shards = 0
        shards = sorted((root / task).glob("shard-*"))
        for shard in shards:
            total += len(json.loads((shard / "annotations.json").read_text()))
            if shard_done(shard, model, task):
                done_shards += 1
                done_videos += len(json.loads((shard / "out" / f"{task}_{model}.json").read_text()))
            elif (shard / "out" / f"{task}_{model}.temp.json").exists():
                done_videos += len(json.loads((shard / "out" / f"{task}_{model}.temp.json").read_text()))
        print(f"{task}: {done_videos}/{total} videos, {done_shards}/{len(shards)} shards done")
    subprocess.run(["squeue", "-u", os.environ["USER"], "-n",
                    ",".join(f"e2-{meta['system']}-{i}" for i in range(len(meta["workers"]))),
                    "-o", "%i %j %T %M %b %N %R"])


def score(run: str, python: str) -> None:
    root = run_dir(run)
    meta = json.loads((root / "run.json").read_text())
    model, tasks = meta["model"], meta["tasks"]
    merged_dir = root / "merged"
    merged_dir.mkdir(exist_ok=True)
    for task in tasks:
        merged: dict = {}
        for shard in sorted((root / task).glob("shard-*")):
            if not shard_done(shard, model, task):
                raise SystemExit(f"{task}/{shard.name} is not finished")
            merged.update(json.loads((shard / "out" / f"{task}_{model}.json").read_text()))
        (merged_dir / f"{task}_{model}.json").write_text(json.dumps(merged, indent=1))
    proc = subprocess.run([python, "score.py", "--tasks", *tasks, "--model", model,
                           "--result_dir", str(merged_dir), "--annotation_root", str(WORK / "data"),
                           "--dump_matches"],
                          cwd=WORK / "SPOT-Bench", capture_output=True, text=True)
    (root / "score.txt").write_text(proc.stdout + "\n" + proc.stderr)
    print(proc.stdout, proc.stderr[-3000:])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("submit")
    p.add_argument("--system", required=True, choices=MODEL_NAMES)
    p.add_argument("--run", required=True)
    p.add_argument("--tasks", default="ABD,PNR")
    p.add_argument("--shards", type=int, default=16, help="per task")
    p.add_argument("--chain", type=int, default=6, help="3 h jobs per worker")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("resubmit", help="queue more worker chains for an existing run")
    p.add_argument("--run", required=True)
    p.add_argument("--chain", type=int, default=6)
    p = sub.add_parser("worker")
    p.add_argument("--run", required=True)
    p = sub.add_parser("status")
    p.add_argument("--run", required=True)
    p = sub.add_parser("score")
    p.add_argument("--run", required=True)
    p.add_argument("--python", default=str(WORK / "envs" / "minicpm" / "bin" / "python"))
    args = parser.parse_args()
    if args.command == "submit":
        tasks = [t.strip().upper() for t in args.tasks.split(",") if t.strip()]
        submit(args.system, args.run, tasks, args.shards, args.chain, args.dry_run)
    elif args.command == "resubmit":
        system = json.loads((run_dir(args.run) / "run.json").read_text())["system"]
        queue_workers(system, args.run, args.chain, False)
    elif args.command == "worker":
        worker(args.run)
    elif args.command == "status":
        status(args.run)
    else:
        score(args.run, args.python)


if __name__ == "__main__":
    main()
