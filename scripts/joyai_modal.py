"""JoyAI-VL webinfer on Modal: both vLLM models and the streaming adapter on one GPU.

Deploy with `make joyai-modal` (pick the GPU with `JOYAI_MODAL_GPU=H200`, etc.). The Server exposes the same `/v1` API that
`scripts/joyai.pbs` serves on port 8070, behind Modal proxy-token auth.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import modal

from modal_common import GPU_TYPES, MINUTES, Phases, Stack, gpu_info, wait_http

APP_NAME = "live-vlm-joyai"
JOYAI_REPO = "https://github.com/jd-opensource/JoyAI-VL-Interaction.git"
# Same commit as the cluster checkout in /home/mingjun/JoyAI-VL-Interaction.
JOYAI_COMMIT = "5519d35375d2f95ec1c30fa176b514bc158b1e15"
JOYAI_ROOT = "/opt/JoyAI-VL-Interaction"
WEBINFER = f"{JOYAI_ROOT}/services/webinfer"

MODEL_ROOT = "/models"
MAIN_REPO = "jdopensource/JoyAI-VL-Interaction"
MAIN_REVISION = "86124c620faddd7be7b7f2722f29cd5192f21c38"
MAIN_PATH = f"{MODEL_ROOT}/JoyAI-VL-Interaction"
SUMMARY_REPO = "Qwen/Qwen3-VL-4B-Instruct"
SUMMARY_REVISION = "ebb281ec70b05090aa6165b016eac8ec08e71b17"
SUMMARY_PATH = f"{MODEL_ROOT}/Qwen3-VL-4B-Instruct"

SERVED_MODEL_NAME = "JoyAI-VL-Interaction"
MAIN_PORT = 7060
SUMMARY_PORT = 8065
ADAPTER_PORT = 8000
# Both models share one GPU (80 GB or more); the summary model starts first and
# the main model's budget is checked against what is left.
SUMMARY_GPU_MEMORY_UTILIZATION = "0.25"
MAIN_GPU_MEMORY_UTILIZATION = "0.6"

# Read at deploy time. Containers re-import this module without the variable,
# but run on whatever GPU the deployed definition requested.
GPU = os.environ.get("JOYAI_MODAL_GPU", "H100").upper()
if GPU not in GPU_TYPES:
    raise SystemExit(f"JOYAI_MODAL_GPU must be one of {', '.join(GPU_TYPES)}; got {GPU!r}")

LOCK_FILE = Path(__file__).resolve().parent.parent / "joyai" / "requirements-cu129.lock.txt"


def locked_requirements() -> list[str]:
    # The cluster lock also pins an editable install of the JoyAI WebUI, which
    # this deployment does not serve. Containers re-import this module without
    # the repository, and the image is already built by then.
    if not modal.is_local():
        return []
    lines = (line.strip() for line in LOCK_FILE.read_text().splitlines())
    return [line for line in lines if line and not line.startswith(("#", "-e "))]


base_image = (
    modal.Image.from_registry("nvidia/cuda:12.9.1-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .apt_install("git", "curl", "libgl1", "libglib2.0-0")
    .uv_pip_install(
        *locked_requirements(),
        extra_index_url="https://download.pytorch.org/whl/cu129",
        # pip semantics: the lock mixes PyTorch-index and PyPI pins.
        extra_options="--index-strategy unsafe-best-match",
    )
    .run_commands(
        f"git clone {JOYAI_REPO} {JOYAI_ROOT}",
        f"git -C {JOYAI_ROOT} checkout --detach {JOYAI_COMMIT}",
    )
    .env({"HF_XET_HIGH_PERFORMANCE": "1"})
)
# Other apps extend base_image; build steps cannot follow a non-copied local source.
image = base_image.add_local_python_source("modal_common")

models = modal.Volume.from_name("live-vlm-joyai-models", create_if_missing=True)
cache = modal.Volume.from_name("live-vlm-joyai-cache", create_if_missing=True)

app = modal.App(APP_NAME)


def ensure_model(repo: str, revision: str, path: str) -> None:
    marker = Path(path) / f".revision-{revision}"
    if marker.exists():
        return
    from huggingface_hub import snapshot_download

    print(f"downloading {repo}@{revision} -> {path}", flush=True)
    snapshot_download(repo, revision=revision, local_dir=path)
    marker.touch()
    models.commit()


def vllm_command(
    path: str, served_name: str, port: int, max_len: str, memory: str, extra: list[str]
) -> list[str]:
    return [
        "python", "-m", "vllm.entrypoints.openai.api_server",
        "--model", path,
        "--served-model-name", served_name,
        "--host", "127.0.0.1",
        "--port", str(port),
        "--max-model-len", max_len,
        "--gpu-memory-utilization", memory,
        "--enable-prefix-caching",
        "--enable-chunked-prefill",
        *extra,
    ]


def start_stack(extra_env: dict[str, str] | None = None) -> Stack:
    """Start both vLLM servers, then the adapter on ADAPTER_PORT (not awaited).

    extra_env overrides adapter settings (e.g. KEEP_QA_HISTORY) for benchmarks.
    """
    gpu = gpu_info()
    print(gpu, flush=True)
    phase = Phases()
    # vLLM 0.22's FlashAttention-4 vision-encoder kernel rejects sm_103 (B300).
    extra = ["--mm-encoder-attn-backend", "TORCH_SDPA"] if gpu.endswith(", 10.3") else []
    ensure_model(SUMMARY_REPO, SUMMARY_REVISION, SUMMARY_PATH)
    ensure_model(MAIN_REPO, MAIN_REVISION, MAIN_PATH)
    phase("weights")
    frames = "/tmp/joyai-frames"
    os.makedirs(frames, exist_ok=True)
    env = {
        **os.environ,
        "CUDA_VISIBLE_DEVICES": "0",
        "PYTHON_BIN": "python",
        "VENV_ACTIVATE": "",
        "ADAPTER_HOST": "0.0.0.0",
        "ADAPTER_PORT": str(ADAPTER_PORT),
        "MAIN_API_BASE": f"http://127.0.0.1:{MAIN_PORT}/v1",
        "MAIN_MODEL": SERVED_MODEL_NAME,
        "SERVED_MODEL_NAME": SERVED_MODEL_NAME,
        "SUMMARIZER_API_BASE": f"http://127.0.0.1:{SUMMARY_PORT}/v1",
        "SUMMARIZER_MODEL": SUMMARY_PATH,
        "LIVE_SAVE_OUTPUTS": "false",
        "LIVE_SAVE_DEBUG_INPUTS": "false",
        "SAVE_MODEL_INPUTS": "false",
        "FRAME_SAVE_DIR": frames,
        "ALLOWED_LOCAL_IMAGE_ROOTS": frames,
        "FORCE_SILENCE_BEFORE_QUERY": "true",
        **(extra_env or {}),
    }
    procs: list[subprocess.Popen[bytes]] = []

    summary = subprocess.Popen(
        vllm_command(SUMMARY_PATH, SUMMARY_PATH, SUMMARY_PORT, "32768",
                     SUMMARY_GPU_MEMORY_UTILIZATION, extra),
        env=env,
    )
    procs.append(summary)
    wait_http(f"http://127.0.0.1:{SUMMARY_PORT}/v1/models", summary, "summary vLLM",
              30 * MINUTES)
    phase("summary_vllm")

    main = subprocess.Popen(
        vllm_command(MAIN_PATH, SERVED_MODEL_NAME, MAIN_PORT, "65536",
                     MAIN_GPU_MEMORY_UTILIZATION, extra),
        env=env,
    )
    procs.append(main)
    wait_http(f"http://127.0.0.1:{MAIN_PORT}/v1/models", main, "main vLLM", 30 * MINUTES)
    phase("main_vllm")
    subprocess.run(
        ["python", f"{WEBINFER}/smoke.py", "main-vlm",
         "--api-base", f"http://127.0.0.1:{MAIN_PORT}/v1", "--model", SERVED_MODEL_NAME],
        env=env,
        check=False,
    )
    phase("smoke")

    # The Server is ready once the adapter listens on ADAPTER_PORT.
    procs.append(
        subprocess.Popen(["bash", f"{WEBINFER}/scripts/start_adapter.sh"], env=env, cwd=WEBINFER)
    )
    settings = {
        "model": "joyai", "precision": "bf16", "engine": "vllm",
        # vLLM reserves these fractions of total GPU memory up front (weights,
        # activations, CUDA graphs, then KV cache fills the rest of the share).
        "summary_gpu_memory_utilization": float(SUMMARY_GPU_MEMORY_UTILIZATION),
        "main_gpu_memory_utilization": float(MAIN_GPU_MEMORY_UTILIZATION),
        "main_max_model_len": 65536, "summary_max_model_len": 32768,
        "extra_vllm_args": extra,
        "extra_env": extra_env or {},
    }
    return Stack(gpu, procs, phase.durations, settings)


@app.server(
    image=image,
    gpu=GPU_TYPES[GPU],
    cpu=8,
    memory=64 * 1024,
    volumes={MODEL_ROOT: models, "/root/.cache": cache},
    port=ADAPTER_PORT,
    # First boot downloads ~26 GB of weights and JIT-compiles kernels.
    startup_timeout=40 * MINUTES,
    scaledown_window=20 * MINUTES,
    # Adapter memory is per container; one container keeps sessions consistent.
    max_containers=1,
)
class JoyAI:
    @modal.enter()
    def start(self) -> None:
        self.stack = start_stack()

    @modal.exit()
    def stop(self) -> None:
        self.stack.stop()
