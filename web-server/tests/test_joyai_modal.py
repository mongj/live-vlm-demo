from __future__ import annotations

import httpx
import pytest

from live_vlm_server.adapters.joyai_modal import JoyAIModalAdapter
from live_vlm_server.types import ModelSpec, SessionError

SPEC = ModelSpec(
    id="joyai-vl-modal",
    adapter="joyai-modal",
    label="JoyAI (Modal)",
    base_url="https://example--live-vlm-joyai-joyai.modal.run/v1",
)


class ScriptedTransport(httpx.AsyncBaseTransport):
    def __init__(self, status: int) -> None:
        self.status = status
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json={"ok": True})


@pytest.fixture
def token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JOYAI_MODAL_TOKEN_ID", "wk-id")
    monkeypatch.setenv("JOYAI_MODAL_TOKEN_SECRET", "ws-secret")
    monkeypatch.delenv("JOYAI_SPEECH_BASE_URL", raising=False)


async def test_requests_carry_proxy_token(token: None) -> None:
    transport = ScriptedTransport(200)
    adapter = JoyAIModalAdapter(SPEC, {}, http_transport=transport)
    await adapter.open()
    await adapter.close()
    assert [request.url.path for request in transport.requests] == [
        "/v1/streaming/reset",
        "/v1/streaming/reset",
    ]
    for request in transport.requests:
        assert request.headers["Modal-Key"] == "wk-id"
        assert request.headers["Modal-Secret"] == "ws-secret"


async def test_missing_token_is_fatal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JOYAI_MODAL_TOKEN_ID", raising=False)
    monkeypatch.setenv("JOYAI_MODAL_TOKEN_SECRET", "ws-secret")
    transport = ScriptedTransport(200)
    adapter = JoyAIModalAdapter(SPEC, {}, http_transport=transport)
    with pytest.raises(SessionError) as excinfo:
        await adapter.open()
    assert excinfo.value.fatal
    assert "JOYAI_MODAL_TOKEN_ID" in excinfo.value.message
    assert transport.requests == []


async def test_cold_start_503_explains_retry(token: None) -> None:
    transport = ScriptedTransport(503)
    adapter = JoyAIModalAdapter(SPEC, {}, http_transport=transport)
    with pytest.raises(SessionError) as excinfo:
        await adapter.open()
    assert excinfo.value.fatal
    assert "cold start" in excinfo.value.message
    await adapter.close()
