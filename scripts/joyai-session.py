#!/usr/bin/env python3
"""Own a PBS job and its SSH tunnel for the lifetime of one screen session."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


LOG_PATH = None


def log(message, **kwargs):
    # Screen's terminal may already be gone when its SIGHUP triggers cleanup.
    if LOG_PATH is not None:
        with LOG_PATH.open('a') as stream:
            stream.write(str(message) + '\n')
    try:
        print(message, **kwargs)
    except OSError:
        pass


class Session:
    def __init__(self, args):
        self.args = args
        self.job = None
        self.tunnel = None
        self.log_follower = None
        self.stopping = False

    def stop(self, *_):
        self.stopping = True

    def run_command(self, command, timeout=15):
        return subprocess.run(command, text=True, capture_output=True, timeout=timeout)

    def check_stop(self):
        if self.stopping:
            raise RuntimeError('Screen closed or stop requested')
        if self.tunnel is not None and self.tunnel.poll() is not None:
            raise RuntimeError('SSH tunnel exited')

    def pause(self):
        deadline = time.monotonic() + self.args.poll
        while time.monotonic() < deadline:
            self.check_stop()
            time.sleep(min(.2, max(0, deadline - time.monotonic())))

    def job_info(self):
        result = self.run_command(['qstat', '-f', '-F', 'json', self.job])
        if result.returncode:
            raise RuntimeError(f'PBS job ended or cannot be queried: {result.stderr.strip()}')
        jobs = json.loads(result.stdout)['Jobs']
        if len(jobs) != 1:
            raise RuntimeError('Expected exactly one PBS job')
        info = next(iter(jobs.values()))
        state = info['job_state']
        if state not in ('Q', 'W', 'T', 'R'):
            raise RuntimeError(f'PBS job entered state {state}')
        return state, info.get('exec_host', '').split('/')[0]

    def run(self):
        self.check_stop()
        result = self.run_command([
            'qsub', '-N', 'joyai_backend', '-j', 'oe', '-o', self.args.log,
            '-l', f'select=1:ngpus=3:mem={self.args.mem}:host={self.args.node}',
            '-l', f'walltime={self.args.walltime}', self.args.script,
        ], timeout=120)
        if result.returncode:
            raise RuntimeError(f'qsub failed: {result.stderr.strip()}')
        self.job = result.stdout.strip()
        log(f'Submitted PBS job {self.job}', flush=True)
        webinfer_log = Path(self.args.log).parent / 'webinfer.log'
        log(f'Following {webinfer_log} (last 50 lines, then live output)', flush=True)
        self.log_follower = subprocess.Popen([
            'tail', '-n', '50', '-F', '--', str(webinfer_log),
        ])
        deadline = time.monotonic() + self.args.wait
        while True:
            self.check_stop()
            state, node = self.job_info()
            if state == 'R':
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Timed out waiting for PBS assignment')
            self.pause()
        if not node or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-' for c in node) or node.startswith('-'):
            raise RuntimeError('Invalid PBS node')
        log(f'Job running on {node}; starting localhost:8070 tunnel', flush=True)
        # No -f or ControlPersist: this process owns the foreground SSH child.
        self.tunnel = subprocess.Popen([
            'ssh', '-NT', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
            '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10',
            '-o', 'ServerAliveCountMax=3', '-o', 'ControlMaster=no',
            '-o', 'ControlPath=none',
            '-L', '127.0.0.1:8070:127.0.0.1:8070', node,
        ])
        ready = False
        while True:
            self.check_stop()
            state, current_node = self.job_info()
            if state != 'R' or current_node != node:
                raise RuntimeError('PBS job stopped or moved')
            if not ready:
                adapter = self.run_command(['curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:8070/health'])
                if adapter.returncode == 0:
                    models = self.run_command([
                        'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', node,
                        'curl -fsS --max-time 5 http://127.0.0.1:7060/v1/models >/dev/null && '
                        'curl -fsS --max-time 5 http://127.0.0.1:8065/v1/models >/dev/null',
                    ])
                    self.check_stop()
                    if models.returncode == 0:
                        ready = True
                        log(f'JoyAI ready: job {self.job}, localhost:8070 -> {node}:8070', flush=True)
                if not ready and time.monotonic() >= deadline:
                    raise RuntimeError('Timed out waiting for JoyAI readiness')
            self.pause()

    def cleanup(self):
        for child in (self.log_follower, self.tunnel):
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        if self.job:
            log(f'Cancelling PBS job {self.job}', flush=True)
            for _ in range(3):
                try:
                    result = self.run_command(['qdel', self.job], timeout=15)
                    if result.returncode == 0 or 'Unknown Job Id' in result.stderr:
                        log('PBS job removed; tunnel stopped', flush=True)
                        return
                    log(result.stderr.strip(), flush=True)
                except subprocess.TimeoutExpired:
                    log('qdel timed out; retrying', flush=True)
                time.sleep(1)
            log(f'ERROR: cancellation could not be confirmed. Run: qdel {self.job}', file=sys.stderr, flush=True)


def main():
    global LOG_PATH
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--script', required=True)
    parser.add_argument('--log', required=True)
    parser.add_argument('--walltime', default='01:00:00')
    parser.add_argument('--mem', default='64gb')
    parser.add_argument('--wait', type=float, default=float(os.environ.get('JOYAI_WAIT_SECONDS', '1800')))
    parser.add_argument('--poll', type=float, default=5)
    args = parser.parse_args()
    if args.wait <= 0 or args.poll <= 0:
        parser.error('wait and poll must be positive')
    Path(args.log).parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH = Path(args.log).parent / 'session.log'
    session = Session(args)
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, session.stop)
    try:
        session.run()
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        log(str(exc), file=sys.stderr, flush=True)
        return 1
    finally:
        session.cleanup()
    return 0


if __name__ == '__main__':
    sys.exit(main())
