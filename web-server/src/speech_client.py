"""Private optional CPU speech client. Never forward its token to the browser."""
import base64
import os
from pathlib import Path
import stat
from urllib.parse import urlsplit

import httpx
from .input_events import SpeechCapabilities


class SpeechUnavailable(Exception):
    pass


class SpeechClient:
    def __init__(self, base_url: str, token_file: Path):
        url = urlsplit(base_url)
        self.origin = ("https" if url.scheme == "wss" else "http") + "://" + url.netloc
        path = Path(token_file)
        try:
            if not path.is_absolute() or path.resolve() != path: raise ValueError()
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "r") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077: raise ValueError()
                token = handle.read(130).strip()
            if not 32 <= len(token) <= 128 or any(not 33 <= ord(c) <= 126 for c in token): raise ValueError()
        except (OSError, ValueError, UnicodeError):
            raise SpeechUnavailable("unavailable") from None
        self.headers = {"Authorization":"Bearer " + token}
        self.http = httpx.AsyncClient(base_url=self.origin, headers=self.headers, timeout=35,
                                     follow_redirects=False, trust_env=False)

    async def _request(self, method: str, path: str, data=None, timeout=35) -> tuple[bytes, httpx.Headers]:
        try:
            async with self.http.stream(method, "/speech/v1/" + path, json=data, timeout=timeout) as response:
                if response.status_code != 200:
                    raise SpeechUnavailable("busy" if response.status_code == 409 else "unavailable")
                body = bytearray()
                async for part in response.aiter_bytes():
                    body.extend(part)
                    if len(body) > 960000: raise SpeechUnavailable("invalid")
                return bytes(body), response.headers
        except httpx.HTTPError:
            raise SpeechUnavailable("unavailable") from None

    async def capabilities(self) -> SpeechCapabilities:
        import json
        body, _ = await self._request("GET", "capabilities", timeout=.5)
        try:
            data = json.loads(body)
            if data.get("version") != 1 or type(data.get("typed_input")) is not bool or type(data.get("transcription")) is not bool:
                raise ValueError()
            return {"version":1, "typed_input":data["typed_input"], "transcription":data["transcription"]}
        except (ValueError, AttributeError): raise SpeechUnavailable("unavailable") from None

    async def open_session(self, session_id: str) -> None:
        await self._request("POST", "sessions", {"session_id":session_id}, timeout=.5)

    async def synthesize(self, session_id: str, request_id: str, text: str) -> bytes:
        body, headers = await self._request("POST", "tts", {"session_id":session_id, "request_id":request_id, "text":text})
        if headers.get("x-pcm-format") != "s16le;rate=16000;channels=1" or not body or len(body) % 2:
            raise SpeechUnavailable("invalid")
        return body

    async def transcribe(self, session_id: str, input_id: str, revision: int, pcm: bytes, final: bool) -> str:
        import json
        body, _ = await self._request("POST", "asr", {"session_id":session_id, "input_id":input_id,
            "revision":revision, "final":final, "pcm":base64.b64encode(pcm).decode()})
        try:
            text = json.loads(body)["text"]
            if not isinstance(text, str) or len(text) > 4000: raise ValueError()
            return text
        except (ValueError, KeyError, TypeError): raise SpeechUnavailable("invalid") from None

    async def cancel_session(self, session_id: str) -> None:
        await self._request("DELETE", "sessions/" + session_id, timeout=2)

    async def close(self) -> None:
        await self.http.aclose()
