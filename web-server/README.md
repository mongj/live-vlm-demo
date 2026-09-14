# Live VLM gateway

Python gateway for the live VLM playground. Clients discover Models over HTTP and run one Session per WebSocket. V1 ships **JoyAI-VL** (HTTP webinfer) and an in-process **Mock**.

The process is a trusted-user playground. It binds to localhost by default.

## Setup

From this directory (`web-server`):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Requires Python 3.12+.

## Run

```bash
python -m live_vlm_server
```

Defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LIVE_VLM_CONFIG` | `./config.toml` | Catalog file, relative to the working directory |
| `LIVE_VLM_HOST` | `127.0.0.1` | Bind host |
| `LIVE_VLM_PORT` | `8787` | Bind port |

```bash
LIVE_VLM_PORT=9001 python -m live_vlm_server
```

## HTTP Catalog

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | `{"ok": true}` — gateway process only |
| GET | `/v1/models` | `{"models": [{id, label, config_schema}, ...]}` |
| GET | `/v1/models/{id}` | One entry, or 404 |
| WS | `/v1/realtime` | Session protocol |

Discovery reads the local Catalog and Config schemas. It does not construct adapters or touch the network.

## Tests and type checks

```bash
python -m pytest
python -m mypy
```

## Mock Session example

Catalog discovery and Mock Sessions work without a cluster connection.

```bash
python - <<'PY'
import asyncio, base64, json, urllib.request
from websockets.asyncio.client import connect

JPEG = b"\xff\xd8\xff\xd9"

async def main() -> None:
    print(urllib.request.urlopen("http://127.0.0.1:8787/health").read())
    print(urllib.request.urlopen("http://127.0.0.1:8787/v1/models").read())
    async with connect("ws://127.0.0.1:8787/v1/realtime") as ws:
        await ws.send(json.dumps({
            "type": "session.start",
            "model": "mock",
            "config": {"latency_ms": 0},
        }))
        print(await ws.recv())
        await ws.send(json.dumps({
            "type": "input.append",
            "frame": base64.b64encode(JPEG).decode("ascii"),
            "text": "What is on the desk?",
            "t": 1.5,
        }))
        print(await ws.recv())
        print(await ws.recv())

asyncio.run(main())
PY
```

Install a WebSocket client first if needed: `pip install websockets`.

## JoyAI configuration

`config.toml` points JoyAI at webinfer:

```toml
[[models]]
id = "joyai-vl"
adapter = "joyai"
label = "JoyAI-VL-Interaction"
base_url = "http://127.0.0.1:8070/v1"
```

Edit `base_url` when the tunnel or local port differs. It must be HTTP(S) and end in `/v1`.

The PBS launcher (`scripts/joyai/joyai_web.pbs`) uses these ports:

| Service | Default port | Role |
| --- | --- | --- |
| Gateway | 8787 | This process: HTTP and WebSocket |
| webinfer | 8070 | JoyAI Session and visual-turn HTTP API |
| vLLM | 7060 | Model inference used by webinfer |

When webinfer is bound to compute-node loopback, forward that port to the job node and keep `base_url` on the forwarded local address. Example from a Mac, after the job is running on `cvml10`:

```bash
ssh -L 8070:cvml10:8070 cvml-cluster
```

Then Start a JoyAI Session:

```json
{
  "type": "session.start",
  "model": "joyai-vl",
  "config": {
    "system_prompt_key": "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION",
    "max_frames_per_request": 2
  }
}
```

```json
{
  "type": "input.append",
  "frame": "<jpeg base64>",
  "text": "What is on the desk?",
  "t": 1.5
}
```

JoyAI ignores Audio. A successful visual turn returns one `response.chunk` with presentable `text`, exact `raw`, `audio: null`, and `final: true`.

## Live verification

Offline Catalog discovery and Mock Sessions are covered by `python -m pytest`.

Live JoyAI Start/reset, one visual turn, presentable versus Raw output, and Session cleanup against a deployed webinfer endpoint are recorded here when that route is available.

**Status (2026-09-14):** pending. `http://127.0.0.1:8070/health` was not reachable from this machine, so reset and inference were not smoke-tested against a live webinfer job. Offline Catalog, Mock Sessions, and JoyAI-adapter contract tests with a fake HTTP transport all pass.

## Session wire

All messages are JSON text frames. JPEG and PCM use standard base64 (no data-URL prefix).

| Type | Direction | Meaning |
| --- | --- | --- |
| `session.start` | Client → server | Select one Model and start-only Config |
| `session.started` | Server → Client | Binding completed; includes effective Config |
| `input.append` | Client → server | Feed with optional Frame, Audio, Text, and Frame timestamp |
| `response.chunk` | Server → Client | One Reply |
| `error` | Server → Client | Human-readable failure and `fatal` flag |
