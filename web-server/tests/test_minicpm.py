from __future__ import annotations

import asyncio
import base64
import json
import struct
from collections.abc import AsyncIterator
from typing import Any

import pytest
from websockets.asyncio.server import ServerConnection, serve

from live_vlm_server.buffers import AudioBuffer, FrameBuffer
from live_vlm_server.types import ModelSpec, SessionError, VideoFrame


SPEC = ModelSpec(
    id="minicpm-o-4-5", adapter="minicpm", label="MiniCPM-o 4.5 (Live video)",
    base_url="ws://127.0.0.1:18006/v1/realtime?mode=video",
)
JPEG = b"\xff\xd8\xff\xd9"


def _adapter(url: str, **config: Any) -> Any:
    from live_vlm_server.adapters.minicpm import MiniCPMAdapter

    spec = ModelSpec(SPEC.id, SPEC.adapter, SPEC.label, url)
    return MiniCPMAdapter(spec, config)


def _buffers() -> tuple[FrameBuffer, AudioBuffer]:
    return FrameBuffer(1), AudioBuffer(0.1, 2.0)


def test_pcm_conversion_clips_and_rejects_invalid_data() -> None:
    from live_vlm_server.adapters.minicpm import f32le_to_s16le, s16le_to_f32le

    assert struct.unpack("<3f", s16le_to_f32le(struct.pack("<3h", -32768, 0, 32767))) == (
        -1.0, 0.0, pytest.approx(32767 / 32768),
    )
    assert f32le_to_s16le(struct.pack("<6f", -2.0, -1.0, 0.0, 0.5, 1.0, 2.0)) == struct.pack(
        "<6h", -32768, -32768, 0, 16384, 32767, 32767
    )
    for bad in [b"x", struct.pack("<f", float("nan")), struct.pack("<f", float("inf"))]:
        with pytest.raises(SessionError):
            f32le_to_s16le(bad)
    with pytest.raises(SessionError):
        s16le_to_f32le(b"x")


