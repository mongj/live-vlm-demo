"""One retained CPU inference child, bounded queues and interruptible requests."""
import asyncio
from dataclasses import dataclass
import multiprocessing
import os
import signal
import sys
import threading
import time

from speech_engines import SpeechEngines, SpeechFailure, validate_pcm, validate_text


def _guard_parent(parent_pid):
    if sys.platform == "linux":
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            raise SpeechFailure("unavailable")
        # Covers the race where the parent died before prctl was installed.
        if os.getppid() != parent_pid: os._exit(1)
    else:
        # Local development fallback; Linux deployments use kernel enforcement.
        def watch():
            while os.getppid() == parent_pid: time.sleep(.1)
            os._exit(1)
        threading.Thread(target=watch, daemon=True).start()


def _engine_main(connection, root, factory, parent_pid):
    _guard_parent(parent_pid)
    os.environ.update(CUDA_VISIBLE_DEVICES="", OMP_NUM_THREADS="2", MKL_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2",
                      HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    # This child uses only its inherited pipe and local assets, never network APIs.
    import socket
    original_connect = socket.socket.connect
    def local_only(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            raise OSError("Speech network access disabled")
        return original_connect(sock, address)
    socket.socket.connect = local_only
    try:
        engine = factory(root)
        connection.send((True, None))
        while True:
            kind, data = connection.recv()
            value = None
            try:
                if kind == "shutdown": break
                value = None if kind == "flush" else engine.synthesize(data) if kind == "tts" else engine.transcribe(data)
                connection.send((True, value))
            except Exception as error:
                code = str(error) if isinstance(error, SpeechFailure) else "unavailable"
                connection.send((False, code))
            finally:
                data = value = None
    except (EOFError, BrokenPipeError):
        pass
    except Exception:
        try: connection.send((False, "unavailable"))
        except (OSError, EOFError): pass
    finally:
        connection.close()


@dataclass
class _Work:
    session: str
    kind: str
    data: bytes | str | None
    final: bool
    future: asyncio.Future


class SpeechBroker:
    def __init__(self, asset_root, *, engine_factory=SpeechEngines):
        self.root, self.factory = str(asset_root), engine_factory
        self.process = self.connection = self.pidfd = None
        self.ready = False
        self.closed = False
        self.active = self.pending_asr = self.pending_tts = None
        self.runner = None
        self.wake = asyncio.Event()
        self.lifecycle = asyncio.Lock()

    async def start(self):
        async with self.lifecycle:
            if self.closed: raise SpeechFailure("cancelled")
            if self.ready: return
            context = multiprocessing.get_context("spawn")
            parent, child = context.Pipe()
            self.connection = parent
            self.process = context.Process(target=_engine_main, args=(child, self.root, self.factory, os.getpid()), daemon=True)
            self.process.start()
            child.close()
            if hasattr(os, "pidfd_open"):
                self.pidfd = os.pidfd_open(self.process.pid)
            try:
                ok, _ = await self._receive(30)
                if not ok: raise SpeechFailure("unavailable")
                self.ready = True
                self.runner = asyncio.create_task(self._run())
            except BaseException:
                await self._stop_child()
                raise

    async def _receive(self, timeout):
        async with asyncio.timeout(timeout):
            while self.connection is not None:
                if self.connection.poll():
                    # poll may expose only a message header. Keep a stalled
                    # native writer from blocking cancellation/deadline handling.
                    return await asyncio.to_thread(self.connection.recv)
                if self.process is None or not self.process.is_alive():
                    raise SpeechFailure("unavailable")
                await asyncio.sleep(.01)
        raise SpeechFailure("unavailable")

    @staticmethod
    def _fail(work, code):
        if work is not None and not work.future.done():
            work.future.set_exception(SpeechFailure(code))

    async def _run(self):
        try:
            while True:
                await self.wake.wait()
                self.wake.clear()
                while self.pending_tts is not None or self.pending_asr is not None:
                    if self.pending_tts is not None:
                        work, self.pending_tts = self.pending_tts, None
                    else:
                        work, self.pending_asr = self.pending_asr, None
                    self.active = work
                    value = None
                    try:
                        if work.future.cancelled(): continue
                        self.connection.send((work.kind, work.data))
                        ok, value = await self._receive(30)
                        if not work.future.done():
                            if ok: work.future.set_result(value)
                            else: work.future.set_exception(SpeechFailure(value))
                    except TimeoutError:
                        self._fail(work, "timeout")
                        raise SpeechFailure("timeout")
                    except BaseException:
                        self._fail(work, "unavailable")
                        raise
                    finally:
                        work.data = None
                        self.active = work = value = None
        except asyncio.CancelledError:
            raise
        except Exception:
            self._fail(self.active, "unavailable")
            self._fail(self.pending_asr, "unavailable")
            self._fail(self.pending_tts, "unavailable")
            self.active = self.pending_asr = self.pending_tts = None
            self.ready = False
            await self._stop_child()

    async def _submit(self, session, kind, data, final):
        if not self.ready or self.closed: raise SpeechFailure("unavailable")
        future = asyncio.get_running_loop().create_future()
        work = _Work(session, kind, data, final, future)
        if kind != "asr":
            if self.pending_tts is not None or (self.active and self.active.kind == "tts"):
                raise SpeechFailure("busy")
            if self.pending_asr and not self.pending_asr.final:
                self._fail(self.pending_asr, "cancelled")
                self.pending_asr = None
            self.pending_tts = work
        else:
            if self.pending_asr is not None:
                if self.pending_asr.final: raise SpeechFailure("busy")
                self._fail(self.pending_asr, "cancelled")
            self.pending_asr = work
        self.wake.set()
        return await future

    async def transcribe(self, session_id, input_id, revision, pcm, final):
        validate_pcm(pcm, 15)
        return await self._submit(session_id, "asr", pcm, final)

    async def synthesize(self, session_id, request_id, text):
        validate_text(text)
        return await self._submit(session_id, "tts", text, True)

    async def _stop_child(self, *, graceful=False):
        self.ready = False
        process, self.process = self.process, None
        if process is not None:
            if graceful and process.is_alive() and self.connection is not None:
                try: self.connection.send(("shutdown", None))
                except (OSError, EOFError): pass
                await asyncio.to_thread(process.join, .5)
            if process.is_alive():
                if self.pidfd is not None: signal.pidfd_send_signal(self.pidfd, signal.SIGTERM)
                else: process.terminate()
                await asyncio.to_thread(process.join, 2)
            if process.is_alive():
                if self.pidfd is not None: signal.pidfd_send_signal(self.pidfd, signal.SIGKILL)
                else: process.kill()
                await asyncio.to_thread(process.join, 2)
            if process.is_alive():
                self.closed = True
                raise SpeechFailure("unavailable")
            process.join()
            process.close()
        if self.pidfd is not None:
            os.close(self.pidfd)
            self.pidfd = None
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    async def cancel_session(self, session_id):
        async with self.lifecycle:
            for name in ("pending_asr", "pending_tts"):
                work = getattr(self, name)
                if work and work.session == session_id:
                    self._fail(work, "cancelled")
                    setattr(self, name, None)
            restart = bool(self.active and self.active.session == session_id)
            if restart:
                self._fail(self.active, "cancelled")
                self.runner.cancel()
                await asyncio.gather(self.runner, return_exceptions=True)
                self.runner = None
                self._fail(self.active, "cancelled")
                self.active = None
                await self._stop_child()
            elif self.ready and self.active is None:
                # An acknowledged empty operation crosses the child boundary;
                # no completed request payload remains in either idle frame.
                await self._submit(session_id, "flush", None, True)
        if restart and not self.closed:
            await self.start()

    async def close(self):
        self.closed = True
        graceful = self.ready and self.active is None
        for work in (self.active, self.pending_asr, self.pending_tts): self._fail(work, "cancelled")
        if self.runner:
            self.runner.cancel()
            await asyncio.gather(self.runner, return_exceptions=True)
        for work in (self.active, self.pending_asr, self.pending_tts): self._fail(work, "cancelled")
        self.active = self.pending_asr = self.pending_tts = None
        await self._stop_child(graceful=graceful)
