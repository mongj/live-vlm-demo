"""Start only an already-prepared runtime inside an owned PBS GPU allocation."""
from __future__ import annotations

import argparse
import fcntl
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys

import prepare
import safety
from supervisor import RuntimeSupervisor, StopRequested


def runtime_environment(root, source, gpu_uuid):
    env = dict(os.environ)
    env.pop("PYTHONHOME", None)
    env.update(CUDA_DEVICE_ORDER="PCI_BUS_ID", CUDA_VISIBLE_DEVICES=gpu_uuid,
               MINICPM_RUNTIME_ROOT=str(root), PYTHONPATH=f"{source}:{root / 'runtime'}",
               PYTHONNOUSERSITE="1", PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1",
               HF_HOME=str(root / "cache/huggingface"), HF_HUB_OFFLINE="1",
               TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1",
               TORCH_HOME=str(root / "cache/torch"), TORCHINDUCTOR_CACHE_DIR=str(root / "cache/torch/inductor"),
               XDG_CACHE_HOME=str(root / "cache"), TRITON_CACHE_DIR=str(root / "cache/triton"),
               NUMBA_CACHE_DIR=str(root / "cache/numba"), MPLCONFIGDIR=str(root / "cache/matplotlib"),
               TMPDIR=str(root / "tmp"), OMP_NUM_THREADS=os.environ.get("NCPUS", "8"))
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    safety.validate_job(os.environ, socket.gethostname(), gpu=True)
    config = prepare.check(args.root)
    root, source = Path(config["root"]), Path(config["source"])
    if Path(sys.executable).absolute() != Path(config["python"]):
        env = dict(os.environ)
        env.pop("PYTHONHOME", None)
        env.pop("PYTHONPATH", None)
        env.update(PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
        os.execve(config["python"], [config["python"], "-s", str(root / "runtime/run.py"), "--root", str(root)], env)
    if sys.version_info < (3, 11):
        raise ValueError("The dependency runtime requires Python 3.11+ (asyncio.timeout)")
    if not callable(getattr(os, "pidfd_open", None)) or not callable(getattr(signal, "pidfd_send_signal", None)):
        raise ValueError("Linux pidfd_open/pidfd_send_signal required; no numeric signal fallback")
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
        raise ValueError("SIGCHLD must retain its default disposition")
    fd = os.pidfd_open(os.getpid(), 0)
    os.close(fd)
    if not shutil.which("ffmpeg"):
        raise ValueError("Existing ffmpeg is required; no implicit dependency install")
    # Owned private root + no-follow file descriptor: concurrent starts cannot
    # replace config or signal one another. Lock lasts through child cleanup.
    lock = os.open(root / "state/runtime.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("Runtime lock must be a private owned regular file")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Another own runtime holds the prepared-root lock") from error
        gpu_uuid = safety.allocated_gpu_uuid()
        safety.check_ports()
        environment = runtime_environment(root, source, gpu_uuid)
        os.environ.clear()
        os.environ.update(environment)
        # Probe only after exact scheduler ownership/masking, before any model.
        subprocess.run([config["python"], "-c", 'import torch; assert torch.__version__.startswith("2.8.0"); assert torch.version.cuda == "12.8"; assert torch.cuda.is_available(); assert torch.cuda.device_count() == 1; print("Allocated visible GPU:", torch.cuda.get_device_name(0))'], check=True, timeout=60)
        runtime = RuntimeSupervisor(source_dir=source, scripts_dir=root / "runtime", model_path=config["model"],
                                    log_dir=root / "logs", job_id=os.environ["PBS_JOBID"], python=config["python"])
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, runtime.request_stop)
        runtime.run()
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except StopRequested as error:
        print(f"Runtime stopping: {error}", file=sys.stderr)
        sys.exit(128 + error.signum)
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        print(f"MiniCPM runtime refused: {error}", file=sys.stderr)
        sys.exit(2)
