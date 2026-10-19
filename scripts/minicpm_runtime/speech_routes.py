"""Authenticated, bounded proxy to the allocation's private CPU helper."""
import hmac
import os
from pathlib import Path
import stat
import hashlib


def speech_socket(root, job_id):
    # Per-allocation name prevents a previous job's leftover socket blocking restart.
    suffix = hashlib.sha256(job_id.encode()).hexdigest()[:12]
    return Path(root) / "tmp" / f"speech-{suffix}.sock"


def load_token(path):
    path = Path(path)
    try:
        if not path.is_absolute() or path.resolve() != path: raise ValueError()
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "r") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077: raise ValueError()
            value = file.read(130).strip()
        if not 32 <= len(value) <= 128 or any(not 33 <= ord(c) <= 126 for c in value): raise ValueError()
        return value
    except (OSError, ValueError, UnicodeError):
        raise ValueError("Speech token requires an owned private regular file") from None


def install(app, *, socket_path, token_file):
    import httpx
    from fastapi import Request
    from fastapi.responses import JSONResponse, Response
    token = load_token(token_file)

    async def proxy(request: Request):
        if not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + token):
            return JSONResponse({"error":"unauthorized"}, status_code=401)
        if request.headers.get("content-encoding", "identity") != "identity":
            return JSONResponse({"error":"invalid"}, status_code=400)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 700000:
                return JSONResponse({"error":"too_long"}, status_code=413)
        try:
            transport = httpx.AsyncHTTPTransport(uds=str(socket_path), retries=0)
            async with httpx.AsyncClient(transport=transport, base_url="http://speech", timeout=35, follow_redirects=False, trust_env=False) as client:
                async with client.stream(request.method, request.url.path, content=bytes(body), headers={"Content-Type":"application/json"}) as result:
                    output = bytearray()
                    async for chunk in result.aiter_bytes():
                        output.extend(chunk)
                        if len(output) > 960000: raise ValueError()
                    headers = {"Cache-Control":"no-store"}
                    for name in ("content-type", "x-pcm-format"):
                        if name in result.headers: headers[name] = result.headers[name]
                    return Response(bytes(output), status_code=result.status_code, headers=headers)
        except (httpx.HTTPError, ValueError):
            return JSONResponse({"error":"unavailable"}, status_code=503)

    for path, methods in (("/speech/v1/capabilities", ["GET"]), ("/speech/v1/sessions", ["POST"]),
                          ("/speech/v1/asr", ["POST"]), ("/speech/v1/tts", ["POST"]),
                          ("/speech/v1/sessions/{session_id}", ["DELETE"])):
        app.add_api_route(path, proxy, methods=methods, include_in_schema=False)