@pytest.mark.asyncio
async def test_queue_handshake_silent_video_tick_and_output_boundaries(monkeypatch: pytest.MonkeyPatch) -> None:
    import live_vlm_server.adapters.minicpm as minicpm

    monkeypatch.setattr(minicpm, "SEND_INTERVAL_SECONDS", 0.05)
    inputs: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    initialized: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def upstream(ws: ServerConnection) -> None:
        await ws.send(json.dumps({"type": "session.queued", "position": 1}))
        await ws.send(json.dumps({"type": "session.queue_done"}))
        initialized.put_nowait(json.loads(await ws.recv()))
        await ws.send(json.dumps({"type": "session.created", "session_id": "upstream-1"}))
        first = json.loads(await ws.recv())
        inputs.put_nowait(first)
        await ws.send(json.dumps({"type": "response.output.delta", "kind": "listen"}))
        await ws.send(json.dumps({"type": "response.output.delta", "kind": "text", "text": "There", "response_id": "r1"}))
        await ws.send(json.dumps({"type": "response.output.delta", "kind": "audio", "audio": base64.b64encode(struct.pack("<2f", -1.0, 1.0)).decode(), "response_id": "r1"}))
        await ws.send(json.dumps({"type": "response.output.delta", "kind": "listen"}))
        await ws.send(json.dumps({"type": "response.done", "text": "ignored"}))
        try:
            async for raw in ws:
                message = json.loads(raw)
                if message["type"] == "input.append":
                    inputs.put_nowait(message)
                if message["type"] == "session.close":
                    break
        except Exception:
            pass

    async with serve(upstream, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        adapter = _adapter(f"ws://127.0.0.1:{port}/v1/realtime?mode=video", system_prompt="Be concise")
        assert (await adapter.open()).startswith(SPEC.id)
        assert await asyncio.wait_for(initialized.get(), 1) == {"type": "session.init", "payload": {"system_prompt": "Be concise"}}
        frames, audio = _buffers()
        frames.push(VideoFrame(JPEG, 123.0))
        audio.push(struct.pack("<1600h", *([16384] * 1600)))
        while await adapter.send_feed(frames, audio):
            pass
        first = await asyncio.wait_for(inputs.get(), 1)
        assert first["type"] == "input.append"
        assert first["input"]["video_frames"] == [base64.b64encode(JPEG).decode()]
        samples = struct.unpack("<16000f", base64.b64decode(first["input"]["audio"]))
        assert samples[:1600] == (0.5,) * 1600
        assert samples[1600:] == (0.0,) * 14400
        replies: AsyncIterator[Any] = adapter.read_replies()
        text = await asyncio.wait_for(anext(replies), 1)
        sound = await asyncio.wait_for(anext(replies), 1)
        end = await asyncio.wait_for(anext(replies), 1)
        assert (text.text, text.raw, text.final, text.t) == ("There", "There", False, 123.0)
        assert sound.audio == struct.pack("<2h", -32768, 32767)
        assert sound.final is False and end.final is True
        second = await asyncio.wait_for(inputs.get(), 1)
        assert "video_frames" not in second["input"]
        assert set(base64.b64decode(second["input"]["audio"])) == {0}
        with pytest.raises(SessionError, match="typed text.*not supported") as exc:
            adapter.offer_text("hello")
        assert exc.value.fatal is False
        adapter.offer_text(" \t")
        await adapter.close()


@pytest.mark.asyncio
async def test_handshake_timeout_and_malformed_events_close_connection() -> None:
    disconnected = asyncio.Event()

    async def stalled(ws: ServerConnection) -> None:
        try:
            async for _ in ws:
                pass
        finally:
            disconnected.set()

    async with serve(stalled, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        adapter = _adapter(f"ws://127.0.0.1:{port}/v1/realtime?mode=video", startup_timeout_s=0.1)
        with pytest.raises(SessionError, match="startup timed out"):
            await adapter.open()
        await asyncio.wait_for(disconnected.wait(), 1)


@pytest.mark.asyncio
async def test_startup_timeout_covers_connection_and_queue_together(monkeypatch: pytest.MonkeyPatch) -> None:
    import live_vlm_server.adapters.minicpm as minicpm

    class Socket:
        closed = False

        async def send(self, _message: str) -> None:
            pass

        async def close(self) -> None:
            self.closed = True

    socket = Socket()

    async def slow_connect(*_args: Any, **_kwargs: Any) -> Socket:
        await asyncio.sleep(0.07)
        return socket

    async def slow_handshake(_self: Any) -> None:
        await asyncio.sleep(0.07)

    monkeypatch.setattr(minicpm, "connect", slow_connect)
    monkeypatch.setattr(minicpm.MiniCPMAdapter, "_handshake", slow_handshake)
    adapter = _adapter(SPEC.base_url or "", startup_timeout_s=0.1)
    with pytest.raises(SessionError, match="startup timed out"):
        await adapter.open()
    assert socket.closed


@pytest.mark.asyncio
async def test_remote_closed_wakes_reader_with_reason() -> None:
    async def upstream(ws: ServerConnection) -> None:
        await ws.send(json.dumps({"type": "session.queue_done"}))
        await ws.recv()
        await ws.send(json.dumps({"type": "session.created", "session_id": "s1"}))
        await ws.send(json.dumps({"type": "session.closed", "reason": "timeout"}))

    async with serve(upstream, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        adapter = _adapter(f"ws://127.0.0.1:{port}/v1/realtime?mode=video")
        await adapter.open()
        with pytest.raises(SessionError, match="300-second.*timeout"):
            await asyncio.wait_for(anext(adapter.read_replies()), 1)
        await adapter.close()


@pytest.mark.asyncio
async def test_remote_closed_keeps_overload_reason_with_diagnostic() -> None:
    async def upstream(ws: ServerConnection) -> None:
        await ws.send(json.dumps({"type": "session.queue_done"}))
        await ws.recv()
        await ws.send(json.dumps({"type": "session.created", "session_id": "s1"}))
        await ws.send(json.dumps({
            "type": "session.closed", "reason": "input_overload",
            "diagnostic": {"message": "pending input count limit reached"},
        }))

    async with serve(upstream, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        adapter = _adapter(f"ws://127.0.0.1:{port}/v1/realtime?mode=video")
        await adapter.open()
        with pytest.raises(SessionError, match="input_overload.*pending input count limit reached"):
            await asyncio.wait_for(anext(adapter.read_replies()), 1)
        await adapter.close()


@pytest.mark.asyncio
async def test_unexpected_eof_wakes_reader() -> None:
    async def upstream(ws: ServerConnection) -> None:
        await ws.send(json.dumps({"type": "session.queue_done"}))
        await ws.recv()
        await ws.send(json.dumps({"type": "session.created", "session_id": "s1"}))

    async with serve(upstream, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        adapter = _adapter(f"ws://127.0.0.1:{port}/v1/realtime?mode=video")
        await adapter.open()
        with pytest.raises(SessionError, match="closed unexpectedly"):
            await asyncio.wait_for(anext(adapter.read_replies()), 1)
        await adapter.close()


@pytest.mark.asyncio
async def test_malformed_handshake_is_fatal_and_cleans_up() -> None:
    disconnected = asyncio.Event()

    async def upstream(ws: ServerConnection) -> None:
        try:
            await ws.send('{"type": "session.created"}')
            async for _ in ws:
                pass
        finally:
            disconnected.set()

    async with serve(upstream, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        adapter = _adapter(f"ws://127.0.0.1:{port}/v1/realtime?mode=video")
        with pytest.raises(SessionError, match="unexpected startup event"):
            await adapter.open()
        await asyncio.wait_for(disconnected.wait(), 1)


@pytest.mark.asyncio
async def test_background_send_failure_reaches_reader(monkeypatch: pytest.MonkeyPatch) -> None:
    import live_vlm_server.adapters.minicpm as minicpm

    monkeypatch.setattr(minicpm, "SEND_INTERVAL_SECONDS", 0.02)

    async def upstream(ws: ServerConnection) -> None:
        await ws.send(json.dumps({"type": "session.queue_done"}))
        await ws.recv()
        await ws.send(json.dumps({"type": "session.created", "session_id": "s1"}))
        async for _ in ws:
            pass

    async with serve(upstream, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        adapter = _adapter(f"ws://127.0.0.1:{port}/v1/realtime?mode=video")
        await adapter.open()
        assert adapter._ws is not None

        async def fail_send(_message: str) -> None:
            raise OSError("synthetic send failure")

        monkeypatch.setattr(adapter._ws, "send", fail_send)
        with pytest.raises(SessionError, match="send failed: synthetic send failure"):
            await asyncio.wait_for(anext(adapter.read_replies()), 1)
        await adapter.close()


@pytest.mark.asyncio
async def test_slow_send_keeps_one_second_deadlines_without_dropping_live_audio(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import live_vlm_server.adapters.minicpm as minicpm

    monkeypatch.setattr(minicpm, "SEND_INTERVAL_SECONDS", 0.1)

    class SlowSocket:
        def __init__(self) -> None:
            self.sent: list[tuple[float, dict[str, Any]]] = []
            self.first = asyncio.Event()
            self.second = asyncio.Event()

        async def send(self, raw: str) -> None:
            self.sent.append((asyncio.get_running_loop().time(), json.loads(raw)))
            if len(self.sent) == 1:
                self.first.set()
            if len(self.sent) == 2:
                self.second.set()
            await asyncio.sleep(0.05)

    socket = SlowSocket()
    adapter = _adapter(SPEC.base_url or "")
    adapter._ws = socket
    frames, audio = _buffers()
    task = asyncio.create_task(adapter._send_loop())
    try:
        await asyncio.wait_for(socket.first.wait(), 1)
        for marker in range(1, 16):
            audio.push(struct.pack("<1600h", *([marker * 1000] * 1600)))
            while await adapter.send_feed(frames, audio):
                pass
            await asyncio.sleep(0.01)
        await asyncio.wait_for(socket.second.wait(), 1)
        first_start, _ = socket.sent[0]
        second_start, second = socket.sent[1]
        assert 0.08 <= second_start - first_start < 0.135
        first_sample = struct.unpack_from("<f", base64.b64decode(second["input"]["audio"]))[0]
        assert first_sample == pytest.approx(1000 / 32768)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_late_boundary_chunk_is_preserved_in_next_audio_packet(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import live_vlm_server.adapters.minicpm as minicpm

    monkeypatch.setattr(minicpm, "SEND_INTERVAL_SECONDS", 0.03)

    class Socket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []
            self.first = asyncio.Event()
            self.third = asyncio.Event()

        async def send(self, raw: str) -> None:
            self.sent.append(json.loads(raw))
            if len(self.sent) == 1:
                self.first.set()
            if len(self.sent) == 3:
                self.third.set()

    socket = Socket()
    adapter = _adapter(SPEC.base_url or "")
    adapter._ws = socket
    frames, audio = _buffers()

    async def feed(marker: int) -> None:
        audio.push(struct.pack("<1600h", *([marker * 1000] * 1600)))
        while await adapter.send_feed(frames, audio):
            pass

    for marker in range(1, 10):
        await feed(marker)
    task = asyncio.create_task(adapter._send_loop())
    try:
        await asyncio.wait_for(socket.first.wait(), 1)
        for marker in range(10, 21):
            await feed(marker)
        await asyncio.wait_for(socket.third.wait(), 1)
        transmitted: list[int] = []
        for packet in socket.sent[:3]:
            pcm = base64.b64decode(packet["input"]["audio"])
            samples = struct.unpack("<16000f", pcm)
            transmitted.extend(round(samples[offset] * 32768) for offset in range(0, 16000, 1600) if samples[offset] != 0)
        assert transmitted == [marker * 1000 for marker in range(1, 21)]
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_audio_overload_keeps_freshest_two_seconds_and_reports_drop(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    import live_vlm_server.adapters.minicpm as minicpm

    monkeypatch.setattr(minicpm, "SEND_INTERVAL_SECONDS", 0.02)

    class Socket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []
            self.ready = asyncio.Event()

        async def send(self, raw: str) -> None:
            self.sent.append(json.loads(raw))
            if len(self.sent) == 2:
                self.ready.set()

    socket = Socket()
    adapter = _adapter(SPEC.base_url or "")
    adapter._ws = socket
    frames, audio = _buffers()
    for marker in range(1, 26):
        audio.push(struct.pack("<1600h", *([marker * 1000] * 1600)))
        while await adapter.send_feed(frames, audio):
            pass
    task = asyncio.create_task(adapter._send_loop())
    try:
        await asyncio.wait_for(socket.ready.wait(), 1)
        samples = struct.unpack("<16000f", base64.b64decode(socket.sent[0]["input"]["audio"]))
        assert samples[0] == pytest.approx(6000 / 32768)
        assert samples[-1] == pytest.approx(15000 / 32768)
        later = struct.unpack("<16000f", base64.b64decode(socket.sent[1]["input"]["audio"]))
        assert later[0] == pytest.approx(16000 / 32768)
        assert later[-1] == pytest.approx(25000 / 32768)
        assert "dropping oldest" in caplog.text
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def test_invalid_video_endpoint_rejected() -> None:
    for url in ["http://localhost/v1/realtime?mode=video", "ws://localhost/v1/realtime?mode=chat", "ws://localhost/other?mode=video", "ws://localhost/v1/realtime?mode=video#frag", "ws://localhost:bad/v1/realtime?mode=video", "ws://localhost/v1/realtime?mode"]:
        with pytest.raises(SessionError, match="MiniCPM.*URL"):
            _adapter(url)
