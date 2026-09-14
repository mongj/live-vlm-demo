from __future__ import annotations

import base64
import binascii

from .types import SessionError

MAX_MEDIA_B64_CHARS = 4 * 1024 * 1024
JPEG_SOI = b"\xff\xd8"


def encode_media_b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def decode_media_b64(value: str) -> bytes:
    if len(value) > MAX_MEDIA_B64_CHARS:
        raise SessionError("Media payload exceeds size limit", fatal=False)
    try:
        return base64.b64decode(value, validate=True)
    except binascii.Error as exc:
        raise SessionError("Invalid base64 media payload", fatal=False) from exc


def require_jpeg(data: bytes) -> None:
    if not data.startswith(JPEG_SOI):
        raise SessionError("Frame is not JPEG", fatal=False)


def require_pcm(data: bytes) -> None:
    if len(data) % 2 != 0:
        raise SessionError("PCM must contain an even number of bytes", fatal=False)


def decode_jpeg_b64(value: str) -> bytes:
    data = decode_media_b64(value)
    require_jpeg(data)
    return data


def decode_pcm_b64(value: str) -> bytes:
    data = decode_media_b64(value)
    require_pcm(data)
    return data
