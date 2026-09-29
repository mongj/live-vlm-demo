from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from stat import S_ISREG
from typing import Any

from anyio import from_thread
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response

from .thumbnails import (
    ThumbnailAbandoned,
    ThumbnailCache,
    ThumbnailError,
    ThumbnailToolMissing,
    VideoMetadata,
)

THUMBNAIL_CACHE_CONTROL = "public, max-age=86400"
# nginx's "client closed request"; only ever seen in logs, since the client is gone.
CLIENT_CLOSED_REQUEST = 499


async def client_disconnected(request: Request) -> bool:
    # The first message of a GET is its empty body, so a disconnect can be the second one.
    for _ in range(2):
        if await request.is_disconnected():
            return True
    return False


VIDEO_LIBRARY_KEYS = frozenset({"spot-bench", "ego-proactive"})

DEFAULT_VIDEO_ROOTS: dict[str, Path] = {
    "spot-bench": Path("/mnt/rdata7/mingjun/data/spot-bench"),
    "ego-proactive": Path("/mnt/rdata7/mingjun/data/ego-proactive"),
}

VIDEO_ROOT_ENV_VARS: dict[str, str] = {
    "spot-bench": "LIVE_VLM_VIDEOS_SPOT_BENCH",
    "ego-proactive": "LIVE_VLM_VIDEOS_EGO_PROACTIVE",
}


def resolve_video_roots(
    overrides: Mapping[str, Path] | None = None,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Path]:
    env = os.environ if environ is None else environ
    roots: dict[str, Path] = {}
    for key, default in DEFAULT_VIDEO_ROOTS.items():
        if overrides is not None and key in overrides:
            roots[key] = Path(overrides[key])
            continue
        env_name = VIDEO_ROOT_ENV_VARS[key]
        raw = env.get(env_name)
        roots[key] = Path(raw) if raw else default
    return roots


def require_library_key(key: str | None) -> str:
    if key is None or key == "":
        raise HTTPException(status_code=400, detail="Missing library key")
    if key not in VIDEO_LIBRARY_KEYS:
        raise HTTPException(status_code=400, detail=f"Invalid library key: {key!r}")
    return key


def require_library_root(roots: Mapping[str, Path], key: str) -> Path:
    root = Path(roots[key])
    if not root.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"Video library path is not available for key {key!r}",
        )
    return root


def is_safe_video_name(name: str) -> bool:
    if not name or name in {".", ".."}:
        return False
    if "/" in name or "\\" in name:
        return False
    return name.lower().endswith(".mp4")


def list_library_videos(
    root: Path, key: str, thumbnails: ThumbnailCache
) -> list[dict[str, Any]]:
    """`duration_ms` comes from the thumbnail cache only, so listing never decodes video."""
    videos: list[dict[str, Any]] = []
    for path in sorted(root.iterdir(), key=lambda item: item.name):
        if path.suffix.lower() != ".mp4":
            continue
        stat = path.stat()
        if not S_ISREG(stat.st_mode):
            continue
        cached = thumbnails.cached(key, path, stat)
        videos.append(
            {
                "name": path.name,
                "size": stat.st_size,
                "key": key,
                "duration_ms": cached.duration_ms if cached else None,
            }
        )
    return videos


def resolve_video_file(root: Path, name: str) -> Path:
    if not is_safe_video_name(name):
        raise HTTPException(status_code=404, detail="Video not found")
    root_resolved = root.resolve()
    candidate = (root / name).resolve()
    if not candidate.is_relative_to(root_resolved):
        raise HTTPException(status_code=404, detail="Video not found")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Video not found")
    return candidate


def mount_video_routes(
    app: FastAPI, roots: Mapping[str, Path], thumbnails: ThumbnailCache
) -> None:
    @app.get("/v1/videos")
    def list_videos(
        key: str | None = Query(default=None),
    ) -> dict[str, list[dict[str, Any]]]:
        library_key = require_library_key(key)
        root = require_library_root(roots, library_key)
        return {"videos": list_library_videos(root, library_key, thumbnails)}

    @app.get("/v1/videos/{name}/thumbnail")
    async def get_video_thumbnail(
        name: str,
        request: Request,
        key: str | None = Query(default=None),
    ) -> Response:
        library_key = require_library_key(key)

        def load() -> VideoMetadata:
            root = require_library_root(roots, library_key)
            path = resolve_video_file(root, name)
            return thumbnails.get(
                library_key,
                path,
                abandoned=lambda: from_thread.run(client_disconnected, request),
            )

        try:
            metadata = await run_in_threadpool(load)
        except ThumbnailAbandoned:
            return Response(status_code=CLIENT_CLOSED_REQUEST)
        except ThumbnailToolMissing as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ThumbnailError as exc:
            raise HTTPException(status_code=504, detail=str(exc)) from exc
        if metadata.thumbnail is None:
            raise HTTPException(status_code=422, detail="Video could not be decoded")
        headers = {
            "ETag": f'"{metadata.cache_id}"',
            "Cache-Control": THUMBNAIL_CACHE_CONTROL,
        }
        if metadata.duration_ms is not None:
            headers["X-Video-Duration-Ms"] = str(metadata.duration_ms)
        if request.headers.get("if-none-match") == headers["ETag"]:
            return Response(status_code=304, headers=headers)
        return FileResponse(
            metadata.thumbnail, media_type="image/jpeg", headers=headers
        )

    @app.get("/v1/videos/{name}")
    def get_video(
        name: str,
        key: str | None = Query(default=None),
    ) -> FileResponse:
        library_key = require_library_key(key)
        root = require_library_root(roots, library_key)
        path = resolve_video_file(root, name)
        return FileResponse(
            path,
            media_type="video/mp4",
            filename=path.name,
        )


__all__ = [
    "DEFAULT_VIDEO_ROOTS",
    "VIDEO_LIBRARY_KEYS",
    "VIDEO_ROOT_ENV_VARS",
    "is_safe_video_name",
    "list_library_videos",
    "mount_video_routes",
    "require_library_key",
    "require_library_root",
    "resolve_video_file",
    "resolve_video_roots",
]
