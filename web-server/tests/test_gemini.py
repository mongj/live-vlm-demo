from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest

from live_vlm_server.adapters.gemini import (
    GEMINI_AUDIO_MIME,
    GEMINI_LIVE_MODEL,
    GEMINI_VIDEO_MIME,
    GeminiAdapter,
    GeminiConfig,
    build_live_config,
    replies_from_live_message,
    resolve_gemini_api_key,
)
from live_vlm_server.buffers import AudioBuffer, FrameBuffer
from live_vlm_server.types import ModelSpec, Reply, SessionError, VideoFrame

MIN_JPEG = b"\xff\xd8\xff\xd9"
SPEC = ModelSpec(id="gemini-3-8-live", adapter="gemini", label="Gemini 3.8 Live")
PCM_SLICE = bytes(3_200)


class FakeLiveSession:
    def __init__(self, turns: list[list[object]] | None = None) -> None:
        self.sent: list[dict[str, Any]] = []
        self.tool_responses: list[Any] = []
        self._turns = [list(turn) for turn in (turns or [])]
        self.closed = False

    async def send_realtime_input(self, **kwargs: Any) -> None:
        self.sent.append(kwargs)

    async def send_tool_response(self, **kwargs: Any) -> None:
        self.tool_responses.append(kwargs)

    async def receive(self) -> AsyncIterator[object]:
        if not self._turns:
            await asyncio.Event().wait()
            return
        for message in self._turns.pop(0):
            yield message

    async def close(self) -> None:
        self.closed = True


def _frames(*timestamps: float) -> FrameBuffer:
    buffer = FrameBuffer(max_frames=1)
    for timestamp in timestamps:
        buffer.push(VideoFrame(jpeg=MIN_JPEG, t=timestamp))
    return buffer


def _audio(pcm: bytes | None = PCM_SLICE) -> AudioBuffer:
    buffer = AudioBuffer(seconds_per_request=0.1, retention_seconds=2.0)
    if pcm is not None:
        buffer.push(pcm)
    return buffer


def test_config_defaults_and_schema() -> None:
    config = GeminiConfig.model_validate({})
    assert config.system_instruction == ""
    assert config.voice == "Kore"
    with pytest.raises(Exception):
        GeminiConfig.model_validate({"voice": "Kore", "unknown": True})
    with pytest.raises(Exception):
        GeminiConfig.model_validate({"voice": "Nope"})


def test_resolve_api_key_prefers_override_and_skips_blank() -> None:
    assert resolve_gemini_api_key("  override  ", {"GEMINI_API_KEY": "env"}) == "override"
    assert resolve_gemini_api_key("  ", {"GEMINI_API_KEY": "env"}) == "env"
    assert resolve_gemini_api_key(None, {}) == ""


def test_build_live_config_enables_audio_and_transcripts() -> None:
    config = GeminiConfig.model_validate(
        {"system_instruction": "Be brief.", "voice": "Puck"}
    )
    live = build_live_config(config)
    assert [getattr(item, "value", item) for item in live.response_modalities or []] == [
        "AUDIO"
    ]
    assert live.system_instruction == "Be brief."
    assert live.input_audio_transcription is not None
    assert live.output_audio_transcription is not None
    voice = live.speech_config.voice_config.prebuilt_voice_config.voice_name
    assert voice == "Puck"
    assert live.realtime_input_config is not None
    coverage = live.realtime_input_config.turn_coverage
    assert getattr(coverage, "value", coverage) == "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO"
    empty = build_live_config(GeminiConfig.model_validate({}))
    assert empty.system_instruction is None
    assert GEMINI_LIVE_MODEL == "gemini-3.8-live"


