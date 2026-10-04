#!/usr/bin/env python3
"""Offline, pinned MiniCPM source preparation. No downloads, installs or GPU work.

Supply the upstream MiniCPM-o-Demo archive at PIN, an existing dependency Python
and checkpoint, and a NEW private root outside this repository. Runtime changes
are in runtime.patch; upstream notices are preserved. Model licensing is separate.
Preparation never updates an existing root. Check before submitting launch.pbs.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile

PIN = "47709a9210dfd71afa76c058e017fc8c4db5c8d2"
ARCHIVE_SHA256 = "7a13ab0db06e8c305973402dc60b6dc281cfaeaf7a9b95d7c8bcdf9ea3f3de11"
PATCH_SHA256 = "d73daa6be7a1da0a648811cdc727b8da0a30d691874d1bebc6c37a5c3f5affd8"
SOURCE_SHA256 = "3c0e90a8f906f9179d47a2ee56e02461890f3c29e4bc23d4ee2fc7e960c44586"
HERE = Path(__file__).resolve().parent
RUNTIME_FILES = ("prepare.py", "safety.py", "supervisor.py", "gateway_private.py", "run.py", "launch.pbs", "runtime.patch")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def canonical(path, *, directory=False, owned=True, private=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("Paths must be absolute and must not traverse symlinks")
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    owners = {os.geteuid()} if owned else {0, os.geteuid()}
    if not kind(info.st_mode) or info.st_uid not in owners or info.st_mode & (0o077 if private else 0o022):
        raise ValueError("Expected a safely permissioned, owned regular file/directory")
    return path


def regular_bytes(path, *, owned=True):
    path = canonical(path, owned=owned)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in ({os.geteuid()} if owned else {0, os.geteuid()}):
            raise ValueError("File ownership changed while opening")
        return handle.read()


def validate_python(value):
    # Venv Python commonly is a symlink. Only this explicit executable may resolve
    # one; both the link's parent and actual executable must be owned/root-owned.
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("Python must be an explicit absolute executable")
    canonical(path.parent, directory=True, owned=False)
    canonical(path.resolve(), owned=False)
    if not os.access(path, os.X_OK):
        raise ValueError("Configured Python is not executable")
    return str(path)


def validate_model(value):
    model = canonical(value, directory=True, owned=False)
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json"):
        regular_bytes(model / name, owned=False)
    index = model / "model.safetensors.index.json"
    if index.exists():
        payload = json.loads(regular_bytes(index, owned=False))
        mapping = payload.get("weight_map") if isinstance(payload, dict) else None
        if not isinstance(mapping, dict) or not mapping:
            raise ValueError("Checkpoint index must contain weight shards")
        names = set(mapping.values())
    else:
        names = {"model.safetensors"}
    for name in names:
        if not isinstance(name, str) or not name or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
            raise ValueError("Checkpoint shard must not escape its explicit directory")
        shard = canonical(model / name, owned=False)
        if not shard.is_relative_to(model) or shard.stat().st_size == 0:
            raise ValueError("Checkpoint shard is missing or empty")
    assets = canonical(model / "assets/token2wav", directory=True, owned=False)
    found = False
    for path in assets.rglob("*"):
        if path.is_symlink():
            raise ValueError("Token2wav assets must not contain symlinks")
        if path.is_file() and path.suffix in {".pt", ".onnx", ".safetensors"}:
            canonical(path, owned=False)
            found |= path.stat().st_size > 0
    if not found:
        raise ValueError("Missing token2wav checkpoint assets")
    return str(model)


def privacy_config(root):
    return {"model": {"model_path": "", "attn_implementation": "sdpa"},
            "audio": {"chat_vocoder": "token2wav"},
            "service": {"gateway_port": 18006, "worker_base_port": 22400,
                        "max_queue_size": 1, "request_timeout": 300.0, "compile": False,
                        "data_dir": str(root / "state/no-recording")},
            "recording": {"enabled": False, "session_retention_days": -1, "max_storage_gb": -1}}


def patched_files(archive):
    data = regular_bytes(archive)
    if sha(data) != ARCHIVE_SHA256:
        raise ValueError("Archive differs from the exact pinned upstream source")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
        for member in source:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or path.parts[0] != "MiniCPM-o-Demo-" + PIN:
                raise ValueError("Unsafe archive member")
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError("Archive links and special files are forbidden")
            name = PurePosixPath(*path.parts[1:]).as_posix()
            if name.startswith("certs/") or name == "config.json":
                continue
            if name in files or member.size > 30_000_000:
                raise ValueError("Duplicate or oversized archive member")
            files[name] = source.extractfile(member).read()
    patch = regular_bytes(HERE / "runtime.patch")
    if sha(patch) != PATCH_SHA256:
        raise ValueError("Runtime patch differs from the reviewed patchset")
    # This deliberately accepts only exact unified hunks; no fuzz, subprocess,
    # external patch dependency, arbitrary paths or baseline mutation.
    lines = patch.decode().splitlines(keepends=True)
    cursor = 0
    while cursor < len(lines):
        if not lines[cursor].startswith("--- a/"):
            raise ValueError("Malformed patch file header")
        name = lines[cursor][6:].rstrip("\n")
        if name not in files or lines[cursor + 1] != "+++ b/" + name + "\n":
            raise ValueError("Unexpected patch target")
        old = files[name].decode().splitlines(keepends=True)
        output, position = [], 0
        cursor += 2
        while cursor < len(lines) and lines[cursor].startswith("@@ "):
            match = re.fullmatch(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*\n", lines[cursor])
            if not match:
                raise ValueError("Malformed patch hunk")
            start = int(match[1]) - 1
            if start < position:
                raise ValueError("Overlapping patch hunks")
            output.extend(old[position:start])
            position, removed, added = start, 0, 0
            cursor += 1
            while cursor < len(lines) and lines[cursor][:1] in {" ", "+", "-"} and not lines[cursor].startswith("--- a/"):
                line = lines[cursor]
                if line[0] != "+":
                    if position >= len(old) or old[position] != line[1:]:
                        raise ValueError("Patch context does not exactly match")
                    position += 1
                    removed += 1
                if line[0] != "-":
                    output.append(line[1:])
                    added += 1
                cursor += 1
            if removed != int(match[2] or 1) or added != int(match[4] or 1):
                raise ValueError("Patch hunk lengths differ")
        output.extend(old[position:])
        files[name] = "".join(output).encode()
    if sha(encoded({name: sha(data) for name, data in files.items()})) != SOURCE_SHA256:
        raise ValueError("Patched complete source tree differs from reviewed output")
    return files


def private_directory(path):
    if not path.exists():
        private_directory(path.parent)
        path.mkdir(mode=0o700)


def write_new(path, data):
    private_directory(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)


def prepare(*, archive, root, model, python):
    root = Path(root)
    if not root.is_absolute() or root.resolve() != root or root.exists() or root.is_symlink():
        raise ValueError("Runtime root must be a new absolute nonsymlink directory")
    canonical(root.parent, directory=True)
    if root.is_relative_to(HERE.parent.parent):
        raise ValueError("Prepared runtime must stay outside the application repository")
    model, python = validate_model(model), validate_python(python)
    files = patched_files(archive)
    runtime = {name: regular_bytes(HERE / name) for name in RUNTIME_FILES}
    # All external inputs are validated before the first output write. A failed
    # write leaves a visibly incomplete new directory; never erase user files.
    root.mkdir(mode=0o700)
    for directory in ("state/no-recording", "logs", "tmp", "cache/huggingface", "cache/torch", "runtime"):
        private_directory(root / directory)
    for name, data in files.items():
        write_new(root / "source" / name, data)
    write_new(root / "source/config.json", encoded(privacy_config(root)))
    for name, data in runtime.items():
        write_new(root / "runtime" / name, data)
    config = {"version": 1, "pin": PIN, "root": str(root), "source": str(root / "source"),
              "owner_uid": os.geteuid(), "model": model, "python": python,
              "runtime_hashes": {name: sha(data) for name, data in runtime.items()}}
    write_new(root / "runtime.json", encoded(config))
    return check(root)


def check(root):
    root = canonical(root, directory=True, private=True)
    canonical(root / "runtime.json", private=True)
    config = json.loads(regular_bytes(root / "runtime.json"))
    if not isinstance(config, dict) or config.get("version") != 1 or config.get("pin") != PIN or config.get("owner_uid") != os.geteuid() \
            or config.get("root") != str(root) or config.get("source") != str(root / "source"):
        raise ValueError("Prepared runtime identity does not match its private root")
    validate_model(config["model"])
    validate_python(config["python"])
    hashes = {}
    canonical(root / "source", directory=True, private=True)
    for path in (root / "source").rglob("*"):
        if path.is_symlink():
            raise ValueError("Prepared source must not contain symlinks")
        if path.is_dir():
            canonical(path, directory=True, private=True)
            continue
        relative = path.relative_to(root / "source")
        if "__pycache__" in relative.parts or path.suffix == ".pyc":
            continue
        data = regular_bytes(path)
        if relative.as_posix() != "config.json":
            hashes[relative.as_posix()] = sha(data)
    if sha(encoded(hashes)) != SOURCE_SHA256:
        raise ValueError("Prepared source content differs from reviewed runtime")
    if json.loads(regular_bytes(root / "source/config.json")) != privacy_config(root):
        raise ValueError("Private runtime configuration changed")
    expected = config.get("runtime_hashes")
    actual = {name: sha(regular_bytes(root / "runtime" / name)) for name in RUNTIME_FILES}
    if expected != actual or sha(regular_bytes(root / "runtime/runtime.patch")) != PATCH_SHA256:
        raise ValueError("Prepared runtime support code changed")
    if HERE != root / "runtime" and actual != {name: sha(regular_bytes(HERE / name)) for name in RUNTIME_FILES}:
        raise ValueError("Prepared runtime uses a different package version; prepare a new root")
    for name in ("runtime", "state", "state/no-recording", "logs", "tmp", "cache"):
        canonical(root / name, directory=True, private=True)
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    creation = commands.add_parser("prepare")
    for name in ("archive", "root", "model", "python"):
        creation.add_argument("--" + name, required=True)
    commands.add_parser("check").add_argument("--root", required=True)
    args = vars(parser.parse_args())
    command = args.pop("command")
    result = prepare(**args) if command == "prepare" else check(args["root"])
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, tarfile.TarError) as error:
        print(f"MiniCPM runtime preparation refused: {error}", file=sys.stderr)
        sys.exit(2)
