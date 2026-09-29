from __future__ import annotations

import os
import shutil
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from live_vlm_server import thumbnails as thumbnails_module
from live_vlm_server.main import create_app
from live_vlm_server.thumbnails import (
    ThumbnailAbandoned,
    ThumbnailCache,
    resolve_thumbnail_cache_dir,
    resolve_thumbnail_concurrency,
)

SHIPPED = Path(__file__).resolve().parents[1] / "config.toml"
JPEG_MAGIC = b"\xff\xd8\xff"
REAL_RUN = subprocess.run

requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg and ffprobe are required",
)


def _make_clip(path: Path, seconds: int = 2, size: str = "640x360") -> None:
    REAL_RUN(
        [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={size}:rate=10",
            "-t",
            str(seconds),
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
    )


class RunCounter:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        self.calls += 1
        return REAL_RUN(*args, **kwargs)


@pytest.fixture
def runs(monkeypatch: pytest.MonkeyPatch) -> RunCounter:
    counter = RunCounter()
    monkeypatch.setattr(thumbnails_module.subprocess, "run", counter)
    return counter


@pytest.fixture
def library(tmp_path: Path) -> Path:
    root = tmp_path / "spot-bench"
    root.mkdir()
    (root / "broken.mp4").write_bytes(b"not a video")
    (root / "notes.json").write_text("{}", encoding="utf-8")
    return root


@pytest.fixture
def client(tmp_path: Path, library: Path) -> Iterator[TestClient]:
    app = create_app(
        SHIPPED,
        video_roots={"spot-bench": library, "ego-proactive": tmp_path / "missing"},
        thumbnail_cache=tmp_path / "cache",
    )
    with TestClient(app) as test_client:
        yield test_client


def _thumbnail(client: TestClient, name: str, **headers: str) -> Any:
    return client.get(
        f"/v1/videos/{name}/thumbnail",
        params={"key": "spot-bench"},
        headers=headers,
    )


def test_validation(client: TestClient) -> None:
    assert client.get("/v1/videos/clip.mp4/thumbnail").status_code == 400
    invalid = client.get("/v1/videos/clip.mp4/thumbnail", params={"key": "nope"})
    assert invalid.status_code == 400
    missing_root = client.get(
        "/v1/videos/clip.mp4/thumbnail", params={"key": "ego-proactive"}
    )
    assert missing_root.status_code == 404
    assert _thumbnail(client, "missing.mp4").status_code == 404
    assert _thumbnail(client, "notes.json").status_code == 404
    assert _thumbnail(client, "..%2Fsecret.mp4").status_code == 404


@requires_ffmpeg
def test_thumbnail_is_scaled_jpeg_and_cached(
    client: TestClient, library: Path, tmp_path: Path, runs: RunCounter
) -> None:
    _make_clip(library / "clip one.mp4", seconds=2, size="1280x720")

    first = _thumbnail(client, "clip%20one.mp4")
    assert first.status_code == 200
    assert first.headers["content-type"] == "image/jpeg"
    assert first.content.startswith(JPEG_MAGIC)
    assert first.headers["cache-control"] == "public, max-age=86400"
    assert first.headers["x-video-duration-ms"] == "2000"
    etag = first.headers["etag"]
    generated = runs.calls
    assert generated > 0

    probe = REAL_RUN(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0",
            "-",
        ],
        input=first.content,
        capture_output=True,
        check=True,
    )
    assert probe.stdout.decode().strip() == "320,180"

    second = _thumbnail(client, "clip%20one.mp4")
    assert second.status_code == 200
    assert second.content == first.content
    assert second.headers["etag"] == etag
    assert runs.calls == generated

    not_modified = _thumbnail(client, "clip%20one.mp4", **{"If-None-Match": etag})
    assert not_modified.status_code == 304
    assert runs.calls == generated
    assert sorted(path.suffix for path in (tmp_path / "cache").iterdir()) == [".jpg", ".json"]


@requires_ffmpeg
def test_listing_reports_cached_duration_only(
    client: TestClient, library: Path, runs: RunCounter
) -> None:
    _make_clip(library / "clip.mp4", seconds=3)

    def durations() -> dict[str, int | None]:
        body = client.get("/v1/videos", params={"key": "spot-bench"}).json()
        return {video["name"]: video["duration_ms"] for video in body["videos"]}

    assert durations() == {"broken.mp4": None, "clip.mp4": None}
    assert runs.calls == 0
    assert _thumbnail(client, "clip.mp4").status_code == 200
    assert durations() == {"broken.mp4": None, "clip.mp4": 3000}


