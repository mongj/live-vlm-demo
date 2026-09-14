# Live VLM playground

`web-ui` is the Next.js client; `web-server` is the FastAPI gateway to downstream
models. Both use the `live-vlm-demo` Conda environment.

## Install

Run from the repository root:

```bash
conda env create -f environment.yml
conda activate live-vlm-demo
npm install --global corepack
corepack enable
corepack install --global yarn@4.9.2
python -m pip install -e './web-server[dev]'
cd web-ui
yarn install --immutable
```

Python and Node.js live in the Conda environment. The gateway is installed in
editable mode, and frontend packages (including Next.js) live in
`web-ui/node_modules`, using the checked-in Yarn lockfile. Model runtimes such as
JoyAI/vLLM use their own environments.

## Run

Gateway, in one terminal:

```bash
conda activate live-vlm-demo
cd /home/mingjun/live-vlm-demo/web-server
python -m live_vlm_server
```

Frontend, in another terminal:

```bash
conda activate live-vlm-demo
cd /home/mingjun/live-vlm-demo/web-ui
yarn dev --hostname 127.0.0.1 --port 3001
```

The frontend listens on port 3001; the gateway listens on port 8787.
Port 3000 is already occupied on this machine.
The Mock model works without a downstream model service.

The current client opens its WebSocket directly to browser-local port 8787.
Until the client uses a same-origin WebSocket proxy, remote use needs both ports
forwarded. Run on your laptop, replacing `YOUR_HOST` with this machine's SSH host:

```bash
ssh -N -L 3001:127.0.0.1:3001 -L 8787:127.0.0.1:8787 YOUR_HOST
```

Then open `http://localhost:3001`. Forwarding only port 3001 currently supports
the catalog rewrite, but does not route the client's WebSocket to this machine.

## Verify

```bash
conda activate live-vlm-demo
python -m pip check
cd web-server
python -m pytest
cd ../web-ui
yarn build
```
