from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket

from .catalog import CatalogError, load_catalog
from .session import run_session

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_CONFIG = "./config.toml"


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


def create_app(config_path: str | Path) -> FastAPI:
    catalog = load_catalog(Path(config_path))
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

    @app.websocket("/v1/realtime")
    async def realtime(websocket: WebSocket) -> None:
        await run_session(websocket, catalog)

    return app


__all__ = ["CatalogError", "create_app", "resolve_runtime_settings"]
