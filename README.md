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

Start the frontend. This builds the production bundle, then serves it:

```bash
make client
```

Run both commands from the repository root. They start detached `screen` sessions
named `live-vlm-server` and `live-vlm-client` and print attach and delete commands.
Output stays visible when attached and is saved to `logs/server.screen.log` and
`logs/client.screen.log`. Detach with Ctrl+A, then D. Sessions survive logout.
Repeated commands reuse the existing session; delete it first to apply changed
settings or to rebuild. No manual Conda activation is needed. Override the
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
delete the client screen and run `make client` again so the production build
picks up the new value.

### JoyAI on a PBS compute node

Run `make joyai` on the login/gateway host (`caquelon`). It selects the first
supported node with enough free GPUs and RAM whose JoyAI startup files are
present, asks for confirmation, submits the PBS job, and returns with the job ID
and commands to start and stop the tunnel. Nodes that fail that file check are
skipped. The job may still be queued; submission does not mean the model servers
are ready.

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
stops it at its walltime limit (default four hours, configurable with
`make joyai JOYAI_WALLTIME=02:00:00`). Each confirmed `make joyai` invocation
submits a new job. Stop an existing tunnel before starting a replacement.

Check the job with `qstat JOB_ID` and watch startup logs with:

```bash
tail -n 50 -F joyai/logs/joyai_web.run.log joyai/logs/webinfer.log
```

`make joyai` requires `pbsnodes`, `qsub`, `jq`, `ssh`, and `timeout`. Starting the tunnel requires
`screen`, `ssh`, and SSH key access to the selected compute node. The gateway
catalog keeps `base_url = "http://127.0.0.1:8070/v1"`. The Mac still forwards only
the frontend port.

### MiniCPM-o 4.5 live video (experimental)

This app supplies the adapter, not the GPU model server. `make install`,
`make server` and `make client` do **not** start MiniCPM; there is no
`make minicpm` target.

1. **Prepare the model runtime separately.** Follow the pinned
   [MiniCPM-o-Demo setup guide](https://github.com/OpenBMB/MiniCPM-o-Demo/tree/47709a9210dfd71afa76c058e017fc8c4db5c8d2#quick-start).
   Its PyTorch setup requires Linux and an NVIDIA GPU with more than 28 GB VRAM.
   On a cluster, use your own scheduler allocation, never a login-node GPU or
   another user's allocation. Start its gateway, worker and backend; wait for
   model loading and worker readiness before starting an app session.
2. **Protect the runtime before use.** Disable upstream recording in the effective
   configuration (`"recording": {"enabled": false}`), and block recording-upload
   and debug-trace routes. For Docker, verify the configuration is mounted and
   applied; editing a host `config.json` alone does not configure the containers.
   Expose only the video WebSocket and necessary health endpoints. Internal
   services lack per-user authentication, so loopback alone does not isolate
   users on a shared machine. Use nonsensitive test clips only until appropriate
   authentication/isolation is in place; the app does not provide these protections.
3. **Connect the app gateway to the protected video endpoint.** The existing entry
   in `web-server/config.toml` is:

   ```toml
   [[models]]
   id = "minicpm-o-4-5"
   adapter = "minicpm"
   label = "MiniCPM-o 4.5 (Live video)"
   base_url = "ws://127.0.0.1:18006/v1/realtime?mode=video"
   ```

   For a remote runtime, run the tunnel on the machine running this app's
   **FastAPI gateway**, not necessarily your laptop. This example assumes the
   protected endpoint is configured on remote loopback port 18006:

   ```bash
   ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:18006:127.0.0.1:18006 YOUR_ALLOCATED_GPU_HOST
   ```

   Replace the host and remote port as appropriate; add your approved SSH jump
   configuration if needed. Keep the tunnel open. Port 18006 is the app's example
   endpoint, not a guarantee of upstream defaults. Keep the catalog ID unchanged:
   the UI uses it to disable unsupported typed follow-ups.
4. **Start the app** with `make install`, `make server` and `make client` from
   the repository root (see the restart instructions above for existing sessions).
   Open the frontend, select **MiniCPM-o 4.5 (Live video)**, and set **System prompt**
   before **Start Session**. Use the video library to select a short nonsensitive
   clip and start playback. Text and generated speech appear when the model
   responds; silent video input does not guarantee an immediate answer.
5. **Stop Session** when finished. Close your tunnel and release your own GPU job
   separately; stopping the browser session does not shut down the model server.

**Limits and troubleshooting:** typed follow-ups and natural-language
pause/repeat/step controls are not supported by this integration. With no audio
input, the adapter supplies silence. Sessions last at most five minutes; start a
new session after the limit. Connection-refused/startup-timeout errors mean you
should check the endpoint, tunnel, loaded model and idle worker. A visible catalog
entry alone does not prove the GPU runtime is ready. Treat `input_overload` or
keepalive failures as failed runs; reduce the test scope or use a faster allocated
GPU rather than disabling timeouts.

Short-clip smoke tests produced image-grounded text and non-silent audio, but a
184-second stream exceeded the tested GPU's processing capacity. These are not
benchmark scores or proof of sustained real-time performance, speech quality or
procedure guidance. The test runtime included local bounded-ingress/cleanup
repairs not shipped in this app or the pinned upstream release; keep testing
single-session. Publishing this adapter does not deploy that runtime.

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
yarn test
yarn build
```
