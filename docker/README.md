# Docker (off-cluster)

Runs the playground **UI** and **gateway** on a machine that is not the lab cluster. No Anaconda. JoyAI/webinfer stay on the cluster; forward those ports onto this host first.

## Why a Caddy proxy

Compose starts `ui` + `server`, plus a tiny **`proxy`** (Caddy) that is the only published port: **`127.0.0.1:3099`**.

Next.js 16 standalone *can* rewrite `/v1` and upgrade WebSockets, but that proxy **idle-times out after 30 seconds**. Live Sessions last longer, so Caddy terminates HTTP and `/v1/realtime` instead. Gateway `8787` is not published on the host.

```
browser  →  127.0.0.1:3099 (Caddy)
              /v1/*        →  server:8787   (catalog + WebSocket)
              everything else →  ui:3000
server   →  host.docker.internal:8070  (JoyAI forwarded on the host)
```

Leave **Server Address** blank (same origin). Do not set `127.0.0.1:8787`.

## Prerequisites

- Docker with Compose
- JoyAI webinfer forwarded to this machine (default `127.0.0.1:8070`)
- Optional: `GEMINI_API_KEY` in a repo-root `.env` (copy [`.env.example`](./.env.example)). Never commit real secrets.

## Start

From `live-vlm-demo/`:

```bash
# JoyAI on this host at 127.0.0.1:8070 — the default docker/config.toml
# already uses host.docker.internal:8070/v1
docker compose up -d --build
```

Open [http://127.0.0.1:3099](http://127.0.0.1:3099).

Tunnel that port out (or in):

```bash
ssh -N -L 3099:127.0.0.1:3099 user@this-machine
```

## JoyAI URL

`config.toml` `base_url` is the only catalog field. In Docker it must reach the **host**, not the container loopback:

| Where | `base_url` |
| --- | --- |
| Lab (`web-server/config.toml`) | `http://127.0.0.1:8070/v1` |
| Docker (default `docker/config.toml`) | `http://host.docker.internal:8070/v1` |

`extra_hosts: host.docker.internal:host-gateway` makes that hostname work on Linux. Docker Desktop already defines it.

Override without rebuilding:

```bash
# different forwarded port
JOYAI_BASE_URL=http://host.docker.internal:18070 docker compose up -d

# or bind-mount a full catalog
LIVE_VLM_CONFIG_FILE=./my-config.toml docker compose up -d
```

`JOYAI_BASE_URL` overrides every JoyAI row's `base_url`. A host-only URL (`http://host.docker.internal:8070`) gets `/v1` appended.

## Server Address / catalog

- Blank field → this page (`/v1/models` and `ws(s)://<that-host>/v1/realtime`)
- Browser never talks to `127.0.0.1:8787`
- SSR catalog uses `VLM_GATEWAY_URL=http://server:8787` inside the UI container

## Local lab (no Docker)

`yarn dev` and `python -m live_vlm_server` are unchanged. For a long local Session, you can still set Server Address to `127.0.0.1:8787` so the browser talks to the gateway directly.
