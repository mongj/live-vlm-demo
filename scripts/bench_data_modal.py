"""Download the external benchmark datasets into the shared Modal Volume `live-vlm-bench-data`.

  modal run --detach scripts/bench_data_modal.py::interactionbench

The dataset is pinned to the revision below so every run reads the same files.
"""

from __future__ import annotations

import modal

DATA_ROOT = "/data"
INTERACTIONBENCH = ("InteractionBench/InteractionBench", "ae2b9436f1731a1f7c65e49bb18e209450271289")

data = modal.Volume.from_name("live-vlm-bench-data", create_if_missing=True)
image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("huggingface_hub[hf_xet]")
    .env({"HF_XET_HIGH_PERFORMANCE": "1"})
)
app = modal.App("live-vlm-bench-data", image=image)


def fetch(repo: str, revision: str, target: str) -> None:
    from pathlib import Path

    from huggingface_hub import snapshot_download

    marker = Path(target) / f".revision-{revision}"
    if marker.exists():
        print(f"{repo}@{revision} already in {target}")
        return
    snapshot_download(repo, repo_type="dataset", revision=revision, local_dir=target,
                      max_workers=16)
    marker.touch()
    data.commit()
    print(f"{repo}@{revision} -> {target}")


@app.function(volumes={DATA_ROOT: data}, cpu=8, memory=16 * 1024, timeout=6 * 3600)
def interactionbench() -> None:
    fetch(*INTERACTIONBENCH, f"{DATA_ROOT}/interactionbench")
