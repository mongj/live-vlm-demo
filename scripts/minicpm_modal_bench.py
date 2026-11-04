"""Benchmark MiniCPM-o 4.5 live video (full duplex) on Modal, several configurations in parallel.

Run with `make minicpm-modal-bench` (or `modal run scripts/minicpm_modal_bench.py
--configs H100,H100:awq`). A configuration is GPU[:variant], where variant is
bf16 (default), awq (4-bit LLM) or compile (bf16 + torch.compile), so each axis
can be varied on its own.

Each configuration gets its own container that boots the same stack as
`minicpm_modal.py`, then replays a fixed session over the gateway WebSocket on
localhost, exactly as the web-server adapter does: one `input.append` per second
carrying 1 s of 16 kHz audio and one frame (the same synthetic frames as the
JoyAI benchmark). The two JoyAI questions are spoken (scripts/bench_audio/, macOS
`say -v Samantha`) and sent with force_listen, like typed input in the app.
Everything is timed inside the container, so network latency is excluded. One
warm-up session is discarded; the measured sessions follow.

Results go to logs/minicpm-modal-bench/<UTC time>/:
  chunks.jsonl  one row per input chunk: send time, latency to the model's first
                output for that chunk, server prefill/wall-clock ms, KV length
  events.jsonl  every WebSocket event received (audio payloads replaced by sizes)
  replies.jsonl per spoken query: end of question -> first text / first audio
  boots.jsonl   one row per configuration: settings, startup phases, GPU,
                VRAM, package versions (full pip freeze), errors
  audio/        the model's spoken output per session (24 kHz WAV)
  summary.json  per-configuration medians (also printed)
"""

from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import time
import urllib.request
import wave
from datetime import datetime, timezone
from pathlib import Path

import modal

from joyai_bench_workload import frame_jpeg
from minicpm_modal import BACKEND_PORT, CACHE_ROOT, GATEWAY_PORT, MODEL_ROOT, cache, image, models, start_stack
from modal_common import GPU_TYPES, MINUTES, VramSampler, stats

ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT = ROOT / "logs" / "minicpm-modal-bench"
AUDIO_DIR = "/bench_audio"
VARIANTS = {"bf16": ("bf16", False), "awq": ("awq", False), "compile": ("bf16", True)}
# Chunk index at which each spoken question starts; frames are 1 s apart.
QUERIES = {2: "describe", 16: "number"}
WARMUP_CHUNKS = 10
LOG_DIR = "/tmp/minicpm-logs"
INPUT_SAMPLES = 16_000
OUTPUT_RATE = 24_000

# Same session.init the web-server MiniCPM adapter sends, with a fixed start time
# so every configuration sees identical prompt tokens.
SYSTEM_PROMPT = "\n\n".join([
    "Use English only for every written and spoken response. Stay in English even when the "
    "input uses another language or you are asked to translate or switch languages. Answer "
    "those requests in English instead; do not follow a request to output another language.",
    "Answer only the user's current request, normally in one short sentence. Do not add "
    "greetings, praise, explanations, suggestions or follow-up questions unless requested or "
    "necessary to answer the task. Do not invent changes or claim to see something that is "
    "unclear. Give more detail only when requested.",
    "Session-start date and time: 2026-11-04 12:00:00 SGT (UTC+08:00), Asia/Singapore. This is "
    "a session-start snapshot, not a live clock. Do not invent the current time or use a date "
    "from training. If asked for the exact current time, explain that only the session-start "
    "time is available.",
    "The audio included in this system message is a voice reference only. Use its voice style, "
    "but do not repeat, transcribe, explain or answer its contents. Respond to the live user "
    "instead.",
])
DECODE = {"decode_mode": "sampling", "temperature": 0.7, "top_p": 0.8, "top_k": 20,
          "length_penalty": 1.1}  # adapter defaults

app = modal.App("live-vlm-minicpm-bench")
bench_image = (
    image.add_local_dir(ROOT / "scripts" / "bench_audio", AUDIO_DIR)
    .add_local_python_source("minicpm_modal", "joyai_bench_workload")
)


def parse_config(config: str) -> tuple[str, str]:
    gpu, _, variant = config.upper().partition(":")
    variant = variant.lower() or "bf16"
    if gpu not in GPU_TYPES or variant not in VARIANTS:
        raise SystemExit(f"bad config {config!r}: use GPU[:variant] with GPU in "
                         f"{', '.join(GPU_TYPES)} and variant in {', '.join(VARIANTS)}")
    return gpu, variant


