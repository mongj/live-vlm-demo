# Live VLM gateway

Python gateway for the live VLM playground. Clients discover Models over HTTP and run one Session per WebSocket. The shipped catalog is **JoyAI-VL** (HTTP webinfer), **Gemini 3.8 Live**, and an in-process **Mock**.

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
| `GEMINI_API_KEY` | unset | Required to start a Gemini Live Session. Loaded from the process environment or `web-server/.env`. |
| `JOYAI_BASE_URL` | unset | Optional override of every JoyAI row's `base_url` in the catalog. Accepts `http(s)://host:port` or `.../v1`. |

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
            "t": 1726700000123,
        }))
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
`JOYAI_BASE_URL` overrides that field without editing the file.

Off-cluster Docker uses `host.docker.internal` instead of `127.0.0.1`. See [../docker/README.md](../docker/README.md).

The PBS launcher ([scripts/joyai.pbs](../scripts/joyai.pbs)) uses these ports:

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
  "t": 1726700000123
}
```

JoyAI ignores Audio. A successful visual turn returns one `response.chunk` with presentable `text`, exact `raw`, `audio: null`, and `final: true`.

## Gemini 3.8 Live

`config.toml` registers the Live API adapter. It does not take `base_url`.

```toml
[[models]]
id = "gemini-3-8-live"
adapter = "gemini"
label = "Gemini 3.8 Live"
```

Put `GEMINI_API_KEY` in the environment or in `web-server/.env` (not committed). Restart the gateway after changing the catalog or `.env`.

Start Config is `system_instruction` (optional) and `voice` (`Kore` by default). The adapter sends JPEG Frames (at most 1 fps), 16 kHz PCM Audio, and Text over `send_realtime_input`. Replies map Gemini audio chunks to `response.chunk.audio`, output transcriptions to `text`/`raw`, input transcriptions (final, or interim if that event has no final) to `raw` as `[input] …`, and `turn_complete`/`interrupted` to `final: true`. Interrupted turns also set `interrupted: true` so the playground can stop leftover Reply Audio. The playground Transcript renders those `[input]` lines as user turns. Video is included in the next speech/text turn (`TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO`); frames do not start a turn. Tools, custom VAD, thinking, and `proactive_audio` are not exposed (`proactive_audio` lets Gemini stay silent and is unsupported on Gemini 3.x Live).

The playground sidebar lists this row from `GET /v1/models`. Camera Frames, microphone PCM, typed Text, and Reply Audio playback work with the current UI.

## Live verification

Offline Catalog discovery and Mock Sessions are covered by `python -m pytest`.

Live JoyAI Start/reset, one visual turn, presentable versus Raw output, and Session cleanup against a deployed webinfer endpoint are recorded here when that route is available.

**Status (2026-09-15):** verified against PBS job `120424.caquelon` on `cvml01`.
An internal SSH tunnel connects the gateway host's `127.0.0.1:8070` to the compute
node's loopback adapter. Through frontend `ws://127.0.0.1:3001/v1/realtime`, a JoyAI
Session started successfully and a synthetic red JPEG returned `text: "Red"`,
`raw: "</response> Red"`, and `final: true`. The route depends on the running PBS
job and internal tunnel; see the root README for tunnel setup.

## Session wire

All messages are JSON text frames. JPEG and PCM use standard base64 (no data-URL prefix).

| Type | Direction | Meaning |
| --- | --- | --- |
| `session.start` | Client → server | Select one Model and start-only Config |
| `session.started` | Server → Client | Binding completed; includes effective Config |
| `session.end` | Client → server | Client wants a graceful stop; socket stays open |
| `session.ended` | Server → Client | Adapter/buffer cleanup finished; Client may close |
| `input.append` | Client → server | Feed with optional Frame, Audio, Text, and Frame timestamp |
| `response.chunk` | Server → Client | One Reply |
| `error` | Server → Client | Human-readable failure and `fatal` flag |

Stop sends `session.end` and waits for `session.ended` before closing the socket. A dropped connection without `session.end` still ends the Session.
