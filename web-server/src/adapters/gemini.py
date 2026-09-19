from __future__ import annotations

import logging
import os
import time
from collections.abc import AsyncIterator
from typing import Any, ClassVar, Literal

from google import genai
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field

from .base import Adapter
from ..buffers import AudioBuffer, FrameBuffer
from ..types import ModelSpec, Reply, SessionError, make_session_id

logger = logging.getLogger(__name__)

GEMINI_LIVE_MODEL = "gemini-3.8-live"
GEMINI_API_KEY_ENV = "GEMINI_API_KEY"
GEMINI_AUDIO_MIME = "audio/pcm;rate=16000"
GEMINI_VIDEO_MIME = "image/jpeg"
GEMINI_MAX_FRAMES = 1
GEMINI_AUDIO_SLICE_SECONDS = 0.1
GEMINI_AUDIO_RETENTION_SECONDS = 2.0
GEMINI_VIDEO_MIN_INTERVAL_SECONDS = 1.0
GEMINI_VOICES = Literal["Aoede", "Charon", "Fenrir", "Kore", "Puck", "Zephyr"]


class GeminiConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    system_instruction: str = Field(
        default="",
        title="System instruction",
        description="Optional system prompt for the Live session.",
    )
    voice: GEMINI_VOICES = Field(
        default="Kore",
        title="Voice",
        description="Prebuilt Gemini Live voice.",
    )


def resolve_gemini_api_key(
    override: str | None = None,
    environ: dict[str, str] | None = None,
) -> str:
    if override is not None and override.strip():
        return override.strip()
    env = os.environ if environ is None else environ
    return env.get(GEMINI_API_KEY_ENV, "").strip()


def build_live_config(config: GeminiConfig) -> types.LiveConnectConfig:
    instruction = config.system_instruction.strip()
    return types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        system_instruction=instruction or None,
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name=config.voice
                )
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        # Gemini 3.x default: a turn includes speech/text activity plus all
        # video since the last turn. Video frames do not start a turn.
        realtime_input_config=types.RealtimeInputConfig(
            turn_coverage=types.TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO
        ),
    )


def _pcm_bytes(value: object) -> bytes | None:
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        return data or None
    return None


def _transcription_text(value: object) -> str:
    text = getattr(value, "text", None)
    return text if isinstance(text, str) else ""


def _audio_from_message(message: object) -> bytes | None:
    data = _pcm_bytes(getattr(message, "data", None))
    if data is not None:
        return data
    content = getattr(message, "server_content", None)
    model_turn = getattr(content, "model_turn", None) if content is not None else None
    chunks: list[bytes] = []
    for part in getattr(model_turn, "parts", None) or []:
        inline = getattr(part, "inline_data", None)
        pcm = _pcm_bytes(getattr(inline, "data", None) if inline is not None else None)
        if pcm is not None:
            chunks.append(pcm)
    if not chunks:
        return None
    return b"".join(chunks)


def replies_from_live_message(message: object, *, last_t: float | None) -> list[Reply]:
    content = getattr(message, "server_content", None)
    output_text = ""
    input_text = ""
    raw_parts: list[str] = []
    final = False
    interrupted = False
    if content is not None:
        output_text = _transcription_text(getattr(content, "output_transcription", None))
        input_text = _transcription_text(getattr(content, "input_transcription", None))
        if not input_text:
            input_text = _transcription_text(
                getattr(content, "interim_input_transcription", None)
            )
        if output_text:
            raw_parts.append(output_text)
        if input_text:
            raw_parts.append(f"[input] {input_text}")
        interrupted = bool(getattr(content, "interrupted", False))
        if getattr(content, "turn_complete", False) or interrupted:
            final = True
    audio = _audio_from_message(message)
    raw = "\n".join(raw_parts)
    if not output_text and audio is None and not raw and not final:
        return []
    return [
        Reply(
            text=output_text,
            audio=audio,
            raw=raw,
            final=final,
            interrupted=interrupted,
            t=last_t,
        )
    ]


def _function_calls(message: object) -> list[object]:
    tool_call = getattr(message, "tool_call", None)
    calls = getattr(tool_call, "function_calls", None) if tool_call is not None else None
    return list(calls) if calls else []


