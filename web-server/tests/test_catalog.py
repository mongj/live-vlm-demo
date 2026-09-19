from __future__ import annotations

from pathlib import Path

import pytest

from live_vlm_server.adapters.gemini import GeminiConfig
from live_vlm_server.adapters.joyai import JoyAIConfig
from live_vlm_server.adapters.mock import MockConfig
from live_vlm_server.catalog import CatalogError, load_catalog, normalize_joyai_base_url

SHIPPED = Path(__file__).resolve().parents[1] / "config.toml"


def test_shipped_catalog_contains_joyai_gemini_and_mock() -> None:
    catalog = load_catalog(SHIPPED)
    assert [spec.id for spec in catalog.specs] == ["joyai-vl", "gemini-3-8-live", "mock"]
    joyai = catalog.get("joyai-vl")
    gemini = catalog.get("gemini-3-8-live")
    mock = catalog.get("mock")
    assert joyai is not None and joyai.adapter == "joyai"
    assert joyai.base_url == "http://127.0.0.1:8070/v1"
    assert gemini is not None and gemini.adapter == "gemini" and gemini.base_url is None
    assert mock is not None and mock.adapter == "mock" and mock.base_url is None
    assert catalog.entry(mock)["config_schema"] == MockConfig.model_json_schema()
    assert catalog.entry(joyai)["config_schema"] == JoyAIConfig.model_json_schema()
    assert catalog.entry(gemini)["config_schema"] == GeminiConfig.model_json_schema()


def test_missing_and_malformed_config(tmp_path: Path) -> None:
    missing = tmp_path / "nope.toml"
    with pytest.raises(CatalogError, match="not found"):
        load_catalog(missing)
    bad = tmp_path / "bad.toml"
    bad.write_text("[[models]\n", encoding="utf-8")
    with pytest.raises(CatalogError, match="Malformed TOML"):
        load_catalog(bad)


def test_duplicate_and_invalid_ids(tmp_path: Path) -> None:
    duplicate = tmp_path / "dup.toml"
    duplicate.write_text(
        """
[[models]]
id = "mock"
adapter = "mock"
label = "One"

[[models]]
id = "mock"
adapter = "mock"
label = "Two"
""",
        encoding="utf-8",
    )
    with pytest.raises(CatalogError, match="Duplicate"):
        load_catalog(duplicate)
    invalid = tmp_path / "invalid.toml"
    invalid.write_text(
        """
[[models]]
id = "Not_Valid"
adapter = "mock"
label = "Bad"
""",
        encoding="utf-8",
    )
    with pytest.raises(CatalogError, match="kebab-case"):
        load_catalog(invalid)


def test_unknown_adapter_and_joyai_base_url_rules(tmp_path: Path) -> None:
    unknown = tmp_path / "unknown.toml"
    unknown.write_text(
        """
[[models]]
id = "mystery"
adapter = "nope"
label = "Nope"
""",
        encoding="utf-8",
    )
    with pytest.raises(CatalogError, match="Unknown adapter"):
        load_catalog(unknown)
    missing_url = tmp_path / "joyai.toml"
    missing_url.write_text(
        """
[[models]]
id = "joyai-vl"
adapter = "joyai"
label = "JoyAI"
""",
        encoding="utf-8",
    )
    with pytest.raises(CatalogError, match="base_url"):
        load_catalog(missing_url)
    mock_url = tmp_path / "mock-url.toml"
    mock_url.write_text(
        """
[[models]]
id = "mock"
adapter = "mock"
label = "Mock"
base_url = "http://127.0.0.1:9/v1"
""",
        encoding="utf-8",
    )
    with pytest.raises(CatalogError, match="does not take base_url"):
        load_catalog(mock_url)
    gemini_url = tmp_path / "gemini-url.toml"
    gemini_url.write_text(
        """
[[models]]
id = "gemini-3-8-live"
adapter = "gemini"
label = "Gemini 3.8 Live"
base_url = "http://127.0.0.1:9/v1"
""",
        encoding="utf-8",
    )
    with pytest.raises(CatalogError, match="does not take base_url"):
        load_catalog(gemini_url)


def test_joyai_base_url_normalization(tmp_path: Path) -> None:
    assert normalize_joyai_base_url("http://127.0.0.1:8070/v1/") == "http://127.0.0.1:8070/v1"
    config = tmp_path / "config.toml"
    config.write_text(
        """
[[models]]
id = "joyai-vl"
adapter = "joyai"
label = "JoyAI"
base_url = "https://127.0.0.1:8070/v1/"
""",
        encoding="utf-8",
    )
    catalog = load_catalog(config)
    spec = catalog.get("joyai-vl")
    assert spec is not None
    assert spec.base_url == "https://127.0.0.1:8070/v1"
    with pytest.raises(CatalogError, match="HTTP"):
        normalize_joyai_base_url("ftp://127.0.0.1/v1")
    with pytest.raises(CatalogError, match="/v1"):
        normalize_joyai_base_url("http://127.0.0.1:8070/v1/chat")
