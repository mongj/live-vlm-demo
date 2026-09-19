# Live VLM playground

`web-ui` is the Next.js client; `web-server` is the FastAPI gateway to downstream
models. Both use the `live-vlm-demo` Conda environment.

## Install

Run from the repository root:

```bash
make install
```

Conda must already be installed and on `PATH` (or pass
`CONDA=/path/to/conda`). This creates `live-vlm-demo` from `environment.yml` if
missing, then installs Corepack, Yarn 4.9.2, the gateway with development
dependencies, and the locked frontend dependencies. Existing environments are
reused, so the command can be rerun. Commands run inside the environment via
`conda run`; manual activation is not needed for installation.

Python and Node.js live in the Conda environment. The gateway is installed in
editable mode, and frontend packages (including Next.js) live in
`web-ui/node_modules`, using the checked-in Yarn lockfile. Model runtimes such as
JoyAI/vLLM use their own environments.

## Run

Start the gateway:

```bash
make server
```

Start the frontend:

```bash
make client
```

Run both commands from the repository root. They start detached `screen` sessions
named `live-vlm-server` and `live-vlm-client` and print attach and delete commands.
Output stays visible when attached and is saved to `logs/server.screen.log` and
`logs/client.screen.log`. Detach with Ctrl+A, then D. Sessions survive logout.
Repeated commands reuse the existing session; delete it first to apply changed
settings. No manual Conda activation is needed. Override the
frontend port with `make client CLIENT_PORT=3002`, or the gateway port with
`LIVE_VLM_PORT=9001 make server` (also update `VLM_GATEWAY_URL` for the frontend).

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

Run `make joyai` on the login/gateway host (`caquelon`). It selects an available
supported node, asks for confirmation, submits the PBS job, and returns with the
job ID and commands to start and stop the tunnel. The job may still be queued;
submission does not mean the model servers are ready.

Run the printed tunnel command on the same login/gateway host. For example,
if the selected node is `cvml01`:

```bash
screen -dmS live-vlm-joyai-tunnel ssh -NT -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ControlMaster=no -o ControlPath=none -L 127.0.0.1:8070:127.0.0.1:8070 cvml01
```

Stop the tunnel with:

```bash
screen -S live-vlm-joyai-tunnel -X quit
```

The tunnel and PBS job are independent. Closing the tunnel leaves the job running;
stop the job with `qdel JOB_ID`, using the ID printed by `make joyai`. PBS also
stops it at its walltime limit (default one hour, configurable with
`make joyai JOYAI_WALLTIME=02:00:00`). Each confirmed `make joyai` invocation
submits a new job. Stop an existing tunnel before starting a replacement.

Check the job with `qstat JOB_ID` and watch startup logs with:

```bash
tail -n 50 -F joyai/logs/webinfer.log
```

`make joyai` requires `pbsnodes`, `qsub`, and `jq`. Starting the tunnel requires
`screen`, `ssh`, and SSH key access to the selected compute node. The gateway
catalog keeps `base_url = "http://127.0.0.1:8070/v1"`. The Mac still forwards only
the frontend port.

## Docker (off-cluster)

On a machine without Anaconda, with JoyAI ports forwarded to that host:

```bash
docker compose up -d --build
```

Only `127.0.0.1:3099` is published. See [docker/README.md](docker/README.md).

## Verify

```bash
conda activate live-vlm-demo
python -m pip check
cd web-server
python -m pytest
cd ../web-ui
yarn build
```