class GeminiAdapter(Adapter[GeminiConfig]):
    config_model: ClassVar[type[BaseModel]] = GeminiConfig

    def __init__(
        self,
        spec: ModelSpec,
        raw_config: dict[str, Any],
        *,
        api_key: str | None = None,
        session: Any | None = None,
    ) -> None:
        super().__init__(spec, raw_config)
        self.max_frames_per_request = GEMINI_MAX_FRAMES
        self.audio_seconds_per_request = GEMINI_AUDIO_SLICE_SECONDS
        self.audio_retention_seconds = GEMINI_AUDIO_RETENTION_SECONDS
        self.session_id = ""
        self._query = ""
        self._api_key = api_key
        self._injected_session = session
        self._session: Any | None = None
        self._connect_cm: Any | None = None
        self._last_t: float | None = None
        self._last_video_mono = 0.0

    async def open(self) -> str:
        self.session_id = make_session_id(self.spec.id)
        if self._injected_session is not None:
            self._session = self._injected_session
            return self.session_id
        key = resolve_gemini_api_key(self._api_key)
        if not key:
            raise SessionError("GEMINI_API_KEY is not set", fatal=True)
        connect_cm = genai.Client(api_key=key).aio.live.connect(
            model=GEMINI_LIVE_MODEL,
            config=build_live_config(self.config),
        )
        self._connect_cm = connect_cm
        try:
            self._session = await connect_cm.__aenter__()
        except Exception as exc:
            await self._close_connect(exc)
            raise SessionError(f"Gemini open failed: {exc}", fatal=True) from exc
        except BaseException as exc:
            await self._close_connect(exc)
            raise
        return self.session_id

    def offer_text(self, text: str) -> None:
        stripped = text.strip()
        if not stripped:
            return
        if self._query:
            self._query = f"{self._query}\n{stripped}"
        else:
            self._query = stripped

    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool:
        session = self._session
        if session is None:
            raise SessionError("Gemini session is not open", fatal=True)
        text = self._query
        self._query = ""
        pcm = audio.consume()
        batch = frames.consume()
        if not text and pcm is None and not batch:
            return False
        if batch:
            self._last_t = batch[-1].t
        try:
            if batch and self._should_send_video():
                await session.send_realtime_input(
                    video=types.Blob(data=batch[-1].jpeg, mime_type=GEMINI_VIDEO_MIME)
                )
                self._last_video_mono = time.monotonic()
            if pcm is not None:
                await session.send_realtime_input(
                    audio=types.Blob(data=pcm, mime_type=GEMINI_AUDIO_MIME)
                )
            if text:
                await session.send_realtime_input(text=text)
        except SessionError:
            raise
        except Exception as exc:
            raise SessionError(f"Gemini send failed: {exc}", fatal=False) from exc
        return True

    async def read_replies(self) -> AsyncIterator[Reply]:
        session = self._session
        if session is None:
            raise SessionError("Gemini session is not open", fatal=True)
        while True:
            try:
                async for message in session.receive():
                    await self._ack_unsupported_tools(message)
                    for reply in replies_from_live_message(message, last_t=self._last_t):
                        yield reply
            except SessionError:
                raise
            except Exception as exc:
                raise SessionError(f"Gemini receive failed: {exc}", fatal=True) from exc

    async def close(self) -> None:
        self._query = ""
        self._last_t = None
        self._last_video_mono = 0.0
        await self._close_connect(None)
        injected = self._injected_session
        self._injected_session = None
        if injected is not None and hasattr(injected, "close"):
            try:
                await injected.close()
            except Exception:
                logger.exception("Gemini injected session close failed")

    def _should_send_video(self) -> bool:
        if self._last_video_mono <= 0.0:
            return True
        return time.monotonic() - self._last_video_mono >= GEMINI_VIDEO_MIN_INTERVAL_SECONDS

    async def _ack_unsupported_tools(self, message: object) -> None:
        session = self._session
        calls = _function_calls(message)
        if session is None or not calls:
            return
        responses = [
            types.FunctionResponse(
                name=str(getattr(call, "name", None) or "unknown"),
                id=getattr(call, "id", None),
                response={"error": "Tools are not enabled in this playground"},
            )
            for call in calls
        ]
        try:
            await session.send_tool_response(function_responses=responses)
        except Exception as exc:
            raise SessionError(f"Gemini tool response failed: {exc}", fatal=False) from exc

    async def _close_connect(self, error: BaseException | None) -> None:
        connect_cm = self._connect_cm
        self._connect_cm = None
        self._session = None
        if connect_cm is None:
            return
        exc_type = type(error) if error is not None else None
        exc_tb = error.__traceback__ if error is not None else None
        try:
            await connect_cm.__aexit__(exc_type, error, exc_tb)
        except Exception:
            logger.exception("Gemini session close failed")
