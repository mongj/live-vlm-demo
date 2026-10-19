"""Private Unix-socket speech service; no uploads, audio files or content logs."""
import argparse
import asyncio
import base64
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import re
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from speech_broker import SpeechBroker
from speech_engines import SpeechFailure, validate_pcm, validate_text

ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_BODY = 700000


class BodyLimit:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http": return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect": return
            body.extend(message.get("body", b""))
            if len(body) > MAX_BODY:
                return await JSONResponse({"error":"too_long"}, status_code=413)(scope, receive, send)
            if not message.get("more_body"): break
        delivered = False
        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type":"http.request", "body":bytes(body), "more_body":False}
            return await receive()
        await self.app(scope, bounded_receive, send)


def create_app(broker):
    session = None
    deadline = 0
    closing = False
    seen = set()

    async def expire():
        nonlocal session, closing
        while True:
            await asyncio.sleep(1)
            if session is not None and time.monotonic() >= deadline and not closing:
                closing = True
                try: await broker.cancel_session(session)
                finally:
                    session = None
                    seen.clear()
                    closing = False

    @asynccontextmanager
    async def lifespan(app):
        await broker.start()
        expiry = asyncio.create_task(expire())
        try: yield
        finally:
            expiry.cancel()
            await asyncio.gather(expiry, return_exceptions=True)
            await broker.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BodyLimit)

    @app.get("/speech/v1/capabilities")
    async def capabilities():
        return {"version":1, "transcription":broker.ready, "typed_input":broker.ready}

    async def payload(request, keys):
        try:
            data = await request.json()
            if not isinstance(data, dict) or set(data) != set(keys): raise ValueError()
            for key in ("session_id", "input_id", "request_id"):
                if key in data and (not isinstance(data[key], str) or not ID.fullmatch(data[key])): raise ValueError()
            return data
        except (ValueError, TypeError): raise SpeechFailure("invalid") from None

    @app.exception_handler(SpeechFailure)
    async def failure(request, error):
        code = str(error)
        return JSONResponse({"error":code}, status_code=409 if code in {"busy","cancelled"} else 503 if code in {"timeout","unavailable"} else 400)

    def require_session(sid):
        if sid != session or closing or time.monotonic() >= deadline:
            raise SpeechFailure("busy")

    @app.post("/speech/v1/sessions")
    async def register(request: Request):
        nonlocal session, deadline
        data = await payload(request, {"session_id"})
        if session is not None or closing or not broker.ready: raise SpeechFailure("busy")
        session, deadline = data["session_id"], time.monotonic() + 330
        return {"ok":True}

    @app.delete("/speech/v1/sessions/{session_id}")
    async def cancel(session_id: str):
        nonlocal session, closing
        require_session(session_id)
        closing = True
        try: await broker.cancel_session(session_id)
        finally:
            session = None
            seen.clear()
            closing = False
        return {"ok":True}

    @app.post("/speech/v1/tts")
    async def tts(request: Request):
        data = await payload(request, {"session_id", "request_id", "text"})
        require_session(data["session_id"])
        validate_text(data["text"])
        if data["request_id"] in seen or len(seen) >= 128: raise SpeechFailure("busy")
        seen.add(data["request_id"])
        pcm = await broker.synthesize(data["session_id"], data["request_id"], data["text"])
        require_session(data["session_id"])
        validate_pcm(pcm, 30)
        return Response(pcm, media_type="application/octet-stream", headers={"X-PCM-Format":"s16le;rate=16000;channels=1", "Cache-Control":"no-store"})

    @app.post("/speech/v1/asr")
    async def asr(request: Request):
        data = await payload(request, {"session_id", "input_id", "revision", "final", "pcm"})
        require_session(data["session_id"])
        if type(data["revision"]) is not int or data["revision"] < 0 or type(data["final"]) is not bool: raise SpeechFailure("invalid")
        try: pcm = base64.b64decode(data["pcm"], validate=True)
        except (ValueError, TypeError): raise SpeechFailure("invalid") from None
        validate_pcm(pcm, 15)
        text = await broker.transcribe(data["session_id"], data["input_id"], data["revision"], pcm, data["final"])
        require_session(data["session_id"])
        return JSONResponse({"text":text}, headers={"Cache-Control":"no-store"})

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True)
    parser.add_argument("--socket", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    socket = Path(args.socket)
    if socket.exists() or not socket.parent.is_dir(): raise SystemExit("Speech socket path is unavailable")
    import uvicorn
    uvicorn.run(create_app(SpeechBroker(args.assets)), uds=str(socket), access_log=False, log_level="critical")


if __name__ == "__main__": main()
