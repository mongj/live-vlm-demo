from __future__ import annotations

import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

from pydantic import BaseModel

from .adapters.base import Adapter
from .adapters.gemini import GeminiAdapter
from .adapters.joyai import JoyAIAdapter
from .adapters.mock import MockAdapter
from .types import ModelSpec

MODEL_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_MODEL_ID_LEN = 64
KNOWN_ROW_KEYS = frozenset({"id", "adapter", "label", "base_url"})

ADAPTER_REGISTRY: dict[str, type[Adapter[Any]]] = {
    "gemini": GeminiAdapter,
    "joyai": JoyAIAdapter,
    "mock": MockAdapter,
}


class CatalogError(Exception):
    pass


@dataclass(frozen=True)
class Catalog:
    specs: tuple[ModelSpec, ...]
    registry: dict[str, type[Adapter[Any]]]

    @property
    def by_id(self) -> dict[str, ModelSpec]:
        return {spec.id: spec for spec in self.specs}

    def get(self, model_id: str) -> ModelSpec | None:
        return self.by_id.get(model_id)

    def config_model(self, adapter_key: str) -> type[BaseModel]:
        try:
            return self.registry[adapter_key].config_model
        except KeyError as exc:
            raise CatalogError(f"Unknown adapter: {adapter_key}") from exc

    def build_adapter(self, spec: ModelSpec, raw_config: dict[str, Any]) -> Adapter[Any]:
        try:
            adapter_cls = self.registry[spec.adapter]
        except KeyError as exc:
            raise CatalogError(f"Unknown adapter: {spec.adapter}") from exc
        return adapter_cls(spec, raw_config)

    def entry(self, spec: ModelSpec) -> dict[str, Any]:
        return {
            "id": spec.id,
            "label": spec.label,
            "config_schema": self.config_model(spec.adapter).model_json_schema(),
        }


def normalize_joyai_base_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise CatalogError(f"JoyAI base_url must be an HTTP(S) URL: {url}")
    path = parsed.path.rstrip("/")
    if path != "/v1":
        raise CatalogError(f"JoyAI base_url must end in /v1: {url}")
    return urlunparse((parsed.scheme, parsed.netloc, "/v1", "", "", ""))


def _validate_model_id(model_id: str) -> None:
    if len(model_id) > MAX_MODEL_ID_LEN or not MODEL_ID_RE.fullmatch(model_id):
        raise CatalogError(
            "Model id must be kebab-case and at most 64 characters: "
            f"{model_id!r}"
        )


def _parse_row(row: Mapping[str, Any], seen_ids: set[str]) -> ModelSpec:
    if not isinstance(row, dict):
        raise CatalogError("Each [[models]] row must be a table")
    unknown = set(row) - KNOWN_ROW_KEYS
    if unknown:
        unknown_keys = ", ".join(sorted(unknown))
        raise CatalogError(f"Unknown model field(s): {unknown_keys}")
    try:
        model_id = row["id"]
        adapter = row["adapter"]
        label = row["label"]
    except KeyError as exc:
        raise CatalogError(f"Model row missing required field {exc.args[0]}") from exc
    if not isinstance(model_id, str) or not isinstance(adapter, str) or not isinstance(label, str):
        raise CatalogError("Model id, adapter, and label must be strings")
    _validate_model_id(model_id)
    if model_id in seen_ids:
        raise CatalogError(f"Duplicate model id: {model_id}")
    if adapter not in ADAPTER_REGISTRY:
        raise CatalogError(f"Unknown adapter: {adapter}")
    raw_base_url = row.get("base_url")
    base_url: str | None
    if adapter == "joyai":
        if not isinstance(raw_base_url, str) or not raw_base_url:
            raise CatalogError("JoyAI models require base_url")
        base_url = normalize_joyai_base_url(raw_base_url)
    else:
        if raw_base_url is not None:
            raise CatalogError(f"Adapter {adapter} does not take base_url")
        base_url = None
    return ModelSpec(id=model_id, adapter=adapter, label=label, base_url=base_url)


def load_catalog(
    path: Path,
    registry: dict[str, type[Adapter[Any]]] | None = None,
) -> Catalog:
    resolved = Path(path)
    try:
        raw = resolved.read_bytes()
    except FileNotFoundError as exc:
        raise CatalogError(f"Config file not found: {resolved}") from exc
    except OSError as exc:
        raise CatalogError(f"Could not read config file: {resolved}") from exc
    try:
        data = tomllib.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise CatalogError(f"Malformed TOML in {resolved}: {exc}") from exc
    rows = data.get("models", [])
    if not isinstance(rows, list):
        raise CatalogError("config [[models]] must be an array of tables")
    seen: set[str] = set()
    specs: list[ModelSpec] = []
    for row in rows:
        if not isinstance(row, dict):
            raise CatalogError("Each [[models]] row must be a table")
        spec = _parse_row(row, seen)
        seen.add(spec.id)
        specs.append(spec)
    return Catalog(specs=tuple(specs), registry=registry or ADAPTER_REGISTRY)
