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

Next.js proxies browser HTTP and WebSocket traffic to FastAPI on localhost.
Only the frontend port needs forwarding. Run on your laptop, replacing
`YOUR_HOST` with this machine's SSH host:

```bash
ssh -N -L 3001:127.0.0.1:3001 YOUR_HOST
```

Then open `http://localhost:3001`. To change the gateway destination, set
`VLM_GATEWAY_URL` in `web-ui/.env.local` (default `http://127.0.0.1:8787`), then
restart development or rebuild production.

### JoyAI on a PBS compute node

When the gateway runs on the login node and JoyAI runs on a compute node,
connect their loopback ports with an internal tunnel. On the login node, replace
`cvml01` with the running job's node (shown by `qstat -f JOB_ID`):

```bash
ssh -fNT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8070:127.0.0.1:8070 cvml01
curl -fsS http://127.0.0.1:8070/health
```

This requires SSH key access from the login node to the compute node. The gateway
catalog can keep `base_url = "http://127.0.0.1:8070/v1"`. A replacement PBS job
may run on another node; stop the old internal tunnel before starting one to the
new node. The model stops when its PBS walltime expires. The Mac still forwards
only the frontend port.

## Verify

```bash
conda activate live-vlm-demo
python -m pip check
cd web-server
python -m pytest
cd ../web-ui
yarn build
```
