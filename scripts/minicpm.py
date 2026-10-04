#!/usr/bin/env python3
"""Manage one prepared, user-reviewed guarded PBS runtime. No provisioning or SSH.

Requires Python 3.10+, POSIX locking and PBS qsub/qstat/qdel. Supply site values
through MINICPM_* environment variables or the corresponding data-only options;
keep them outside Git. Defaults request one GPU, 8 CPUs, 64 GB and 45 minutes.
MINICPM_RUNTIME_ROOT selects the bundled launcher after checking its separately
prepared runtime. Alternatively, supply MINICPM_LAUNCHER and MINICPM_MODEL_PATH;
that external launcher must enforce allocation, integrity, privacy and owned-child
cleanup guards and serve loopback port 18006. Start never installs a runtime or
renews SSH keys. --yes (or
MINICPM_YES=1) explicitly skips submission/deletion confirmation. Private receipts
track only jobs submitted here, not existing manual jobs. Unknown PBS state or
ambiguous submission requires manual reconciliation: do not erase the receipt or
resubmit blindly. Readiness/inference and final resource release remain unverified.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import uuid

JOB_ID = re.compile(r"[1-9][0-9]*\.[A-Za-z0-9][A-Za-z0-9.-]*")
TOKEN = re.compile(r"[0-9a-f]{32}")
HOST = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]*")
STATES = {"Q": "queued", "R": "running", "E": "exiting", "F": "finished",
          "C": "finished", "H": "held", "W": "waiting", "S": "suspended",
          "T": "transiting", "B": "array-running", "M": "moved", "U": "suspended"}
TERMINAL = {"F", "C"}
TOKEN_KEY = "FYP_MINICPM_RUN_TOKEN"


def fail(message: str):
    raise ValueError(message)


def trusted(info: os.stat_result, *, directory: bool = False):
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        fail("State must be owned by the current user, private, and a regular file/directory")


@contextlib.contextmanager
def locked_state(path: Path):
    if not path.is_absolute():
        fail("MINICPM_STATE_DIR must be absolute")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.resolve() != path:
        fail("State directory must not traverse symlinks")
    trusted(path.lstat(), directory=True)
    fd = os.open(path / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        trusted(os.fstat(fd))
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("Another lifecycle command holds the private state lock")
        yield path
    finally:
        os.close(fd)


def read_state(path: Path):
    try:
        fd = os.open(path / "job.json", os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(fd) as handle:
        trusted(os.fstat(handle.fileno()))
        data = json.loads(handle.read(65537))
    if not isinstance(data, dict) or data.get("owner") != pwd.getpwuid(os.geteuid()).pw_name:
        fail("Invalid state owner; manual reconciliation required")
    token = data.get("token", "")
    if not isinstance(token, str) or not TOKEN.fullmatch(token) or data.get("name") != "fypmc-" + token[:8]:
        fail("Invalid private run identity; manual reconciliation required")
    if not isinstance(data.get("phase"), str) or data["phase"] not in {"submitting", "submitted", "stop-requested"}:
        fail("Invalid receipt phase; manual reconciliation required")
    if data["phase"] != "submitting" and (not isinstance(data.get("job_id"), str)
                                          or not JOB_ID.fullmatch(data["job_id"])):
        fail("Invalid PBS receipt; manual reconciliation required")
    return data


def write_state(path: Path, data: dict):
    temporary = path / ("receipt-" + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path / "job.json")
        directory_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def pbs(command: list[str], *, env=None):
    result = subprocess.run(command, capture_output=True, text=True, timeout=30, env=env)
    if result.returncode:
        fail(f"{command[0]} failed; scheduler state is unknown. Keep the receipt and reconcile manually: "
             + result.stderr.strip()[:500])
    return result.stdout


def verified_job(receipt: dict):
    if receipt["phase"] == "submitting":
        fail("Submission outcome is ambiguous. Do not resubmit or erase the receipt; reconcile the run token with PBS manually")
    job_id = receipt["job_id"]
    payload = json.loads(pbs(["qstat", "-x", "-f", "-F", "json", job_id]))
    jobs = payload.get("Jobs") if isinstance(payload, dict) else None
    if not isinstance(jobs, dict) or set(jobs) != {job_id} or not isinstance(jobs[job_id], dict):
        fail("qstat did not return exactly the tracked job; no action taken")
    job = jobs[job_id]
    owner = job.get("Job_Owner", "")
    variables = job.get("Variable_List", {})
    if isinstance(variables, dict):
        token = variables.get(TOKEN_KEY)
    elif isinstance(variables, str):
        matches = re.findall(r"(?:^|,)" + TOKEN_KEY + r"=([0-9a-f]{32})(?=,|$)", variables)
        token = matches[0] if len(matches) == 1 else None
    else:
        token = None
    if not isinstance(owner, str) or owner.split("@", 1)[0] != receipt["owner"] or "@" not in owner \
            or job.get("Job_Name") != receipt["name"] or token != receipt["token"]:
        fail("PBS owner/name/run-token mismatch; refusing to act on this job")
    if not isinstance(job.get("job_state"), str) or job["job_state"] not in STATES:
        fail("Unknown PBS job state; no action taken")
    return job


def config(args):
    runtime = Path(__file__).resolve().parent / "minicpm_runtime"
    launcher = Path(args.launcher or (runtime / "launch.pbs" if args.runtime_root else ""))
    if args.runtime_root and launcher != runtime / "launch.pbs":
        fail("MINICPM_RUNTIME_ROOT requires the bundled launcher; unset MINICPM_LAUNCHER")
    if not launcher.is_absolute() or launcher.is_symlink() or launcher.resolve() != launcher:
        fail("Provide MINICPM_LAUNCHER as an absolute, non-symlink path to an already-reviewed guarded launcher")
    info = launcher.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        fail("Launcher must be a current-user-owned regular file, not group/world writable")
    if args.runtime_root:
        root = Path(args.runtime_root)
        if not root.is_absolute() or any(c in args.runtime_root for c in ",\n\r"):
            fail("MINICPM_RUNTIME_ROOT must be absolute and contain no commas/newlines")
        result = subprocess.run([sys.executable, str(runtime / "prepare.py"), "check", "--root", str(root)],
                                capture_output=True, text=True, timeout=30)
        if result.returncode:
            fail("Prepared runtime check failed; no submission: " + result.stderr.strip()[:500])
        environment = {"MINICPM_RUNTIME_ROOT": str(root)}
    else:
        model = Path(args.model_path or "")
        if not args.model_path or not model.is_absolute() or not model.is_dir() or any(c in args.model_path for c in ",\n\r"):
            fail("Provide MINICPM_MODEL_PATH as an existing absolute checkpoint directory without commas/newlines")
        environment = {"MODEL_PATH": str(model)}
    if not args.node or not HOST.fullmatch(args.node):
        fail("Provide MINICPM_NODE as an explicit PBS compute host, not a resource expression")
    if not re.fullmatch(r"[1-9][0-9]*", args.ncpus) or not re.fullmatch(r"[1-9][0-9]*(?:kb|mb|gb|tb)", args.mem):
        fail("Invalid CPU or memory resource request")
    if not re.fullmatch(r"[0-9]{2,3}:[0-5][0-9]:[0-5][0-9]", args.walltime) or int(args.walltime.replace(":", "")) == 0:
        fail("Walltime must be positive HH:MM:SS")
    return launcher, environment


def confirm(args, message):
    if args.yes:
        return
    try:
        answer = input(message + " [y/N] ")
    except EOFError:
        answer = ""
    if answer.lower() not in {"y", "yes"}:
        fail("Aborted; no scheduler mutation requested")


def show_job(receipt, job):
    print(f"PBS {receipt['job_id']}: {STATES[job['job_state']]}; model readiness unverified.")
    if receipt["phase"] == "stop-requested" and job["job_state"] not in TERMINAL:
        print("Deletion was requested; PBS teardown/resource release is not yet confirmed.")
    if job["job_state"] != "R":
        return
    execution = job.get("exec_host", "")
    hosts = {part.split("/", 1)[0] for part in execution.split("+")} if isinstance(execution, str) else set()
    if len(hosts) == 1 and HOST.fullmatch(next(iter(hosts))):
        host = next(iter(hosts))
        print("After checking runtime logs for capacity readiness, manually run on the app gateway host:")
        print(f"  ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:18006:127.0.0.1:18006 {host}")
        print("Use the launcher's loopback port 18006; capacity readiness is not an inference test.")
    else:
        print("Allocation host is unavailable/ambiguous; no tunnel command guessed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "status", "stop"))
    parser.add_argument("--yes", action="store_true", default=os.environ.get("MINICPM_YES") == "1")
    defaults = {"launcher": "", "runtime-root": "", "model-path": "", "node": "", "ncpus": "8", "mem": "64gb",
                "walltime": "00:45:00", "state-dir": str(Path(__file__).resolve().parents[1] / ".minicpm-state")}
    for name, default in defaults.items():
        parser.add_argument("--" + name, default=os.environ.get("MINICPM_" + name.upper().replace("-", "_"), default))
    args = parser.parse_args()
    with locked_state(Path(args.state_dir)) as state_path:
        receipt = read_state(state_path)
        if args.command == "start":
            launcher, runtime_environment = config(args)
            if receipt:
                old_job = verified_job(receipt)
                if old_job["job_state"] not in TERMINAL:
                    fail("Tracked PBS job is still active; no duplicate submission")
            resources = f"select=1:ncpus={args.ncpus}:mem={args.mem}:ngpus=1:host={args.node}"
            print(f"Request: {resources}; walltime={args.walltime}. No provisioning or key renewal.")
            confirm(args, "Submit one reviewed MiniCPM PBS runtime?")
            token = uuid.uuid4().hex
            receipt = {"phase": "submitting", "token": token, "name": "fypmc-" + token[:8],
                       "owner": pwd.getpwuid(os.geteuid()).pw_name, "launcher": str(launcher),
                       "launcher_sha256": hashlib.sha256(launcher.read_bytes()).hexdigest()}
            # Persist intent BEFORE qsub: timeout/crash/malformed output must never cause an automatic duplicate.
            write_state(state_path, receipt)
            runtime_environment[TOKEN_KEY] = token
            environment = dict(os.environ, **runtime_environment)
            output = pbs(["qsub", "-N", receipt["name"], "-j", "oe", "-l", resources,
                          "-l", "walltime=" + args.walltime, "-v", ",".join(runtime_environment),
                          str(launcher)], env=environment).strip()
            if not JOB_ID.fullmatch(output):
                fail("Ambiguous qsub receipt; retain the private intent and reconcile with PBS manually")
            receipt.update(phase="submitted", job_id=output)
            write_state(state_path, receipt)
            print(f"Submitted PBS {output}; may be queued. Model readiness unverified.")
            print("Run make minicpm-status for allocation/tunnel instructions; make minicpm-stop requests own-job teardown.")
        elif receipt is None:
            print("No tracked MiniCPM PBS job. Existing unrelated/manual jobs are not managed.")
        else:
            job = verified_job(receipt)
            if args.command == "status":
                show_job(receipt, job)
            elif job["job_state"] in TERMINAL:
                print(f"PBS {receipt['job_id']} already finished; no deletion requested.")
            elif receipt["phase"] == "stop-requested":
                print("Deletion already requested; run make minicpm-status to confirm teardown.")
            else:
                confirm(args, "Request deletion of verified own PBS job " + receipt["job_id"] + "?")
                # Confirmation may wait arbitrarily long. Revalidate the exact job
                # identity immediately afterward; prior metadata is not authority.
                job = verified_job(receipt)
                if job["job_state"] in TERMINAL:
                    print(f"PBS {receipt['job_id']} finished during confirmation; no deletion requested.")
                    return 0
                # A crash around qdel must not silently repeat the mutation.
                receipt["phase"] = "stop-requested"
                write_state(state_path, receipt)
                pbs(["qdel", receipt["job_id"]])
                print("Deletion requested for PBS " + receipt["job_id"] + "; teardown/resource release unverified.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"MiniCPM lifecycle refused: {error}", file=sys.stderr)
        sys.exit(1)
