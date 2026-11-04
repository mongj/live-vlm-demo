#!/usr/bin/env python3
"""Prepare gateway credentials for the deployed JoyAI Modal Server and wait until it is warm.

Run by `make joyai-modal` after `modal deploy scripts/joyai_modal.py`, with the IDs of
containers that were running before the deploy. `--list-containers` prints those IDs.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / "web-server" / ".env"
CATALOG = ROOT / "web-server" / "config.toml"
APP = "live-vlm-joyai"
SERVER = f"{APP}/JoyAI"
TOKEN_NAME = "live-vlm-joyai"
ID_KEY = "JOYAI_MODAL_TOKEN_ID"
SECRET_KEY = "JOYAI_MODAL_TOKEN_SECRET"
WARM_TIMEOUT_SECONDS = 45 * 60


def modal_json(*args: str) -> object:
    out = subprocess.run(["modal", *args, "--json"], check=True, capture_output=True, text=True)
    return json.loads(out.stdout)


def containers() -> list[str]:
    listed = modal_json("container", "list")
    assert isinstance(listed, list)
    return [str(c["container_id"]) for c in listed if c.get("app_name") == APP]


def stop_containers(ids: list[str]) -> None:
    # Containers from the previous deploy (possibly another GPU) would otherwise
    # keep answering /health until Modal drains them.
    running = set(containers())
    for container_id in ids:
        if container_id in running:
            print(f"Stopping container {container_id} from the previous deploy")
            subprocess.run(["modal", "container", "stop", "--yes", container_id], check=True)


def read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return values
    for line in lines:
        key, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep:
            values[key.strip()] = value.strip().strip("'\"")
    return values


def ensure_token() -> tuple[str, str]:
    env = read_env()
    if env.get(ID_KEY) and env.get(SECRET_KEY):
        print(f"Reusing the Modal proxy token in {ENV_FILE}")
        return env[ID_KEY], env[SECRET_KEY]
    created = modal_json("workspace", "proxy-tokens", "create", "--name", TOKEN_NAME)
    assert isinstance(created, dict)
    token_id, token_secret = str(created["Modal-Key"]), str(created["Modal-Secret"])
    existing = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ""
    if existing and not existing.endswith("\n"):
        existing += "\n"
    ENV_FILE.write_text(f"{existing}{ID_KEY}={token_id}\n{SECRET_KEY}={token_secret}\n", encoding="utf-8")
    os.chmod(ENV_FILE, 0o600)
    print(f"Created Modal proxy token {token_id} and saved it to {ENV_FILE}")
    return token_id, token_secret


def server_url() -> str:
    info = modal_json("server", "info", SERVER)
    assert isinstance(info, dict)
    return str(info["server_url"]).rstrip("/")


def catalog_url() -> str | None:
    rows = tomllib.loads(CATALOG.read_text(encoding="utf-8")).get("models", [])
    for row in rows:
        if row.get("adapter") == "joyai-modal":
            return str(row.get("base_url", "")).rstrip("/")
    return None


def wait_warm(url: str, token_id: str, token_secret: str) -> bool:
    request = urllib.request.Request(
        f"{url}/health", headers={"Modal-Key": token_id, "Modal-Secret": token_secret}
    )
    started = time.monotonic()
    while time.monotonic() - started < WARM_TIMEOUT_SECONDS:
        elapsed = int(time.monotonic() - started)
        try:
            with urllib.request.urlopen(request, timeout=30):
                print(f"JoyAI (Modal) is ready after {elapsed}s")
                return True
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                print(f"Modal rejected the proxy token (HTTP {exc.code}); "
                      f"remove {ID_KEY}/{SECRET_KEY} from {ENV_FILE} and rerun", file=sys.stderr)
                return False
            status = f"HTTP {exc.code}"
        except OSError as exc:
            status = str(exc)
        print(f"  waiting for the container to start ({elapsed}s, {status})", flush=True)
        time.sleep(15)
    print(f"Timed out waiting for JoyAI (Modal); check `modal app logs {APP}`", file=sys.stderr)
    return False


def main(argv: list[str]) -> int:
    if argv == ["--list-containers"]:
        print(" ".join(containers()))
        return 0
    stop_containers(argv)
    token_id, token_secret = ensure_token()
    url = server_url()
    print(f"Server URL: {url}")
    if catalog_url() != f"{url}/v1":
        print(f"web-server/config.toml has a different joyai-modal base_url; set "
              f"JOYAI_MODAL_BASE_URL={url}/v1 for the gateway or update the file")
    print(f"Waking the Server on {os.environ.get('JOYAI_MODAL_GPU', 'H100').upper()} (first boot downloads weights and compiles kernels; up to ~30 min)")
    if not wait_warm(url, token_id, token_secret):
        return 1
    print("Select JoyAI (Modal) in the app. Restart the gateway if it started before the token was saved.")
    print(f"For a gateway on another host, copy the {ID_KEY} and {SECRET_KEY} lines into its web-server/.env.")
    print("The container scales to zero after 20 idle minutes; `make joyai-modal-stop` stops the app now.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
