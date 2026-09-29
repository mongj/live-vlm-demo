from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

THUMBNAIL_WIDTH = 320
THUMBNAIL_POSITION = 0.1
THUMBNAIL_JPEG_QUALITY = 4
DEFAULT_THUMBNAIL_CONCURRENCY = 4
SUBPROCESS_TIMEOUT_SECONDS = 120

THUMBNAIL_CACHE_ENV_VAR = "LIVE_VLM_THUMBNAIL_CACHE"
THUMBNAIL_CONCURRENCY_ENV_VAR = "LIVE_VLM_THUMBNAIL_CONCURRENCY"


class ThumbnailError(Exception):
    """Generation failed for a reason that may not recur, so nothing is cached."""


class ThumbnailToolMissing(ThumbnailError):
    pass


class ThumbnailAbandoned(Exception):
    """The requester went away before its turn to generate came up."""


@dataclass(frozen=True)
class VideoMetadata:
    cache_id: str
    duration_ms: int | None
    # None when the video could not be decoded.
    thumbnail: Path | None


def resolve_thumbnail_cache_dir(environ: Mapping[str, str] | None = None) -> Path:
    env = os.environ if environ is None else environ
    raw = env.get(THUMBNAIL_CACHE_ENV_VAR)
    if raw:
        return Path(raw).expanduser()
    base = env.get("XDG_CACHE_HOME")
    root = Path(base) if base else Path.home() / ".cache"
    return root / "live-vlm" / "thumbnails"


def resolve_thumbnail_concurrency(environ: Mapping[str, str] | None = None) -> int:
    env = os.environ if environ is None else environ
    raw = env.get(THUMBNAIL_CONCURRENCY_ENV_VAR)
    if not raw:
        return DEFAULT_THUMBNAIL_CONCURRENCY
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(
            f"{THUMBNAIL_CONCURRENCY_ENV_VAR} must be a positive integer, got {raw!r}"
        ) from exc
    if value < 1:
        raise ValueError(
            f"{THUMBNAIL_CONCURRENCY_ENV_VAR} must be a positive integer, got {raw!r}"
        )
    return value


def _write_atomic(path: Path, data: bytes) -> None:
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


class ThumbnailCache:
    """Generates one JPEG frame per video with ffmpeg and keeps it on disk.

    Entries are keyed by library key, file name, size and mtime, so replacing a
    video invalidates its thumbnail. Undecodable videos are cached as such too.
    """

    def __init__(
        self,
        directory: Path,
        concurrency: int = DEFAULT_THUMBNAIL_CONCURRENCY,
        ffmpeg: str | None = None,
        ffprobe: str | None = None,
    ) -> None:
        self.directory = directory
        self._slots = threading.BoundedSemaphore(concurrency)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._ffmpeg = ffmpeg or shutil.which("ffmpeg")
        self._ffprobe = ffprobe or shutil.which("ffprobe")

    @staticmethod
    def cache_id(key: str, name: str, stat: os.stat_result) -> str:
        raw = f"{key}\0{name}\0{stat.st_size}\0{stat.st_mtime_ns}"
        return hashlib.sha256(raw.encode()).hexdigest()[:32]

    def cached(self, key: str, path: Path, stat: os.stat_result) -> VideoMetadata | None:
        return self._read(self.cache_id(key, path.name, stat))

    def get(
        self,
        key: str,
        path: Path,
        abandoned: Callable[[], bool] = lambda: False,
    ) -> VideoMetadata:
        """`abandoned` is checked once a generation slot is free, so queued work for gone clients is skipped."""
        cache_id = self.cache_id(key, path.name, path.stat())
        found = self._read(cache_id)
        if found is not None:
            return found
        with self._lock_for(cache_id):
            found = self._read(cache_id)
            if found is not None:
                return found
            with self._slots:
                if abandoned():
                    raise ThumbnailAbandoned(path.name)
                return self._generate(cache_id, path)

    def _lock_for(self, cache_id: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(cache_id, threading.Lock())

    def _paths(self, cache_id: str) -> tuple[Path, Path]:
        return self.directory / f"{cache_id}.json", self.directory / f"{cache_id}.jpg"

    def _read(self, cache_id: str) -> VideoMetadata | None:
        meta_path, image_path = self._paths(cache_id)
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(meta, dict):
            return None
        duration = meta.get("duration_ms")
        decoded = meta.get("thumbnail") is True
        if decoded and not image_path.is_file():
            return None
        return VideoMetadata(
            cache_id=cache_id,
            duration_ms=duration if isinstance(duration, int) else None,
            thumbnail=image_path if decoded else None,
        )

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[bytes]:
        try:
            return subprocess.run(
                args,
                capture_output=True,
                check=False,
                timeout=SUBPROCESS_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise ThumbnailError("Timed out reading the video") from exc

    def _probe_duration_ms(self, ffprobe: str, path: Path) -> int | None:
        result = self._run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ]
        )
        if result.returncode != 0:
            return None
        try:
            seconds = float(result.stdout.decode().strip())
        except ValueError:
            return None
        return round(seconds * 1000) if seconds > 0 else None

    def _extract_frame(self, ffmpeg: str, path: Path, seconds: float) -> bytes | None:
        result = self._run(
            [
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                "-ss",
                f"{seconds:.3f}",
                "-i",
                str(path),
                "-frames:v",
                "1",
                "-an",
                "-vf",
                f"scale='min({THUMBNAIL_WIDTH},iw)':-2",
                "-q:v",
                str(THUMBNAIL_JPEG_QUALITY),
                "-f",
                "image2pipe",
                "-c:v",
                "mjpeg",
                "pipe:1",
            ]
        )
        if result.returncode != 0 or not result.stdout:
            return None
        return result.stdout

    def _generate(self, cache_id: str, path: Path) -> VideoMetadata:
        if self._ffmpeg is None or self._ffprobe is None:
            raise ThumbnailToolMissing("ffmpeg and ffprobe must be on PATH to generate thumbnails")
        duration_ms = self._probe_duration_ms(self._ffprobe, path)
        seek = duration_ms * THUMBNAIL_POSITION / 1000 if duration_ms else 0.0
        frame = self._extract_frame(self._ffmpeg, path, seek)
        if frame is None and seek > 0:
            frame = self._extract_frame(self._ffmpeg, path, 0.0)
        meta_path, image_path = self._paths(cache_id)
        self.directory.mkdir(parents=True, exist_ok=True)
        if frame is not None:
            _write_atomic(image_path, frame)
        meta = {"duration_ms": duration_ms, "thumbnail": frame is not None}
        _write_atomic(meta_path, json.dumps(meta).encode())
        return VideoMetadata(
            cache_id=cache_id,
            duration_ms=duration_ms,
            thumbnail=image_path if frame is not None else None,
        )


__all__ = [
    "DEFAULT_THUMBNAIL_CONCURRENCY",
    "THUMBNAIL_CACHE_ENV_VAR",
    "THUMBNAIL_CONCURRENCY_ENV_VAR",
    "ThumbnailAbandoned",
    "ThumbnailCache",
    "ThumbnailError",
    "ThumbnailToolMissing",
    "VideoMetadata",
    "resolve_thumbnail_cache_dir",
    "resolve_thumbnail_concurrency",
]