@requires_ffmpeg
def test_replacing_video_regenerates(
    client: TestClient, library: Path, runs: RunCounter
) -> None:
    clip = library / "clip.mp4"
    _make_clip(clip, seconds=2)
    first = _thumbnail(client, "clip.mp4")
    calls = runs.calls

    _make_clip(clip, seconds=4)
    stat = clip.stat()
    os.utime(clip, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    second = _thumbnail(client, "clip.mp4")
    assert second.status_code == 200
    assert second.headers["etag"] != first.headers["etag"]
    assert second.headers["x-video-duration-ms"] == "4000"
    assert runs.calls > calls


@requires_ffmpeg
def test_undecodable_video_is_422_and_cached(client: TestClient, runs: RunCounter) -> None:
    first = _thumbnail(client, "broken.mp4")
    assert first.status_code == 422
    assert first.json()["detail"] == "Video could not be decoded"
    calls = runs.calls
    assert calls > 0
    assert _thumbnail(client, "broken.mp4").status_code == 422
    assert runs.calls == calls


def test_missing_ffmpeg_is_503(
    tmp_path: Path, library: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(thumbnails_module.shutil, "which", lambda _name: None)
    app = create_app(
        SHIPPED,
        video_roots={"spot-bench": library},
        thumbnail_cache=tmp_path / "cache",
    )
    with TestClient(app) as client:
        response = _thumbnail(client, "broken.mp4")
    assert response.status_code == 503
    assert "ffmpeg" in response.json()["detail"]
    assert not (tmp_path / "cache").exists()


@requires_ffmpeg
def test_generation_is_bounded_and_deduplicated(
    tmp_path: Path, library: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(4):
        _make_clip(library / f"clip{index}.mp4", seconds=1)
    active = 0
    peak = 0
    guard = threading.Lock()
    original = ThumbnailCache._generate

    def tracked(self: ThumbnailCache, cache_id: str, path: Path) -> Any:
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        try:
            return original(self, cache_id, path)
        finally:
            with guard:
                active -= 1

    monkeypatch.setattr(ThumbnailCache, "_generate", tracked)
    cache = ThumbnailCache(tmp_path / "cache", concurrency=2)
    paths = [library / f"clip{index % 4}.mp4" for index in range(12)]
    results: list[Any] = []
    threads = [
        threading.Thread(target=lambda p=path: results.append(cache.get("spot-bench", p)))
        for path in paths
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == 12
    assert all(result.thumbnail is not None for result in results)
    assert peak <= 2
    assert len(list((tmp_path / "cache").glob("*.jpg"))) == 4


def test_abandoned_request_skips_generation(
    tmp_path: Path, library: Path, runs: RunCounter
) -> None:
    cache = ThumbnailCache(tmp_path / "cache")
    with pytest.raises(ThumbnailAbandoned):
        cache.get("spot-bench", library / "broken.mp4", abandoned=lambda: True)
    assert runs.calls == 0
    assert not (tmp_path / "cache").exists()


async def test_disconnected_client_gets_499_without_ffmpeg(
    tmp_path: Path, library: Path, runs: RunCounter
) -> None:
    app = create_app(
        SHIPPED,
        video_roots={"spot-bench": library},
        thumbnail_cache=tmp_path / "cache",
    )
    incoming: list[dict[str, Any]] = [
        {"type": "http.request", "body": b"", "more_body": False},
        {"type": "http.disconnect"},
    ]
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return incoming.pop(0) if incoming else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/v1/videos/broken.mp4/thumbnail",
        "raw_path": b"/v1/videos/broken.mp4/thumbnail",
        "query_string": b"key=spot-bench",
        "headers": [],
        "client": ("127.0.0.1", 1),
        "server": ("127.0.0.1", 8787),
    }
    await app(scope, receive, send)

    assert sent[0]["type"] == "http.response.start"
    assert sent[0]["status"] == 499
    assert runs.calls == 0
    assert not (tmp_path / "cache").exists()


def test_config_resolution() -> None:
    assert resolve_thumbnail_cache_dir({"LIVE_VLM_THUMBNAIL_CACHE": "/data/thumbs"}) == Path(
        "/data/thumbs"
    )
    assert resolve_thumbnail_cache_dir({"XDG_CACHE_HOME": "/xdg"}) == Path(
        "/xdg/live-vlm/thumbnails"
    )
    assert resolve_thumbnail_concurrency({}) == 4
    assert resolve_thumbnail_concurrency({"LIVE_VLM_THUMBNAIL_CONCURRENCY": "8"}) == 8
    with pytest.raises(ValueError):
        resolve_thumbnail_concurrency({"LIVE_VLM_THUMBNAIL_CONCURRENCY": "0"})
    with pytest.raises(ValueError):
        resolve_thumbnail_concurrency({"LIVE_VLM_THUMBNAIL_CONCURRENCY": "many"})
