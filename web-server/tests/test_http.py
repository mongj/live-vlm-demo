from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from live_vlm_server.adapters.joyai import JoyAIAdapter, JoyAIConfig
from live_vlm_server.adapters.mock import MockAdapter, MockConfig
from live_vlm_server.main import create_app, resolve_runtime_settings

SHIPPED = Path(__file__).resolve().parents[1] / "config.toml"


def test_health_and_catalog_payload_shape() -> None:
    with TestClient(create_app(SHIPPED)) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json() == {"ok": True}
        listing = client.get("/v1/models")
        assert listing.status_code == 200
        body = listing.json()
        assert list(body) == ["models"]
        ids = [entry["id"] for entry in body["models"]]
        assert ids == ["joyai-vl", "mock"]
        for entry in body["models"]:
            assert set(entry) == {"id", "label", "config_schema"}
        mock = client.get("/v1/models/mock")
        assert mock.status_code == 200
        assert mock.json()["id"] == "mock"
        assert mock.json()["label"] == "Mock"
        assert mock.json()["config_schema"] == MockConfig.model_json_schema()
        joyai = client.get("/v1/models/joyai-vl")
        assert joyai.status_code == 200
        assert joyai.json()["config_schema"] == JoyAIConfig.model_json_schema()
        missing = client.get("/v1/models/nope")
        assert missing.status_code == 404


def test_discovery_does_not_construct_adapters(monkeypatch: pytest.MonkeyPatch) -> None:
    constructed: list[str] = []
    mock_init = MockAdapter.__init__
    joyai_init = JoyAIAdapter.__init__

    def tracking_mock(self: MockAdapter, spec: object, raw_config: object) -> None:
        constructed.append("mock")
        mock_init(self, spec, raw_config)

    def tracking_joyai(self: JoyAIAdapter, spec: object, raw_config: object, **kwargs: object) -> None:
        constructed.append("joyai")
        joyai_init(self, spec, raw_config, **kwargs)

    monkeypatch.setattr(MockAdapter, "__init__", tracking_mock)
    monkeypatch.setattr(JoyAIAdapter, "__init__", tracking_joyai)
    with TestClient(create_app(SHIPPED)) as client:
        client.get("/health")
        client.get("/v1/models")
        client.get("/v1/models/mock")
        client.get("/v1/models/joyai-vl")
    assert constructed == []


def test_discovery_performs_no_network_io(monkeypatch: pytest.MonkeyPatch) -> None:
    def blocked(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("Catalog HTTP routes must not use the network")

    monkeypatch.setattr("socket.socket.connect", blocked)
    with TestClient(create_app(SHIPPED)) as client:
        assert client.get("/v1/models").status_code == 200
        assert client.get("/v1/models/mock").status_code == 200


def test_runtime_bind_defaults_overrides_and_invalid_ports() -> None:
    host, port, config_path = resolve_runtime_settings({})
    assert host == "127.0.0.1"
    assert port == 8787
    assert config_path == Path("./config.toml")
    host, port, config_path = resolve_runtime_settings(
        {
            "LIVE_VLM_HOST": "0.0.0.0",
            "LIVE_VLM_PORT": "9001",
            "LIVE_VLM_CONFIG": "/tmp/custom.toml",
        }
    )
    assert host == "0.0.0.0"
    assert port == 9001
    assert config_path == Path("/tmp/custom.toml")
    with pytest.raises(ValueError, match="1 through 65535"):
        resolve_runtime_settings({"LIVE_VLM_PORT": "abc"})
    with pytest.raises(ValueError, match="1 through 65535"):
        resolve_runtime_settings({"LIVE_VLM_PORT": "0"})
    with pytest.raises(ValueError, match="1 through 65535"):
        resolve_runtime_settings({"LIVE_VLM_PORT": "65536"})
