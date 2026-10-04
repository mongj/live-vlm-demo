"""Linux/PBS runtime supervision. Signal retained pidfds, never numeric PIDs/PGIDs.

Only the three direct children are signaled. PBS owns cleanup of any descendants.
The shell launcher retains its runtime lock across exec into this process.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from urllib.request import Request, urlopen

import safety as runtime_safety


class StopRequested(Exception):
    def __init__(self, signum):
        self.signum = signum
        super().__init__(f"Received signal {signum}")


class OwnedChild:
    def __init__(self, name, process, log):
        self.name, self.process, self.log = name, process, log
        self.pidfd = None


class RuntimeSupervisor:
    def __init__(self, *, source_dir, scripts_dir, model_path, log_dir, job_id,
                 python=sys.executable, grace_seconds=10, kill_wait_seconds=5):
        self.source_dir, self.scripts_dir = Path(source_dir), Path(scripts_dir)
        self.model_path, self.log_dir = Path(model_path), Path(log_dir)
        self.job_id, self.python = job_id, python
        self.grace_seconds, self.kill_wait_seconds = grace_seconds, kill_wait_seconds
        self.children = []
        self.stop_signal = None
        self.closed = False

    def request_stop(self, signum, frame):
        self.stop_signal = signum

    def ensure_running(self):
        if self.stop_signal is not None:
            raise StopRequested(self.stop_signal)
        for child in self.children:
            status = child.process.poll()
            if status is not None:
                raise RuntimeError(f"Owned {child.name} exited with status {status}; inspect its job log")

    def start_child(self, name, command):
        self.ensure_running()
        log = (self.log_dir / f"{name}-{self.job_id}.log").open("wb")
        try:
            process = subprocess.Popen(command, cwd=self.source_dir, stdout=log,
                                       stderr=subprocess.STDOUT, start_new_session=True)
        except BaseException:
            log.close()
            raise
        child = OwnedChild(name, process, log)
        self.children.append(child)
        # No poll/wait occurs between Popen and pidfd_open. With SIGCHLD default,
        # even an immediately exited child remains unreaped, preventing PID reuse.
        try:
            child.pidfd = os.pidfd_open(process.pid, 0)
        except OSError as error:
            raise RuntimeError(f"Cannot obtain pidfd for {name}; no numeric signal fallback. "
                               "PBS must clean up this job's descendants") from error

    def wait_health(self, role, url, seconds):
        deadline = time.monotonic() + seconds
        while True:
            self.ensure_running()
            if time.monotonic() >= deadline:
                raise RuntimeError(f"{role} health did not become ready within {seconds}s")
            ready = False
            try:
                with urlopen(url, timeout=2) as response:
                    ready = runtime_safety.health_ready(role, json.load(response))
            except (OSError, ValueError):
                pass
            self.ensure_running()
            if ready:
                return
            time.sleep(0.2)

    def register_worker(self):
        self.ensure_running()
        request = Request(
            "http://127.0.0.1:18007/internal/workers/minicpm-runtime",
            data=b'{"endpoint":"127.0.0.1:22400","gpu_group":"pbs-one-gpu"}',
            headers={"content-type": "application/json"}, method="PUT")
        with urlopen(request, timeout=10) as response:
            response.read(4096)
        self.ensure_running()

    def monitor(self):
        while True:
            self.ensure_running()
            time.sleep(0.2)

    def _signal_children(self, signum):
        for child in reversed(self.children):
            if child.pidfd is None:
                continue
            try:
                signal.pidfd_send_signal(child.pidfd, signum, None, 0)
            except ProcessLookupError:
                pass  # This exact process already exited; never look up its old PID.
            except OSError as error:
                print(f"Could not signal owned {child.name} pidfd: {error}; PBS teardown remains required", file=sys.stderr)

    def _wait_children(self, seconds):
        deadline = time.monotonic() + seconds
        while True:
            if all(child.process.poll() is not None for child in self.children):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))

    def cleanup(self):
        if self.closed:
            return
        self.closed = True
        try:
            self._signal_children(signal.SIGTERM)
            if not self._wait_children(self.grace_seconds):
                self._signal_children(signal.SIGKILL)
                if not self._wait_children(self.kill_wait_seconds):
                    print("Some direct children remain after bounded pidfd cleanup; PBS job teardown must finish cleanup", file=sys.stderr)
        finally:
            for child in self.children:
                if child.pidfd is not None:
                    os.close(child.pidfd)
                    child.pidfd = None
                child.log.close()

    def run(self):
        try:
            # cuda:0 is the process-local ordinal after verified UUID masking.
            self.start_child("backend", [self.python, "-m", "py_backend.server", "--host", "127.0.0.1",
                "--port", "22500", "--gpu-id", "0", "--model-path", str(self.model_path)])
            self.wait_health("backend", "http://127.0.0.1:22500/health", 600)
            self.start_child("worker", [self.python, "worker.py", "--host", "127.0.0.1", "--port", "22400",
                "--gpu-id", "0", "--backend-server-url", "http://127.0.0.1:22500"])
            self.wait_health("worker", "http://127.0.0.1:22400/health", 60)
            self.start_child("gateway", [self.python, str(self.scripts_dir / "gateway_private.py"),
                "--host", "127.0.0.1", "--port", "18006", "--internal-port", "18007", "--http", "--lang", "en"])
            self.wait_health("registry", "http://127.0.0.1:18007/health", 60)
            self.register_worker()
            self.wait_health("gateway", "http://127.0.0.1:18006/status", 60)
            print("RUNTIME_CAPACITY_READY: video endpoint ws://127.0.0.1:18006/v1/realtime?mode=video", flush=True)
            print("Capacity ready is not proof of successful inference. Bind tunnels to loopback only.", flush=True)
            self.monitor()
        finally:
            self.cleanup()
