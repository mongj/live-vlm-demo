from __future__ import annotations

import os
from collections.abc import Mapping, MutableMapping
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket

from .catalog import CatalogError, load_catalog
from .session import run_session
from .thumbnails import (
    ThumbnailCache,
    resolve_thumbnail_cache_dir,
    resolve_thumbnail_concurrency,
)
from .videos import mount_video_routes, resolve_video_roots

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_CONFIG = "./config.toml"


def load_dotenv_file(
    path: Path,
    environ: MutableMapping[str, str] | None = None,
) -> None:
    env = os.environ if environ is None else environ
    try:
        text = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key and key not in env:
            env[key] = value


def resolve_runtime_settings(
    environ: Mapping[str, str] | None = None,
) -> tuple[str, int, Path]:
    env = os.environ if environ is None else environ
    config_path = Path(env.get("LIVE_VLM_CONFIG", DEFAULT_CONFIG))
    host = env.get("LIVE_VLM_HOST", DEFAULT_HOST)
    port_raw = env.get("LIVE_VLM_PORT", str(DEFAULT_PORT))
    try:
        port = int(port_raw)
    except ValueError as exc:
        raise ValueError(
            f"LIVE_VLM_PORT must be an integer from 1 through 65535, got {port_raw!r}"
        ) from exc
    if not 1 <= port <= 65535:
        raise ValueError(
            f"LIVE_VLM_PORT must be an integer from 1 through 65535, got {port_raw!r}"
        )
    return host, port, config_path


def create_app(
    config_path: str | Path,
    video_roots: Mapping[str, Path] | None = None,
    thumbnail_cache: Path | None = None,
) -> FastAPI:
    catalog = load_catalog(Path(config_path))
    roots = resolve_video_roots(overrides=video_roots)
    thumbnails = ThumbnailCache(
        thumbnail_cache or resolve_thumbnail_cache_dir(),
        concurrency=resolve_thumbnail_concurrency(),
    )
    app = FastAPI(title="Live VLM Gateway")

    @app.get("/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/v1/models")
    def list_models() -> dict[str, list[dict[str, Any]]]:
        return {"models": [catalog.entry(spec) for spec in catalog.specs]}

    @app.get("/v1/models/{model_id}")
    def get_model(model_id: str) -> dict[str, Any]:
        spec = catalog.get(model_id)
        if spec is None:
            raise HTTPException(status_code=404, detail="Model not found")
        return catalog.entry(spec)

    mount_video_routes(app, roots, thumbnails)

    @app.websocket("/v1/realtime")
    async def realtime(websocket: WebSocket) -> None:
        await run_session(websocket, catalog)

    return app


__all__ = ["CatalogError", "create_app", "load_dotenv_file", "resolve_runtime_settings"]
