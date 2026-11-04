"""Download SPOT-Bench into the shared Modal Volume `live-vlm-bench-data` (at /data/spot).

SPOT-Bench is gated on Hugging Face: accept its terms at
https://huggingface.co/datasets/cvml-nus/spot-bench, then

  modal secret create huggingface HF_TOKEN=hf_...
  modal run --detach scripts/spot_data_modal.py
"""

from __future__ import annotations

import modal

from bench_data_modal import DATA_ROOT, data, fetch, image

SPOT = ("cvml-nus/spot-bench", "e0f2b9c8f3a46ae5bf408567d51e5de6d3c6e0fa")

app = modal.App("live-vlm-spot-data",
                image=image.apt_install("unzip").add_local_python_source("bench_data_modal"))


@app.function(volumes={DATA_ROOT: data}, cpu=8, memory=16 * 1024, timeout=6 * 3600,
              secrets=[modal.Secret.from_name("huggingface")])
def spot() -> None:
    import subprocess
    from pathlib import Path

    target = f"{DATA_ROOT}/spot"
    fetch(*SPOT, target)
    archive = Path(target) / "videos.zip"
    if archive.exists():
        subprocess.run(["unzip", "-q", "-o", str(archive), "-d", target], check=True)
        archive.unlink()
        data.commit()
    print(sorted(p.name for p in Path(target).iterdir()))
