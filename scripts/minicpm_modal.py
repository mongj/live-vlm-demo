"""MiniCPM-o 4.5 live video (full duplex) on Modal: backend, worker and gateway on one GPU.

Deploy with `make minicpm-modal` (pick the GPU with `MINICPM_MODAL_GPU=H200`, etc.). The
Server exposes the same `/v1/realtime?mode=video` WebSocket that the PBS runtime
serves on port 18006, behind Modal proxy-token auth.

The source is the upstream archive pinned in minicpm_runtime/prepare.py with
minicpm_runtime/runtime.patch applied by prepare.patched_files(), which checks
the archive, patch and resulting tree against their reviewed hashes. Processes
start in the order of minicpm_runtime/supervisor.py. The PBS-specific checks
(job ownership, pidfds, private roots) do not apply inside a Modal container.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import modal

from modal_common import GPU_TYPES, MINUTES, Phases, Stack, gpu_info, wait_http

APP_NAME = "live-vlm-minicpm"
HERE = Path(__file__).resolve().parent
ARCHIVE_URL = "https://github.com/OpenBMB/MiniCPM-o-Demo/archive/{pin}.tar.gz"
PIN_DATE = "2026-09-15T07:16:25Z"  # commit date of prepare.PIN
ROOT = "/opt/minicpm"  # prepare.py layout: source/, runtime/, state/
SOURCE = f"{ROOT}/source"
RUNTIME = f"{ROOT}/runtime"

MODEL_ROOT = "/models"
CACHE_ROOT = "/cache"
# Since 2026-07-06 only README.md changed in either repository.
CHECKPOINTS = {
    # Official full-precision release: every module in BF16 (~18.7 GB of weights).
    "bf16": ("openbmb/MiniCPM-o-4_5", "eb4141de24550a3a1a4082f718be58f46b761728"),
    # Official AWQ release: only the Qwen3-8B LLM is 4-bit (group 128); vision,
    # audio encoder, resampler, TTS and lm_head stay BF16 (~8.5 GB of weights).
    "awq": ("openbmb/MiniCPM-o-4_5-awq", "02b87bcf31b1e3bc66094a8f8eba2034605e5073"),
}

BACKEND_PORT = 22500
WORKER_PORT = 22400
GATEWAY_PORT = 18006
REGISTRY_PORT = 18007

GPU = os.environ.get("MINICPM_MODAL_GPU", "H100").upper()
if GPU not in GPU_TYPES:
    raise SystemExit(f"MINICPM_MODAL_GPU must be one of {', '.join(GPU_TYPES)}; got {GPU!r}")


def build_source() -> None:
    """Image build step: pinned upstream archive + reviewed patch -> SOURCE."""
    sys.path.insert(0, RUNTIME)
    import prepare

    archive = Path("/tmp/minicpm-src.tar.gz")
    urllib.request.urlretrieve(ARCHIVE_URL.format(pin=prepare.PIN), archive)
    archive.chmod(0o600)
    for name, data in prepare.patched_files(archive).items():
        path = Path(SOURCE) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    archive.unlink()


requirements = [
    # Upstream requirements.txt at the pin, minus test tooling. Upstream pins only
    # the first two; the benchmark logs the full resolved `pip freeze`.
    "transformers==4.51.0", "accelerate==1.12.0", "safetensors>=0.7.0",
    "minicpmo-utils[all]>=1.0.5",
    "fastapi>=0.128.0", "uvicorn>=0.40.0", "httpx>=0.28.0", "websockets>=16.0",
    "python-multipart", "markdown>=3.6", "Pygments>=2.18.0", "PyYAML>=6.0",
    "librosa>=0.10.2", "soundfile>=0.12.1", "pydantic>=2.11.0", "numpy>=2.2.0",
    "tqdm>=4.67.0", "huggingface_hub[hf_xet]",
]

image = (
    # Mirrors upstream docker/Dockerfile.worker-backend: torch wheels bring CUDA.
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libsndfile1", "curl")
    .uv_pip_install("torch==2.8.0", "torchaudio==2.8.0",
                    index_url="https://download.pytorch.org/whl/cu128")
    # Two steps like the upstream Dockerfile: minicpmo-utils pins librosa 0.9.0,
    # which requirements.txt deliberately overrides with >=0.10.2. Upstream gives
    # only lower bounds, so resolve PyPI as of the demo pin's commit date; later
    # releases (e.g. minicpmo-utils 1.0.7) changed the token2wav asset layout.
    .uv_pip_install("minicpmo-utils[all]>=1.0.5", extra_options=f"--exclude-newer {PIN_DATE}")
    .uv_pip_install(*(r for r in requirements if not r.startswith("minicpmo-utils")),
                    extra_options=f"--exclude-newer {PIN_DATE}")
    # AutoAWQ supplies the WQLinear_GEMM layers transformers uses for the AWQ
    # checkpoint. Its own pins target older torch, so install it without deps.
    .uv_pip_install("autoawq==0.2.9", extra_options=f"--no-deps --exclude-newer {PIN_DATE}")
    .uv_pip_install("datasets", extra_options=f"--exclude-newer {PIN_DATE}")  # imported by awq
    .add_local_dir(HERE / "minicpm_runtime", RUNTIME, copy=True)
    # build_source runs from this module, which imports modal_common.
    .add_local_python_source("modal_common", copy=True)
    .run_function(build_source)
    .env({
        "HF_XET_HIGH_PERFORMANCE": "1",
        "PYTHONPATH": f"{SOURCE}:{RUNTIME}",
        "PYTHONUNBUFFERED": "1",
        # Compile caches persist in the cache Volume (pip already filled /root/.cache).
        "TORCHINDUCTOR_CACHE_DIR": f"{CACHE_ROOT}/torchinductor",
        "TRITON_CACHE_DIR": f"{CACHE_ROOT}/triton",
    })
)

models = modal.Volume.from_name("live-vlm-minicpm-models", create_if_missing=True)
cache = modal.Volume.from_name("live-vlm-minicpm-cache", create_if_missing=True)

app = modal.App(APP_NAME)


def ensure_model(precision: str) -> str:
    repo, revision = CHECKPOINTS[precision]
    path = Path(MODEL_ROOT) / repo.split("/")[1]
    marker = path / f".revision-{revision}"
    if not marker.exists():
        from huggingface_hub import snapshot_download

        print(f"downloading {repo}@{revision} -> {path}", flush=True)
        snapshot_download(repo, revision=revision, local_dir=path)
        marker.touch()
        models.commit()
    return str(path)


def health(role: str):
    sys.path.insert(0, RUNTIME)
    from safety import health_ready

    return lambda body: health_ready(role, json.loads(body))


GATEWAY_MAIN = f"""
import os, sys
os.chdir({SOURCE!r})
import gateway
from safety import PrivacyGate
gateway.app.add_middleware(PrivacyGate, speech_enabled=False)
sys.argv = ["gateway.py", "--host", "0.0.0.0", "--port", "{GATEWAY_PORT}",
            "--internal-port", "{REGISTRY_PORT}", "--http", "--lang", "en"]