def test_replies_map_audio_transcripts_and_turn_complete() -> None:
    audio = b"\x01\x00\x02\x00"
    streamed = replies_from_live_message(
        SimpleNamespace(
            data=audio,
            server_content=SimpleNamespace(
                output_transcription=SimpleNamespace(text="Hello"),
                input_transcription=SimpleNamespace(text="Hi"),
                turn_complete=False,
                interrupted=False,
            ),
            tool_call=None,
        ),
        last_t=12.0,
    )
    assert streamed == [
        Reply(text="Hello", audio=audio, raw="Hello\n[input] Hi", final=False, t=12.0)
    ]
    inline_only = replies_from_live_message(
        SimpleNamespace(
            data=None,
            server_content=SimpleNamespace(
                model_turn=SimpleNamespace(
                    parts=[SimpleNamespace(inline_data=SimpleNamespace(data=audio))]
                ),
                output_transcription=None,
                input_transcription=None,
                turn_complete=False,
                interrupted=False,
            ),
        ),
        last_t=None,
    )
    assert inline_only == [Reply(text="", audio=audio, raw="", final=False, t=None)]
    done = replies_from_live_message(
        SimpleNamespace(
            data=None,
            server_content=SimpleNamespace(
                output_transcription=None,
                input_transcription=None,
                turn_complete=True,
                interrupted=False,
            ),
        ),
        last_t=3.0,
    )
    assert done == [Reply(text="", audio=None, raw="", final=True, t=3.0)]
    assert replies_from_live_message(SimpleNamespace(data=None, server_content=None), last_t=1.0) == []
    input_only = replies_from_live_message(
        SimpleNamespace(
            data=None,
            server_content=SimpleNamespace(
                output_transcription=None,
                input_transcription=SimpleNamespace(text="What color is this?"),
                interim_input_transcription=SimpleNamespace(text="What col"),
                turn_complete=False,
                interrupted=False,
            ),
        ),
        last_t=5.0,
    )
    assert input_only == [
        Reply(text="", audio=None, raw="[input] What color is this?", final=False, t=5.0)
    ]
    interim_only = replies_from_live_message(
        SimpleNamespace(
            data=None,
            server_content=SimpleNamespace(
                output_transcription=None,
                input_transcription=None,
                interim_input_transcription=SimpleNamespace(text="What col"),
                turn_complete=False,
                interrupted=False,
            ),
        ),
        last_t=6.0,
    )
    assert interim_only == [
        Reply(text="", audio=None, raw="[input] What col", final=False, t=6.0)
    ]
    leftover = b"\x03\x00\x04\x00"
    interrupted = replies_from_live_message(
        SimpleNamespace(
            data=leftover,
            server_content=SimpleNamespace(
                output_transcription=None,
                input_transcription=None,
                turn_complete=False,
                interrupted=True,
            ),
        ),
        last_t=9.0,
    )
    assert interrupted == [
        Reply(
            text="",
            audio=leftover,
            raw="",
            final=True,
            interrupted=True,
            t=9.0,
        )
    ]


async def test_open_requires_api_key_and_uses_injected_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    adapter = GeminiAdapter(SPEC, {})
    with pytest.raises(SessionError, match="GEMINI_API_KEY is not set"):
        await adapter.open()
    session = FakeLiveSession()
    injected = GeminiAdapter(SPEC, {}, session=session)
    session_id = await injected.open()
    assert session_id.startswith("gemini-3-8-live-")
    await injected.close()
    assert session.closed is True


async def test_send_feed_sends_video_audio_and_text() -> None:
    session = FakeLiveSession()
    adapter = GeminiAdapter(SPEC, {"voice": "Aoede"}, session=session)
    await adapter.open()
    adapter.offer_text("What is on the desk?")
    adapter.offer_text("   ")
    adapter.offer_text("And the color?")
    assert await adapter.send_feed(_frames(1_700_000_000_000.0), _audio()) is True
    assert len(session.sent) == 3
    assert session.sent[0]["video"].data == MIN_JPEG
    assert session.sent[0]["video"].mime_type == GEMINI_VIDEO_MIME
    assert session.sent[1]["audio"].data == PCM_SLICE
    assert session.sent[1]["audio"].mime_type == GEMINI_AUDIO_MIME
    assert session.sent[2]["text"] == "What is on the desk?\nAnd the color?"
    assert await adapter.send_feed(FrameBuffer(1), AudioBuffer(0.1, 2.0)) is False
    await adapter.close()


async def test_video_is_rate_limited_to_one_fps() -> None:
    session = FakeLiveSession()
    adapter = GeminiAdapter(SPEC, {}, session=session)
    await adapter.open()
    assert await adapter.send_feed(_frames(1.0), AudioBuffer(0.1, 2.0)) is True
    assert len(session.sent) == 1
    assert await adapter.send_feed(_frames(2.0), AudioBuffer(0.1, 2.0)) is True
    assert len(session.sent) == 1
    adapter._last_video_mono = 0.0
    assert await adapter.send_feed(_frames(3.0), AudioBuffer(0.1, 2.0)) is True
    assert len(session.sent) == 2
    await adapter.close()


async def test_read_replies_and_unsupported_tool_ack() -> None:
    tool_message = SimpleNamespace(
        data=None,
        server_content=None,
        tool_call=SimpleNamespace(
            function_calls=[SimpleNamespace(name="lookup", id="call-1")]
        ),
    )
    final_message = SimpleNamespace(
        data=None,
        server_content=SimpleNamespace(
            output_transcription=SimpleNamespace(text="Done"),
            input_transcription=None,
            turn_complete=True,
            interrupted=False,
        ),
        tool_call=None,
    )
    session = FakeLiveSession(turns=[[tool_message, final_message]])
    adapter = GeminiAdapter(SPEC, {}, session=session)
    await adapter.open()
    replies: list[Reply] = []
    async for reply in adapter.read_replies():
        replies.append(reply)
        if reply.final:
            break
    assert replies == [Reply(text="Done", audio=None, raw="Done", final=True, t=None)]
    assert session.tool_responses[0]["function_responses"][0].name == "lookup"
    await adapter.close()
