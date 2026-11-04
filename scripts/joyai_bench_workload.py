#!/usr/bin/env python3
"""The fixed JoyAI benchmark session, independent of where the adapter runs.

joyai_modal_bench.py replays it inside Modal containers. To run it against any
other JoyAI adapter (e.g. the PBS job on its compute node), run this file:

  python3 joyai_bench_workload.py --url http://127.0.0.1:8070/v1 --label cvml01 --out DIR

It writes turns.jsonl, config.json and summary.json in the same format. Needs
only the standard library and Pillow.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import statistics
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

SERVED_MODEL_NAME = "JoyAI-VL-Interaction"
SYSTEM_PROMPT_KEY = "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION"  # gateway default
# Text sent with the frame at that turn index; other turns are image-only, as
# in the gateway. Frames are 1 s apart in session time.
QUERIES = {
    0: "Describe what you see in one short sentence.",
    15: "What number is shown now? Answer with just the number.",
}
WARMUP_TURNS = 10


def frame_jpeg(index: int, variant: int = 0) -> bytes:
    """Deterministic 640x480 scene: a large frame number and a ball that moves.

    `variant` (the session index) shifts the background so no two sessions share
    frames; otherwise vLLM's prefix cache serves later sessions from earlier ones.
    """
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (640, 480), (30 + index * 7 % 120, 60 + 37 * variant % 120, 110))
    draw = ImageDraw.Draw(img)
    x = 40 + (index * 37) % 520
    draw.ellipse([x, 300, x + 80, 380], fill=(230, 60, 50))
    draw.text((250, 80), str(index), fill="white", font=ImageFont.load_default(size=120))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def post(base_url: str, path: str, session: str, body: dict,
         timeout: float = 120) -> tuple[int, dict | str]:
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "x-streaming-session": session,
            "x-system-prompt-key": SYSTEM_PROMPT_KEY,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode(errors="replace")


def run_session(base_url: str, label: str, session_index: int, turns: int,
                queries: dict[int, str] | None = None, query_all: str = "") -> list[dict]:
    """Replay one session. Turns listed in `queries` (default QUERIES) carry that text;
    `query_all` instead attaches the same text to every turn."""
    queries = QUERIES if queries is None else queries
    session = f"bench-{uuid.uuid4().hex[:12]}"
    post(base_url, "/streaming/reset", session, {})
    rows = []
    for turn in range(turns):
        query = query_all or queries.get(turn, "")
        content: list[dict] = [{"type": "text", "text": query}] if query else []
        jpeg = frame_jpeg(turn, session_index)
        content.append({"type": "image_url", "image_url": {
            "url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}})
        body = {
            "model": SERVED_MODEL_NAME,
            "messages": [{"role": "user", "content": content}],
            "frame_time_ranges": [f"{float(turn):.1f} seconds"],
        }
        started_unix = time.time()
        t0 = time.perf_counter()
        status, response = post(base_url, "/chat/completions", session, body)
        latency = time.perf_counter() - t0
        text = raw = None
        usage: dict = {}
        timing: dict = {}
        if isinstance(response, dict):
            usage = response.get("usage") or {}
            timing = (response.get("streamingharness") or {}).get("timing") or {}
            try:
                text = response["choices"][0]["message"]["content"]
                raw = response["streamingharness"]["raw_content"]
            except (KeyError, IndexError, TypeError):
                pass
        rows.append({
            "gpu": label,
            "session": session_index,  # 0 is the discarded warm-up
            "session_id": session,
            "turn": turn,
            "frame_time_s": float(turn),
            "query": query,
            "kind": "query" if query else "frame",
            "silent": text is not None and text.strip() == "</silence>",
            "status": status,
            "latency_s": round(latency, 6),
            "started_unix": started_unix,
            "jpeg_bytes": len(jpeg),
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            # Adapter-reported breakdown (adapter_total_ms, vllm_inference_ms, ...).
            **{f"adapter_{k}" if not k.startswith("adapter_") else k: v for k, v in timing.items()},
            "text": text,
            "raw": raw,
            "response": response,
        })
    post(base_url, "/streaming/reset", session, {})
    return rows


def summarize(turns: list[dict]) -> dict:
    measured = [row for row in turns if row["session"] > 0 and row["status"] == 200]

    def stats(rows: list[dict]) -> dict:
        values = sorted(row["latency_s"] for row in rows)
        if not values:
            return {"n": 0}
        return {
            "n": len(values),
            "median_s": round(statistics.median(values), 4),
            "p90_s": round(values[min(len(values) - 1, int(0.9 * len(values)))], 4),
            "min_s": round(values[0], 4),
            "max_s": round(values[-1], 4),
        }

    return {
        "all": stats(measured),
        "query": stats([r for r in measured if r["kind"] == "query"]),
        "frame_silent": stats([r for r in measured if r["kind"] == "frame" and r["silent"]]),
        "frame_spoken": stats([r for r in measured if r["kind"] == "frame" and not r["silent"]]),
        "session_medians_s": [
            round(statistics.median(r["latency_s"] for r in measured if r["session"] == s), 4)
            for s in sorted({r["session"] for r in measured})
        ],
        "errors": sum(1 for r in turns if r["status"] != 200),
    }


def config(sessions: int, turns: int, query_all: str = "") -> dict:
    return {"sessions": sessions, "turns": turns, "warmup_turns": WARMUP_TURNS,
            "queries": {"every turn": query_all} if query_all else QUERIES,
            "system_prompt_key": SYSTEM_PROMPT_KEY}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", required=True, help="adapter base URL ending in /v1")
    parser.add_argument("--label", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--sessions", type=int, default=3)
    parser.add_argument("--turns", type=int, default=30)
    parser.add_argument("--query-all", default="", help="attach this text to every turn")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "config.json").write_text(json.dumps(
        {**config(args.sessions, args.turns, args.query_all), "url": args.url, "label": args.label},
        indent=2))
    rows: list[dict] = []
    for index in range(args.sessions + 1):
        rows += run_session(args.url.rstrip("/"), args.label, index,
                            args.turns if index else WARMUP_TURNS, query_all=args.query_all)
    with open(args.out / "turns.jsonl", "w") as f:
        f.writelines(json.dumps(row) + "\n" for row in rows)
    summary = {args.label: summarize(rows)}
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