def query_packets(name: str) -> list[bytes]:
    """16 kHz float32 1-second packets of a spoken question, the last one zero-padded."""
    import numpy as np

    with wave.open(f"{AUDIO_DIR}/{name}.wav") as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype("<f4") / 32768.0
    count = -(-len(pcm) // INPUT_SAMPLES)
    padded = np.zeros(count * INPUT_SAMPLES, dtype="<f4")
    padded[: len(pcm)] = pcm
    return [padded[i * INPUT_SAMPLES:(i + 1) * INPUT_SAMPLES].tobytes() for i in range(count)]


def wait_idle(timeout: float = 180) -> None:
    """Wait until the backend has finished the previous session, not just the gateway.

    The gateway reports an idle worker before the backend clears active_session_id;
    the worker then rejects a new session (HTTP 403) on slower GPUs.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with urllib.request.urlopen(f"http://127.0.0.1:{BACKEND_PORT}/health", timeout=5) as r:
            backend = json.loads(r.read())
        with urllib.request.urlopen(f"http://127.0.0.1:{GATEWAY_PORT}/status", timeout=5) as r:
            gateway = json.loads(r.read())
        if (backend.get("status") == "ready" and backend.get("active_session_id") is None
                and gateway.get("idle_workers", 0) >= 1):
            time.sleep(1)  # let the worker's own health refresh see the idle backend
            return
        time.sleep(0.5)
    raise RuntimeError("backend did not become idle")


async def run_session(label: str, index: int, chunks: int, query_every: int = 0) -> dict:
    """Replay one session. query_every > 0 asks the "number" question every that many
    chunks (from chunk 2) instead of the two fixed QUERIES."""
    import websockets

    silence = bytes(INPUT_SAMPLES * 4)
    queries = ({c: "number" for c in range(2, chunks, query_every)} if query_every else QUERIES)
    plan: dict[int, tuple[str, bytes, bool]] = {}  # chunk -> (query, audio, last packet)
    for start, name in queries.items():
        packets = query_packets(name)
        for offset, packet in enumerate(packets):
            if start + offset < chunks:
                plan[start + offset] = (name, packet, offset == len(packets) - 1)

    events: list[dict] = []
    sent: dict[str, dict] = {}
    audio = bytearray()
    async with websockets.connect(f"ws://127.0.0.1:{GATEWAY_PORT}/v1/realtime?mode=video",
                                  max_size=64 * 1024 * 1024) as ws:
        t_connect = time.perf_counter()
        async for raw in ws:
            event = json.loads(raw)
            if event["type"] == "session.queue_done":
                await ws.send(json.dumps({"type": "session.init", "payload": {
                    "system_prompt": SYSTEM_PROMPT, "config": DECODE}}))
            elif event["type"] == "session.created":
                break
            elif event["type"] in {"error", "session.closed"}:
                raise RuntimeError(f"session start failed: {event}")
        t_created = time.perf_counter()

        async def receive() -> None:
            async for raw in ws:
                now = time.perf_counter()
                event = json.loads(raw)
                if event.get("kind") == "audio" and isinstance(event.get("audio"), str):
                    pcm = base64.b64decode(event.pop("audio"))
                    audio.extend(pcm)
                    event["audio_bytes"] = len(pcm)
                event["t"] = now
                events.append(event)

        receiver = asyncio.create_task(receive())
        t0 = time.perf_counter() + 0.5
        for chunk in range(chunks):
            await asyncio.sleep(max(0.0, t0 + chunk - time.perf_counter()))
            query, packet, last = plan.get(chunk, ("", silence, False))
            input_id = f"s{index}c{chunk}"
            body = {"audio": base64.b64encode(packet).decode(), "max_slice_nums": 1,
                    "video_frames": [base64.b64encode(frame_jpeg(chunk, index)).decode()],
                    "input_id": input_id}
            if query:
                body["force_listen"] = True
            t_send = time.perf_counter()
            await ws.send(json.dumps({"type": "input.append", "input": body}))
            sent[input_id] = {"chunk": chunk, "t_send": t_send, "query": query,
                              "query_last_packet": last}
        await asyncio.sleep(3)  # let the last chunks and any reply finish
        await ws.send(json.dumps({"type": "session.close", "reason": "user_stop"}))
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)

    # Join events to the chunk that produced them.
    first: dict[str, dict] = {}
    for event in events:
        if event.get("type") == "response.output.delta" and event.get("input_id") in sent:
            first.setdefault(event["input_id"], event)
    chunk_rows = []
    for input_id, s in sent.items():
        e = first.get(input_id)
        metrics = (e or {}).get("metrics") or {}
        chunk_rows.append({
            "config": label, "session": index, "input_id": input_id, **s,
            "t_send": s["t_send"] - t_created,
            "latency_s": None if e is None else round(e["t"] - s["t_send"], 6),
            "first_kind": None if e is None else e.get("kind"),
            "server_prefill_ms": metrics.get("prefill_ms"),
            "server_wall_ms": metrics.get("wall_clock_ms"),
            "server_generate_ms": metrics.get("generate_ms"),
            "n_tokens": metrics.get("n_tokens"),
            "n_tts_tokens": metrics.get("n_tts_tokens"),
            "kv_cache_length": metrics.get("kv_cache_length"),
            "vision_tokens": metrics.get("vision_tokens"),
            "chunk_usage": (e or {}).get("chunk_usage"),
            "metrics": metrics,
        })
    reply_rows = []
    for input_id, s in sent.items():
        if not s["query_last_packet"]:
            continue
        after = [e for e in events if e.get("type") == "response.output.delta" and e["t"] > s["t_send"]]
        text = next((e for e in after if e.get("kind") == "text"), None)
        speech = next((e for e in after if e.get("kind") == "audio"), None)
        reply_rows.append({
            "config": label, "session": index, "query": s["query"], "last_chunk": s["chunk"],
            "text_latency_s": None if text is None else round(text["t"] - s["t_send"], 4),
            "audio_latency_s": None if speech is None else round(speech["t"] - s["t_send"], 4),
            "text": "".join(e.get("text", "") for e in after if e.get("kind") == "text"
                            and e.get("response_id") == (text or {}).get("response_id")),
        })
    for event in events:
        event.update(config=label, session=index, t=round(event["t"] - t_created, 6))
    return {"chunks": chunk_rows, "events": events, "replies": reply_rows, "audio": bytes(audio),
            "session_start_s": round(t_created - t_connect, 4)}


@app.cls(
    image=bench_image,
    gpu=GPU_TYPES["H100"],  # replaced per call with with_options
    cpu=8,
    memory=64 * 1024,
    volumes={MODEL_ROOT: models, CACHE_ROOT: cache},
    timeout=60 * MINUTES,
)
class Bench:
    @modal.method()
    def run(self, label: str, sessions: int, chunks: int, query_every: int = 0) -> dict:
        gpu, variant = parse_config(label)
        precision, compile = VARIANTS[variant]
        started = time.monotonic()
        result: dict = {"config": label, "gpu": gpu, "variant": variant,
                        "requested": GPU_TYPES[gpu], "container_started_unix": time.time(),
                        "chunks": [], "events": [], "replies": [], "audio": {}, "vram": {}}
        stack = None
        with VramSampler() as vram:
            try:
                while not vram.samples:
                    time.sleep(0.05)
                idle = vram.samples[-1][1]
                stack = start_stack(precision, compile, log_dir=LOG_DIR)
                result["boot"] = {**stack.phases, "total": round(time.monotonic() - started, 3)}
                result["device"] = stack.gpu
                result["settings"] = {**stack.settings, "decode": DECODE}
                result["pip_freeze"] = subprocess.run(["pip", "freeze"], capture_output=True,
                                                      text=True).stdout.splitlines()
                result["vram"]["before_load_mib"] = idle
                result["vram"]["after_load_mib"] = vram.samples[-1][1] if vram.samples else None
                for index in range(sessions + 1):
                    wait_idle()
                    t_start = time.time()
                    session = asyncio.run(run_session(label, index, chunks if index else WARMUP_CHUNKS,
                                                      query_every))
                    result["vram"][f"session{index}_peak_mib"] = vram.peak_between(t_start, time.time())
                    for key in ("chunks", "events", "replies"):
                        result[key] += session[key]
                    result["audio"][f"session{index}"] = session["audio"]
            except Exception as exc:  # keep partial results
                result["error"] = f"{type(exc).__name__}: {exc}"
                result["log_tails"] = {
                    log.stem: log.read_text(errors="replace").splitlines()[-150:]
                    for log in sorted(Path(LOG_DIR).glob("*.log"))
                }
            finally:
                if stack is not None:
                    stack.stop()
        result["vram"]["peak_mib"] = max((m for _, m in vram.samples), default=None)
        result["vram_samples"] = vram.samples
        return result


def summarize(rows: list[dict], replies: list[dict]) -> dict:
    measured = [r for r in rows if r["session"] > 0]
    late = [r for r in measured if r["latency_s"] is not None]
    return {
        "chunk_latency_s": stats([r["latency_s"] for r in late]),
        "chunk_latency_listen_s": stats([r["latency_s"] for r in late if r["first_kind"] == "listen"]),
        "chunk_latency_speak_s": stats([r["latency_s"] for r in late if r["first_kind"] in {"text", "audio"}]),
        "server_prefill_ms": stats([r["server_prefill_ms"] for r in measured]),
        "server_wall_ms": stats([r["server_wall_ms"] for r in measured]),
        "server_generate_ms_speak": stats([r["server_generate_ms"] for r in measured
                                           if r["first_kind"] in {"text", "audio"}]),
        "reply_text_latency_s": stats([r["text_latency_s"] for r in replies if r["session"] > 0]),
        "reply_audio_latency_s": stats([r["audio_latency_s"] for r in replies if r["session"] > 0]),
        "chunks_without_output": sum(1 for r in measured if r["latency_s"] is None),
        "chunks_over_1s": sum(1 for r in late if r["latency_s"] > 1.0),
    }


@app.local_entrypoint()
def main(configs: str = "H100,H200,B200,B300,H100:awq,H100:compile", sessions: int = 3,
         chunks: int = 30, query_every: int = 0) -> None:
    labels = [c.strip() for c in configs.replace(" ", ",").split(",") if c.strip()]
    for label in labels:
        parse_config(label)
    out = OUT_ROOT / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (out / "audio").mkdir(parents=True)
    (out / "config.json").write_text(json.dumps(
        {"configs": labels, "sessions": sessions, "chunks": chunks, "warmup_chunks": WARMUP_CHUNKS,
         "queries": {"number every": query_every} if query_every else QUERIES,
         "decode": DECODE, "system_prompt": SYSTEM_PROMPT}, indent=2))
    print(f"Benchmarking {', '.join(labels)} in parallel; writing to {out}")

    spawned = time.time()
    calls = {}
    for label in labels:
        gpu, _ = parse_config(label)
        calls[label] = Bench.with_options(gpu=GPU_TYPES[gpu])().run.spawn(label, sessions, chunks,
                                                                          query_every)
    report = {}
    for label, call in calls.items():
        try:
            result = call.get()
        except Exception as exc:
            result = {"config": label, "chunks": [], "events": [], "replies": [], "audio": {},
                      "error": f"{type(exc).__name__}: {exc}"}
        result["spawned_unix"] = spawned
        rows, replies = result.pop("chunks"), result.pop("replies")
        for name, data in (("chunks", rows), ("events", result.pop("events")), ("replies", replies)):
            with open(out / f"{name}.jsonl", "a") as f:
                f.writelines(json.dumps(row) + "\n" for row in data)
        for session, pcm in result.pop("audio").items():
            import array

            samples = array.array("f", pcm)
            s16 = array.array("h", (max(-32768, min(32767, int(x * 32768))) for x in samples))
            with wave.open(str(out / "audio" / f"{label.replace(':', '-')}-{session}.wav"), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(OUTPUT_RATE)
                w.writeframes(s16.tobytes())
        with open(out / "boots.jsonl", "a") as f:
            f.write(json.dumps(result) + "\n")
        report[label] = {"boot": result.get("boot"), "vram": result.get("vram"),
                         "error": result.get("error"), **summarize(rows, replies)}
        print(f"{label}: {'error: ' + result['error'] if result.get('error') else 'done'}")
    (out / "summary.json").write_text(json.dumps(report, indent=2))

    def med(value: dict, scale: float = 1.0) -> str:
        return f"{value['median'] * scale:.0f}" if value.get("n") else "-"

    print(f"\n{'config':<14} {'boot s':>6} {'peak GiB':>8} {'chunk ms':>8} {'listen':>7} {'speak':>7} "
          f"{'prefill':>7} {'reply text s':>12} {'reply audio s':>13} {'>1s':>4}")
    for label in labels:
        r = report[label]
        boot = f"{r['boot']['total']:.0f}" if r.get("boot") else "-"
        peak = r.get("vram") or {}
        peak = f"{peak['peak_mib'] / 1024:.1f}" if peak.get("peak_mib") else "-"
        text = r["reply_text_latency_s"]
        speech = r["reply_audio_latency_s"]
        print(f"{label:<14} {boot:>6} {peak:>8} {med(r['chunk_latency_s'], 1000):>8} "
              f"{med(r['chunk_latency_listen_s'], 1000):>7} {med(r['chunk_latency_speak_s'], 1000):>7} "
              f"{med(r['server_prefill_ms']):>7} "
              f"{(str(text['median']) if text.get('n') else '-'):>12} "
              f"{(str(speech['median']) if speech.get('n') else '-'):>13} {r['chunks_over_1s']:>4}")
    print(f"\nFull logs: {out}")
