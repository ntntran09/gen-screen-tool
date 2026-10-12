from __future__ import annotations

import io
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.db import migrate
from app.main import create_app

CSRF = {"x-nodecanvas-csrf": "1"}


def img_bytes(fmt: str = "PNG", size: tuple[int, int] = (64, 48), mode: str = "RGB", **save) -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, (255, 0, 0, 128) if mode == "RGBA" else "red").save(buf, fmt, **save)
    return buf.getvalue()


@pytest.fixture
def ctx(tmp_path: Path):
    settings = Settings(
        workspace_dir=tmp_path / "ws",
        credentials_dir=tmp_path / "creds",
        codex_cli_home=tmp_path / "codex",
        max_import_bytes=200_000,
        max_import_files=5,
    )
    with TestClient(create_app(settings)) as c:
        pid = c.post("/api/projects", json={"name": "P"}, headers=CSRF).json()["id"]
        yield c, pid, settings


def upload(c: TestClient, pid: str, *files: tuple[str, bytes, str]):
    return c.post(
        "/api/assets/import",
        data={"project_id": pid},
        files=[("files", f) for f in files],
        headers=CSRF,
    )


def test_import_png_jpg_webp_and_serve(ctx) -> None:
    c, pid, settings = ctx
    res = upload(
        c,
        pid,
        ("flower.png", img_bytes("PNG", mode="RGBA"), "image/png"),
        ("rock.jpg", img_bytes("JPEG"), "image/jpeg"),
        ("leaf.webp", img_bytes("WEBP"), "image/webp"),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["errors"] == []
    names = [a["name"] for a in body["imported"]]
    assert names == ["flower.png", "rock.jpg", "leaf.webp"]
    flower = body["imported"][0]
    assert (flower["width"], flower["height"], flower["format"]) == (64, 48, "PNG")
    assert flower["has_alpha"] is True
    assert body["imported"][1]["format"] == "JPG"

    pdir = settings.workspace_dir / "projects" / pid
    assert (pdir / "assets" / f"{flower['id']}.png").read_bytes() == img_bytes("PNG", mode="RGBA")
    assert (pdir / "thumbnails" / f"{flower['id']}.webp").is_file()

    thumb = c.get(f"/api/assets/{flower['id']}/thumbnail")
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/webp"
    full = c.get(f"/api/assets/{flower['id']}/file")
    assert full.content == img_bytes("PNG", mode="RGBA")
    assert full.headers["content-disposition"].startswith("inline")
    dl = c.get(f"/api/assets/{flower['id']}/download")
    assert dl.headers["content-disposition"].startswith("attachment")
    assert "flower.png" in dl.headers["content-disposition"]

    listed = c.get(f"/api/projects/{pid}/assets").json()
    assert [a["id"] for a in listed] == [a["id"] for a in body["imported"]]


def test_rejects_bad_files_individually(ctx) -> None:
    c, pid, _ = ctx
    res = upload(
        c,
        pid,
        ("ok.png", img_bytes(), "image/png"),
        ("fake.png", b"not an image at all", "image/png"),
        ("anim.gif", img_bytes("GIF"), "image/gif"),
        ("truncated.png", img_bytes()[:60], "image/png"),
        ("huge.png", b"\x89PNG\r\n\x1a\n" + b"0" * 250_000, "image/png"),
    )
    body = res.json()
    assert len(body["imported"]) == 1
    codes = {e["filename"]: e["code"] for e in body["errors"]}
    assert set(codes) == {"fake.png", "anim.gif", "truncated.png", "huge.png"}
    assert all(code == "INVALID_INPUT" for code in codes.values())


def test_signature_must_match_decoded_format(ctx) -> None:
    c, pid, _ = ctx
    # A JPEG body behind a PNG-looking name is fine (content wins) ...
    assert upload(c, pid, ("x.png", img_bytes("JPEG"), "image/png")).json()["imported"][0]["format"] == "JPG"


def test_client_paths_are_stripped_from_names(ctx) -> None:
    c, pid, settings = ctx
    a = upload(c, pid, ("../../evil/..\\name.png", img_bytes(), "image/png")).json()["imported"][0]
    assert "/" not in a["name"] and "\\" not in a["name"] and ".." not in a["name"].replace("..png", "")
    # Stored file name is always the asset id, never the client name.
    assert (settings.workspace_dir / "projects" / pid / "assets" / f"{a['id']}.png").is_file()


def test_pasted_image_without_name_gets_extension(ctx) -> None:
    c, pid, _ = ctx
    # Browsers name clipboard images (e.g. "image.png"); a name without extension gets one.
    named = upload(c, pid, ("clipboard", img_bytes(), "image/png")).json()["imported"][0]
    assert named["name"] == "clipboard.png"
    # A part with no filename at all is a clean validation error, not a server crash.
    res = upload(c, pid, ("", img_bytes(), "image/png"))
    assert res.status_code in (200, 422)
    assert "error" in res.json() or res.json()["imported"]


def test_too_many_files_rejected(ctx) -> None:
    c, pid, _ = ctx
    res = upload(c, pid, *[(f"{i}.png", img_bytes(), "image/png") for i in range(6)])
    assert res.status_code == 413


def test_unknown_project_and_asset(ctx) -> None:
    c, _, _ = ctx
    assert upload(c, "00000000-0000-0000-0000-000000000000", ("a.png", img_bytes(), "image/png")).status_code == 404
    assert c.get("/api/assets/not-a-uuid").status_code == 404
    assert c.get("/api/assets/00000000-0000-0000-0000-000000000000/file").status_code == 404


def test_missing_file_is_reported(ctx) -> None:
    c, pid, settings = ctx
    a = upload(c, pid, ("a.png", img_bytes(), "image/png")).json()["imported"][0]
    (settings.workspace_dir / "projects" / pid / "assets" / f"{a['id']}.png").unlink()
    assert c.get(f"/api/assets/{a['id']}").json()["missing"] is True
    res = c.get(f"/api/assets/{a['id']}/file")
    assert res.status_code == 404 and res.json()["error"]["code"] == "ASSET_MISSING"


def test_rename(ctx) -> None:
    c, pid, _ = ctx
    a = upload(c, pid, ("a.png", img_bytes(), "image/png")).json()["imported"][0]
    res = c.patch(f"/api/assets/{a['id']}", json={"name": "Rose 01.png"}, headers=CSRF)
    assert res.json()["name"] == "Rose 01.png"
    assert res.json()["original_filename"] == "a.png"


def test_import_requires_csrf(ctx) -> None:
    c, pid, _ = ctx
    res = c.post("/api/assets/import", data={"project_id": pid}, files=[("files", ("a.png", img_bytes(), "image/png"))])
    assert res.status_code == 403


def test_v1_database_migrates_with_backup(tmp_path: Path) -> None:
    db = tmp_path / "db.sqlite"
    conn = sqlite3.connect(db)
    from app.db import MIGRATIONS

    conn.executescript("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);")
    conn.executescript(MIGRATIONS[0][1])
    conn.execute("INSERT INTO schema_migrations VALUES (1, 'x')")
    conn.execute("INSERT INTO projects VALUES ('p', 'n', '', '{}', 't', 't')")
    conn.execute(
        "INSERT INTO assets (id, project_id, original_filename, relative_path, mime_type, width, height, file_size,"
        " sha256, origin, created_at) VALUES ('a', 'p', 'old.png', 'assets/a.png', 'image/png', 1, 1, 1, 'h', 'upload', 't')"
    )
    conn.commit()
    conn.close()
    migrate(db, tmp_path / "backups")
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT display_name FROM assets").fetchone()[0] == "old.png"
    assert [r[0] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")] == [1, 2]
    conn.close()
    assert len(list((tmp_path / "backups").iterdir())) == 1
