from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from live_vlm_server.main import create_app

SHIPPED = Path(__file__).resolve().parents[1] / "config.toml"


def _seed_library(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "alpha.mp4").write_bytes(b"aaa")
    (root / "beta.mp4").write_bytes(b"bbbb")
    (root / "notes.json").write_text('{"ok": true}\n', encoding="utf-8")
    (root / "subdir").mkdir()
    (root / "subdir" / "nested.mp4").write_bytes(b"nested")


def _client(tmp_path: Path) -> TestClient:
    library = tmp_path / "spot-bench"
    _seed_library(library)
    return TestClient(
        create_app(
            SHIPPED,
            video_roots={
                "spot-bench": library,
                "ego-proactive": tmp_path / "missing-ego",
            },
            thumbnail_cache=tmp_path / "thumbnails",
        )
    )


def test_list_videos_sorted_mp4_only(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        response = client.get("/v1/videos", params={"key": "spot-bench"})
        assert response.status_code == 200
        body = response.json()
        assert list(body) == ["videos"]
        assert body["videos"] == [
            {"name": "alpha.mp4", "size": 3, "key": "spot-bench", "duration_ms": None},
            {"name": "beta.mp4", "size": 4, "key": "spot-bench", "duration_ms": None},
        ]


def test_get_video_bytes(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        response = client.get(
            "/v1/videos/alpha.mp4",
            params={"key": "spot-bench"},
        )
        assert response.status_code == 200
        assert response.content == b"aaa"
        assert response.headers["content-type"].startswith("video/mp4")
        disposition = response.headers.get("content-disposition", "")
        assert "alpha.mp4" in disposition


def test_missing_and_unknown_key(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        missing = client.get("/v1/videos")
        assert missing.status_code == 400
        assert "Missing" in missing.json()["detail"]
        unknown = client.get("/v1/videos", params={"key": "nope"})
        assert unknown.status_code == 400
        assert "Invalid" in unknown.json()["detail"]
        missing_file_key = client.get("/v1/videos/alpha.mp4")
        assert missing_file_key.status_code == 400
        unknown_file_key = client.get(
            "/v1/videos/alpha.mp4",
            params={"key": "nope"},
        )
        assert unknown_file_key.status_code == 400


def test_missing_library_directory_is_404(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        listing = client.get("/v1/videos", params={"key": "ego-proactive"})
        assert listing.status_code == 404
        assert "not available" in listing.json()["detail"]
        download = client.get(
            "/v1/videos/alpha.mp4",
            params={"key": "ego-proactive"},
        )
        assert download.status_code == 404


def test_path_safety_and_non_mp4(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        traversal = client.get(
            "/v1/videos/../secret.mp4",
            params={"key": "spot-bench"},
        )
        assert traversal.status_code == 404
        wrong_suffix = client.get(
            "/v1/videos/notes.json",
            params={"key": "spot-bench"},
        )
        assert wrong_suffix.status_code == 404
        missing = client.get(
            "/v1/videos/missing.mp4",
            params={"key": "spot-bench"},
        )
        assert missing.status_code == 404
        nested = client.get(
            "/v1/videos/subdir/nested.mp4",
            params={"key": "spot-bench"},
        )
        assert nested.status_code == 404
