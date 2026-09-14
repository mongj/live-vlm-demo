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

Run `make joyai` on the login/gateway host (`caquelon`). After the submission
confirmation, it starts a detached screen named `live-vlm-joyai`. Its supervisor
submits the PBS job, waits for its assigned node, starts the internal SSH tunnel,
and checks the adapter plus both model servers. Watch startup with:

```bash
screen -r live-vlm-joyai
```

Detach with **Ctrl+A, then D** to keep the job and tunnel running. Stop both by
deleting the screen (or pressing Ctrl+C while attached):

```bash
screen -S live-vlm-joyai -X quit
```

There are no separate tunnel commands. If SSH exits, the supervisor cancels the
PBS job. If the PBS job ends, moves, or cannot be queried, it stops the tunnel
and requests job cancellation. Monitoring polls PBS every 5 seconds. Startup
failure or timeout also cancels the job. Configure the startup timeout with
`make joyai JOYAI_WAIT_SECONDS=2400` (default 1800 seconds).

Repeated `make joyai` calls reuse the existing screen. Stop it first to launch a
replacement. Logs are retained in `joyai/logs/session.screen.log` and
`joyai/logs/session.log`; the latter also records cleanup after screen deletion.
The screen also shows the last 50 lines and live output from
`joyai/logs/webinfer.log` (combined adapter and model-server logs). The follower
waits if the file is missing and follows it if recreated. It stops with the
supervisor; the SSH tunnel continues running in the background while you view logs.
If PBS cancellation fails after retries, `session.log` records the job ID and
manual `qdel` command. Forced SIGKILL or a login-host crash cannot run cleanup;
PBS walltime remains the final limit in those cases.

The helper requires `screen`, `ssh`, `curl`, `jq`, `flock`, `python3`, and PBS
commands, plus SSH key access to the assigned compute node. The gateway catalog
keeps `base_url = "http://127.0.0.1:8070/v1"`. The Mac still forwards only the
frontend port.

## Verify

```bash
conda activate live-vlm-demo
python -m pip check
cd web-server
python -m pytest
cd ../web-ui
yarn build
```