gateway.main()
"""


def start_stack(precision: str = "bf16", compile: bool = False, log_dir: str | None = None) -> Stack:
    """Start backend, worker and gateway; return once the gateway has an idle worker.

    With log_dir, each process writes <name>.log there instead of the container log.
    """
    sys.path.insert(0, RUNTIME)
    import prepare

    gpu = gpu_info()
    print(gpu, flush=True)
    phase = Phases()
    model_path = ensure_model(precision)
    phase("weights")
    # The cluster runtime's config (SDPA attention, token2wav vocoder, one queued
    # session, recording off); compile toggles torch.compile for the benchmark.
    config = prepare.privacy_config(Path(ROOT))
    config["service"]["compile"] = compile
    Path(SOURCE, "config.json").write_text(json.dumps(config))
    Path(config["service"]["data_dir"]).mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "CUDA_VISIBLE_DEVICES": "0", "HF_HUB_OFFLINE": "1",
           "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}
    procs: list[subprocess.Popen[bytes]] = []

    def start(name: str, command: list[str]) -> subprocess.Popen[bytes]:
        out = None
        if log_dir:
            Path(log_dir).mkdir(parents=True, exist_ok=True)
            out = open(Path(log_dir) / f"{name}.log", "wb")
        procs.append(subprocess.Popen(command, cwd=SOURCE, env=env, stdout=out, stderr=out))
        return procs[-1]

    backend = start("backend", ["python", "-m", "py_backend.server", "--host", "127.0.0.1",
                     "--port", str(BACKEND_PORT), "--gpu-id", "0", "--model-path", model_path])
    wait_http(f"http://127.0.0.1:{BACKEND_PORT}/health", backend, "backend", 40 * MINUTES,
              health("backend"))
    phase("backend")
    worker = start("worker", ["python", "worker.py", "--host", "127.0.0.1", "--port", str(WORKER_PORT),
                    "--gpu-id", "0", "--backend-server-url", f"http://127.0.0.1:{BACKEND_PORT}"])
    wait_http(f"http://127.0.0.1:{WORKER_PORT}/health", worker, "worker", 5 * MINUTES,
              health("worker"))
    phase("worker")
    gateway = start("gateway", ["python", "-c", GATEWAY_MAIN])
    wait_http(f"http://127.0.0.1:{REGISTRY_PORT}/health", gateway, "registry", 5 * MINUTES,
              health("registry"))
    register = urllib.request.Request(
        f"http://127.0.0.1:{REGISTRY_PORT}/internal/workers/minicpm-runtime",
        data=json.dumps({"endpoint": f"127.0.0.1:{WORKER_PORT}", "gpu_group": "modal-one-gpu"}).encode(),
        headers={"content-type": "application/json"}, method="PUT")
    with urllib.request.urlopen(register, timeout=10) as response:
        response.read()
    wait_http(f"http://127.0.0.1:{GATEWAY_PORT}/status", gateway, "gateway", 5 * MINUTES,
              health("gateway"))
    phase("gateway")
    repo, revision = CHECKPOINTS[precision]
    settings = {
        "model": "minicpm", "precision": precision, "checkpoint": f"{repo}@{revision}",
        "engine": "pytorch-eager" if not compile else "pytorch+torch.compile",
        "attn_implementation": config["model"]["attn_implementation"],
        "chat_vocoder": config["audio"]["chat_vocoder"],
        # PyTorch allocates on demand; nothing is reserved up front (see VRAM logs).
        "memory_reservation": "on demand (whole GPU visible)",
    }
    return Stack(gpu, procs, phase.durations, settings)


@app.server(
    image=image,
    gpu=GPU_TYPES[GPU],
    cpu=8,
    memory=64 * 1024,
    volumes={MODEL_ROOT: models, CACHE_ROOT: cache},
    port=GATEWAY_PORT,
    startup_timeout=40 * MINUTES,
    scaledown_window=20 * MINUTES,
    # The gateway admits one session per worker; one container keeps queueing honest.
    max_containers=1,
)
class MiniCPM:
    @modal.enter()
    def start(self) -> None:
        self.stack = start_stack()

    @modal.exit()
    def stop(self) -> None:
        self.stack.stop()
