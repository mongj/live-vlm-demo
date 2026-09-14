# VLM Playground

Desktop-first Next.js UI for the local Live VLM gateway. The page loads the HTTP Catalog, starts one WebSocket Session, and sends live camera Frames with optional Text.

Model communication goes only to the gateway. This app does not call the Vercel AI SDK.

## Requirements

- Node.js 20.9+
- Yarn 4
- Gateway listening on `NEXT_PUBLIC_VLM_GATEWAY_URL` (default `http://127.0.0.1:8787`)

## Setup

```bash
cd web-ui
yarn install
cp .env.example .env.local
yarn dev
```

Open `http://localhost:3000`.

Production-style local run:

```bash
yarn build
yarn start
```

## Gateway URL

`NEXT_PUBLIC_VLM_GATEWAY_URL` is the gateway HTTP origin.

| Value | Result |
| --- | --- |
| `http://127.0.0.1:8787` (default) | Catalog HTTP and `ws://127.0.0.1:8787/v1/realtime` |
| `https://host.example/path` | Catalog HTTP and `wss://host.example/path/v1/realtime` |

The realtime socket always connects to that origin. Catalog discovery first requests `GET {gateway}/v1/models`. If the browser blocks that cross-origin request, the UI falls back to same-origin `/v1/models`, which Next.js rewrites to the gateway.

Restart `yarn dev` or rebuild after changing the env var.

## Camera and HTTPS

`getUserMedia` requires a [secure browser context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).

- `http://localhost` and `http://127.0.0.1` are secure during development.
- A remotely accessed lab deployment must use HTTPS, or an SSH/localhost tunnel so the browser still sees localhost.
- If the page is HTTPS, the gateway URL must also be HTTPS so the WebSocket can use `wss`. Mixed content will fail.

## Session behavior

1. Choose a Catalog model and edit Config generated from `config_schema`.
2. Start requests camera permission, shows the live preview, opens `/v1/realtime`, and sends `session.start`.
3. Feeds start only after `session.started`. Frames are JPEG at about 1 fps, fitted within 1280×720.
4. Submitting Text captures a fresh Frame and sends both in one `input.append`.
5. Stop closes the socket, stops camera tracks, and clears timers. This version does not reconnect automatically.

## Layout

Full-height three columns: model/config on the left (~300px), 16:9 camera in the center, transcript and composer on the right (~380px).
