from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4


@dataclass(frozen=True)
class ModelSpec:
    id: str
    adapter: str
    label: str
    base_url: str | None = None


@dataclass(frozen=True)
class VideoFrame:
    jpeg: bytes
    t: float


@dataclass(frozen=True)
class Reply:
    text: str = ""
    audio: bytes | None = None
    raw: str = ""
    final: bool = False
    interrupted: bool = False
    t: float | None = None


class SessionError(Exception):
    def __init__(self, message: str, fatal: bool = True) -> None:
        super().__init__(message)
        self.message = message
        self.fatal = fatal


def make_session_id(catalog_id: str) -> str:
    return f"{catalog_id}-{uuid4().hex}"
