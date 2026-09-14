from __future__ import annotations

import base64
import json
import math

import pytest

from live_vlm_server.codecs import (
    MAX_MEDIA_B64_CHARS,
    decode_jpeg_b64,
    decode_media_b64,
    decode_pcm_b64,
    encode_media_b64,
)
from live_vlm_server.protocol import InputAppendMessage, SessionStartMessage, parse_inbound
from live_vlm_server.types import SessionError

MIN_JPEG = b"\xff\xd8\xff\xd9"


def test_parse_start_defaults_config_to_empty_object() -> None:
    parsed = parse_inbound('{"type": "session.start", "model": "mock"}')
    assert isinstance(parsed, SessionStartMessage)
    assert parsed.model == "mock"
    assert parsed.config == {}


def test_parse_feed_optional_fields_and_timestamp() -> None:
    parsed = parse_inbound(
        '{"type": "input.append", "frame": "a", "audio": null, "text": "hi", "t": 1.5}'
    )
    assert isinstance(parsed, InputAppendMessage)
    assert parsed.frame == "a"
    assert parsed.audio is None
    assert parsed.text == "hi"
    assert parsed.t == 1.5
    omitted = parse_inbound('{"type": "input.append"}')
    assert isinstance(omitted, InputAppendMessage)
    assert omitted.frame is None
    assert omitted.t is None


def test_invalid_json_unknown_type_and_extra_fields_share_error_path() -> None:
    with pytest.raises(SessionError) as malformed:
        parse_inbound("{")
    assert malformed.value.fatal is False
    assert "Malformed JSON" in malformed.value.message
    with pytest.raises(SessionError) as unknown:
        parse_inbound('{"type": "nope"}')
    assert unknown.value.fatal is False
    with pytest.raises(SessionError) as extra:
        parse_inbound('{"type": "session.start", "model": "mock", "nope": 1}')
    assert extra.value.fatal is False


@pytest.mark.parametrize("value", [-0.1, math.inf, math.nan])
def test_timestamp_must_be_finite_and_non_negative(value: float) -> None:
    with pytest.raises(SessionError):
        parse_inbound(json.dumps({"type": "input.append", "t": value}))


def test_zero_timestamp_is_accepted() -> None:
    parsed = parse_inbound('{"type": "input.append", "t": 0}')
    assert isinstance(parsed, InputAppendMessage)
    assert parsed.t == 0


def test_base64_size_and_strictness() -> None:
    encoded = encode_media_b64(MIN_JPEG)
    assert decode_media_b64(encoded) == MIN_JPEG
    with pytest.raises(SessionError, match="size limit"):
        decode_media_b64("A" * (MAX_MEDIA_B64_CHARS + 1))
    with pytest.raises(SessionError, match="Invalid base64"):
        decode_media_b64("!!!!")


def test_jpeg_and_pcm_byte_checks() -> None:
    jpeg_b64 = encode_media_b64(MIN_JPEG)
    assert decode_jpeg_b64(jpeg_b64) == MIN_JPEG
    with pytest.raises(SessionError, match="JPEG"):
        decode_jpeg_b64(encode_media_b64(b"not-jpeg"))
    assert decode_pcm_b64(encode_media_b64(b"\x00\x01")) == b"\x00\x01"
    with pytest.raises(SessionError, match="even"):
        decode_pcm_b64(base64.b64encode(b"\x00").decode("ascii"))
