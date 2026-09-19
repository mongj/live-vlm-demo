from __future__ import annotations

import ast
from pathlib import Path

from live_vlm_server.types import Reply, SessionError, make_session_id

SRC = Path(__file__).resolve().parents[1] / "src"
CORE_FORBIDDEN = frozenset({"adapters", "catalog", "channel", "session", "main"})
ADAPTER_FORBIDDEN = frozenset({"catalog", "channel", "session", "main", "protocol"})


def _imported_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module.split(".")[0])
    return found


def test_session_id_is_kebab_catalog_prefix_plus_hex() -> None:
    session_id = make_session_id("joyai-vl")
    assert session_id.startswith("joyai-vl-")
    token = session_id.removeprefix("joyai-vl-")
    assert len(token) == 32
    assert token == token.lower()
    assert all(character in "0123456789abcdef" for character in token)
    assert make_session_id("mock") != make_session_id("mock")


def test_reply_defaults_and_session_error_flags() -> None:
    reply = Reply()
    assert reply.text == ""
    assert reply.audio is None
    assert reply.raw == ""
    assert reply.final is False
    assert reply.interrupted is False
    assert reply.t is None
    recoverable = SessionError("nope", fatal=False)
    fatal = SessionError("boom")
    assert recoverable.fatal is False
    assert recoverable.message == "nope"
    assert fatal.fatal is True


def test_core_modules_have_no_application_imports() -> None:
    for name in ("types.py", "buffers.py", "codecs.py", "protocol.py"):
        assert _imported_roots(SRC / name) & CORE_FORBIDDEN == set(), name


def test_adapters_do_not_import_session_catalog_or_channel() -> None:
    for name in (
        "adapters/base.py",
        "adapters/mock.py",
        "adapters/joyai.py",
        "adapters/gemini.py",
    ):
        assert _imported_roots(SRC / name) & ADAPTER_FORBIDDEN == set(), name
