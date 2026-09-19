# VLM Playground

Desktop-first Next.js UI for the local Live VLM gateway. The page loads the HTTP Catalog, starts one WebSocket Session, and sends live camera Frames with optional Text.

Model communication goes only to the gateway. This app does not call the Vercel AI SDK.

## Requirements

- Node.js 20.9+
- Yarn 4
- Gateway listening on `VLM_GATEWAY_URL` (default `http://127.0.0.1:8787`)

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

`VLM_GATEWAY_URL` is the server-side FastAPI destination (default
`http://127.0.0.1:8787`). It is used only by Next.js rewrites.

The browser requests `/v1/models` and opens `/v1/realtime` on the frontend's
origin. Next.js proxies both HTTP and WebSocket traffic to FastAPI. An HTTPS
frontend uses `wss`; an HTTP frontend uses `ws`. FastAPI can stay on loopback HTTP.

Restart `yarn dev` or rebuild production after changing `VLM_GATEWAY_URL`.
This replaces the old `NEXT_PUBLIC_VLM_GATEWAY_URL` setting; rename it in any
existing `.env.local` file.

For an SSH tunnel, only forward the frontend port. For example, run the UI with
`yarn dev --hostname 127.0.0.1 --port 3001`, then on your laptop:

```bash
ssh -N -L 3001:127.0.0.1:3001 YOUR_HOST
```

Open `http://localhost:3001`. The gateway's port 8787 does not need forwarding.

## Camera and HTTPS

`getUserMedia` requires a [secure browser context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).

- `http://localhost` and `http://127.0.0.1` are secure during development.
- A remotely accessed lab deployment must use HTTPS, or an SSH/localhost tunnel so the browser still sees localhost.
- If the page is HTTPS, the browser uses `wss` to the frontend; the server-side gateway connection may still use HTTP.

## Session behavior

1. Choose a Catalog model and edit Config generated from `config_schema`.
2. Start requests camera permission, shows the live preview, opens `/v1/realtime`, and sends `session.start`.
3. Feeds start only after `session.started`. Frames are JPEG at about 1 fps, fitted within 1280×720.
4. Submitting Text captures a fresh Frame and sends both in one `input.append`.
5. Stop sends `session.end`, waits for `session.ended`, then closes the socket and clears Session timers. A timeout still closes and surfaces an error. This version does not reconnect automatically.

## Layout

Full-height three columns: model/config on the left (~300px), 16:9 camera in the center, transcript and composer on the right (~380px).
