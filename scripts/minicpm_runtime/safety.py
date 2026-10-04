"""Fail-closed local preparation checks; imports only the Python standard library."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pwd
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import time
from urllib.parse import parse_qs
from urllib.request import urlopen
import xml.etree.ElementTree as ET

def validate_job(env, hostname, *, gpu):
    job = env.get("PBS_JOBID", "")
    if not re.fullmatch(r"[1-9][0-9]*\.[A-Za-z0-9][A-Za-z0-9.-]*", job):
        raise ValueError("A valid PBS_JOBID is required; never run on the submission host")
    if env.get("PBS_O_LOGNAME") != pwd.getpwuid(os.geteuid()).pw_name:
        raise ValueError("PBS submitting owner must equal the current account")
    if env.get("PBS_O_HOST", "").split(".")[0] == hostname.split(".")[0]:
        raise ValueError("Refusing GPU work on the PBS submission host")


def parse_gpu_file(content, hostname):
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError("PBS_GPUFILE must identify exactly one allocated GPU")
    host = hostname.split(".")[0]
    match = re.fullmatch(re.escape(host) + r"-gpu/?([0-9]+)", lines[0])
    if not match:
        raise ValueError("Unrecognized PBS_GPUFILE format; inspect scheduler evidence, never guess GPU0")
    return match.group(1)


def parse_pbs_devices_path(content, job_id):
    """Accept only exact PBS cgroup-v1 job membership; other layouts fail closed."""
    if not re.fullmatch(r"[1-9][0-9]*\.[A-Za-z0-9][A-Za-z0-9.-]*", job_id):
        raise ValueError("Unrecognized PBS job ID for the verified cgroup-v1 layout")
    paths = []
    for line in content.splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3 or not parts[0].isdigit():
            raise ValueError("Malformed /proc/self/cgroup membership")
        if "devices" in parts[1].split(","):
            if parts[1] != "devices" or parts[0] == "0":
                raise ValueError("Unrecognized devices-controller convention")
            paths.append(parts[2])
    expected = f"/pbs_jobs.service/jobid/{job_id}"
    if paths != [expected]:
        raise ValueError("Exactly one cgroup-v1 devices membership for this PBS_JOBID is required")
    return Path("/sys/fs/cgroup/devices") / expected.lstrip("/") / "devices.list"


def read_cgroup_devices(path):
    if not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("Cannot safely read scheduler evidence without O_NOFOLLOW")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW)) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o222:
            raise ValueError("devices.list must be a root-owned read-only regular file")
        return handle.read()


def parse_cgroup_gpu_minor(content):
    allowed = {}
    for line in content.splitlines():
        match = re.fullmatch(r"([abc]) ([0-9]+|\*):([0-9]+|\*) ([rwm]{1,3})", line.strip())
        if not match:
            raise ValueError("Malformed devices.list rule")
        kind, major, minor, access = match.groups()
        if kind == "b" or major not in {"195", "*"} or not set(access) & {"r", "w"}:
            continue
        if kind == "a" or major == "*" or minor == "*":
            raise ValueError("Wildcard GPU read/write access is not an exclusive allocation")
        if minor in {"254", "255"}:  # NVIDIA control devices, not physical cards.
            continue
        allowed.setdefault(minor, set()).update(access)
    if len(allowed) != 1 or not {"r", "w"}.issubset(next(iter(allowed.values()), set())):
        raise ValueError("devices.list must grant read/write access to exactly one physical GPU")
    return next(iter(allowed))


def parse_gpu_xml_uuid(content, minor):
    """Resolve a physical device minor, never a GPU list position or index."""
    try:
        root = ET.fromstring(content)
    except ET.ParseError as error:
        raise ValueError("Malformed nvidia-smi XML inventory") from error
    if root.tag != "nvidia_smi_log":
        raise ValueError("Unrecognized nvidia-smi XML root")
    by_minor, uuids = {}, set()
    for gpu in root.findall("gpu"):
        minor_fields, uuid_fields = gpu.findall("minor_number"), gpu.findall("uuid")
        if len(minor_fields) != 1 or len(uuid_fields) != 1:
            raise ValueError("Each GPU must have exactly one physical minor and UUID")
        device_minor = (minor_fields[0].text or "").strip()
        uuid = (uuid_fields[0].text or "").strip()
        if not re.fullmatch(r"0|[1-9][0-9]*", device_minor) or not re.fullmatch(
                r"GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", uuid):
            raise ValueError("Invalid physical minor or GPU UUID in nvidia-smi XML")
        if device_minor in by_minor or uuid in uuids:
            raise ValueError("Duplicate physical minor or UUID in nvidia-smi XML")
        by_minor[device_minor] = uuid
        uuids.add(uuid)
    if minor not in by_minor:
        raise ValueError("Allocated cgroup GPU minor is absent from nvidia-smi XML")
    return by_minor[minor]


def allocated_gpu_uuid():
    host = socket.gethostname()
    validate_job(os.environ, host, gpu=True)
    gpu_file = os.environ.get("PBS_GPUFILE", "")
    expected_uuid = None
    if gpu_file:
        if os.environ["PBS_JOBID"] not in Path(gpu_file).name:
            raise ValueError("A PBS_GPUFILE tied to this PBS_JOBID is required; its convention is not yet verified")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(gpu_file, flags)) as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError("PBS_GPUFILE must be a root-owned regular file, not group/world writable")
            device = parse_gpu_file(handle.read(), host)
    else:
        path = parse_pbs_devices_path(Path("/proc/self/cgroup").read_text(), os.environ["PBS_JOBID"])
        minor = parse_cgroup_gpu_minor(read_cgroup_devices(path))
        inventory = subprocess.check_output(["nvidia-smi", "-q", "-x"], text=True)
        expected_uuid = parse_gpu_xml_uuid(inventory, minor)
        if os.environ.get("CUDA_VISIBLE_DEVICES") != expected_uuid:
            raise ValueError("Scheduler CUDA_VISIBLE_DEVICES must exactly match the cgroup-allocated GPU UUID")
        device = expected_uuid
    details = subprocess.check_output([
        "nvidia-smi", "-i", device, "--query-gpu=uuid,memory.total,memory.free",
        "--format=csv,noheader,nounits"], text=True).strip().splitlines()
    if len(details) != 1:
        raise ValueError("GPU index did not resolve to exactly one physical GPU")
    uuid, total, free = [value.strip() for value in details[0].split(",")]
    if expected_uuid is not None and uuid != expected_uuid:
        raise ValueError("GPU capacity query returned a different UUID than the allocation")
    if not uuid.startswith("GPU-") or int(total) < 45000 or int(free) < 44000:
        raise ValueError("Allocated GPU must be an available 48 GB-class device")
    processes = subprocess.check_output([
        "nvidia-smi", "-i", uuid, "--query-compute-apps=pid", "--format=csv,noheader,nounits"], text=True).strip()
    if processes:
        raise ValueError("Allocated GPU already has compute processes; refusing to interfere")
    return uuid


def health_ready(role, payload):
    if role == "backend":
        return payload.get("status") == "ready" and payload.get("worker_status") == "ready"
    if role == "worker":
        return payload.get("status") == "healthy" and payload.get("model_loaded") is True
    if role == "gateway":
        return payload.get("gateway_healthy") is True and payload.get("idle_workers", 0) >= 1
    if role == "registry":
        return payload.get("status") == "healthy"
    raise ValueError(f"Unknown health role: {role}")


def wait_health(role, url, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=2) as response:
                if health_ready(role, json.load(response)):
                    return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise ValueError(f"{role} health did not become ready within {seconds}s")


def check_ports():
    sockets = []
    try:
        for port in (18006, 18007, 22400, 22500):
            sock = socket.socket()
            sockets.append(sock)
            sock.bind(("127.0.0.1", port))
    finally:
        for sock in sockets:
            sock.close()


def has_custom_voice(value):
    if isinstance(value, dict):
        return any("ref_audio" in key or key == "prompt_wav_path" or has_custom_voice(item)
                   for key, item in value.items())
    return isinstance(value, list) and any(has_custom_voice(item) for item in value)


class PrivacyGate:
    """Allow only health and the integration's video WS; no upstream UI/uploads/debug."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        kind, path = scope["type"], scope.get("path", "")
        if kind == "lifespan":
            return await self.app(scope, receive, send)
        if kind == "http" and path in {"/health", "/status"} and scope.get("method") == "GET":
            return await self.app(scope, receive, send)
        if kind == "websocket":
            query = parse_qs(scope.get("query_string", b"").decode("ascii", errors="replace"))
            if path == "/v1/realtime" and query.get("mode", ["video"]) == ["video"]:
                async def guarded_receive():
                    message = await receive()
                    if message.get("type") == "websocket.receive":
                        try:
                            payload = json.loads(message.get("text") or message.get("bytes") or "null")
                            if has_custom_voice(payload):
                                await send({"type": "websocket.close", "code": 1008, "reason": "Custom voice uploads are disabled"})
                                return {"type": "websocket.disconnect", "code": 1008}
                        except (ValueError, UnicodeError):
                            pass  # Upstream validates ordinary protocol errors.
                    return message
                return await self.app(scope, guarded_receive, send)
            await send({"type": "websocket.close", "code": 1008, "reason": "Only video integration is enabled"})
        else:
            await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "http.response.body", "body": b"Endpoint disabled by local privacy policy"})
