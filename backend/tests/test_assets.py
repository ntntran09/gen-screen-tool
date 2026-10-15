from __future__ import annotations

import io
import sqlite3
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.db import MIGRATIONS, migrate
from app.main import create_app
from app.assets import AssetError, boost_saturation, convert_generated_image

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


def test_selected_download_zip_and_project_isolation(ctx) -> None:
    c, pid, _ = ctx
    raw = img_bytes()
    assets = upload(c, pid, ("same.png", raw, "image/png"), ("same.png", raw, "image/png")).json()["imported"]
    url = f"/api/projects/{pid}/assets/download"
    response = c.get(url, params=[("ids", assets[0]["id"]), ("ids", assets[1]["id"]), ("ids", assets[0]["id"])])
    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["001_same.png", "002_same.png"]
        assert all(archive.read(name) == raw for name in archive.namelist())
    other = c.post("/api/projects", json={"name": "Other"}, headers=CSRF).json()["id"]
    assert c.get(f"/api/projects/{other}/assets/download", params={"ids": assets[0]["id"]}).status_code == 404
    assert c.get(url).status_code == 422
    assert c.get(url, params={"ids": [assets[0]["id"]] * 201}).status_code == 422


@pytest.mark.parametrize("fmt", ["png", "webp", "jpg"])
def test_generated_conversion_handles_alpha(fmt) -> None:
    data = convert_generated_image(img_bytes(mode="RGBA"), fmt)
    with Image.open(io.BytesIO(data)) as image:
        if fmt == "jpg":
            assert image.mode == "RGB"
            r, g, b = image.getpixel((0, 0))
            assert r > 250 and 120 <= g <= 135 and 120 <= b <= 135
        else:
            assert image.convert("RGBA").getpixel((0, 0)) == (255, 0, 0, 128)
    with pytest.raises(AssetError):
        convert_generated_image(b"broken image", fmt)


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
    assert [r[0] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")] == [v for v, _ in MIGRATIONS]
    conn.close()
    assert len(list((tmp_path / "backups").iterdir())) == 1


def test_delete_assets_hides_them_and_moves_files_to_backups(ctx) -> None:
    c, pid, settings = ctx
    body = upload(c, pid, ("a.png", img_bytes(), "image/png"), ("b.png", img_bytes(), "image/png")).json()
    a, b = (x["id"] for x in body["imported"])
    res = c.post(f"/api/projects/{pid}/assets/delete", json={"asset_ids": [a, a]}, headers=CSRF)
    assert res.status_code == 200 and res.json()["deleted"] == [a]

    assert [x["id"] for x in c.get(f"/api/projects/{pid}/assets").json()] == [b]
    info = c.get(f"/api/assets/{a}").json()
    assert info["deleted"] is True and info["missing"] is True
    assert c.get(f"/api/assets/{a}/file").status_code == 404
    trash = settings.workspace_dir / "backups" / "deleted-assets" / pid
    assert (trash / "assets" / f"{a}.png").is_file() and (trash / "thumbnails" / f"{a}.webp").is_file()
    assert not (settings.workspace_dir / "projects" / pid / "assets" / f"{a}.png").exists()
    # Deleting again is a no-op.
    assert c.post(f"/api/projects/{pid}/assets/delete", json={"asset_ids": [a]}, headers=CSRF).json()["deleted"] == []


def test_delete_assets_rejects_other_projects(ctx) -> None:
    c, pid, _ = ctx
    a = upload(c, pid, ("a.png", img_bytes(), "image/png")).json()["imported"][0]["id"]
    other = c.post("/api/projects", json={"name": "Q"}, headers=CSRF).json()["id"]
    res = c.post(f"/api/projects/{other}/assets/delete", json={"asset_ids": [a]}, headers=CSRF)
    assert res.status_code == 404


def test_extract_palette_ignores_transparent_pixels(ctx) -> None:
    c, pid, _ = ctx
    img = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    for x in range(20):
        for y in range(40):
            img.putpixel((x, y), (255, 0, 0, 255))
    for x in range(20, 30):
        for y in range(40):
            img.putpixel((x, y), (0, 0, 255, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    a = upload(c, pid, ("shape.png", buf.getvalue(), "image/png")).json()["imported"][0]["id"]
    res = c.get(f"/api/assets/{a}/palette?count=2")
    assert res.status_code == 200
    colors = res.json()["colors"]
    assert [x["hex"] for x in colors] == [_hex(boost_saturation((255, 0, 0))), _hex(boost_saturation((0, 0, 255)))]  # no black from the transparent area
    assert colors[0]["share"] > colors[1]["share"]
    assert c.get("/api/assets/00000000-0000-0000-0000-000000000000/palette").status_code == 404


def _hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def test_boost_saturation_strengthens_the_colour_a_little_and_keeps_hue_and_lightness() -> None:
    import colorsys

    for c in [(230, 40, 30), (40, 170, 60), (90, 60, 140), (180, 120, 120)]:
        boosted = boost_saturation(c)
        h0, l0, s0 = colorsys.rgb_to_hls(*(v / 255 for v in c))
        h1, l1, s1 = colorsys.rgb_to_hls(*(v / 255 for v in boosted))
        assert s1 > s0 and s1 - s0 < 0.15  # more saturated, but only a little
        assert abs(h1 - h0) < 0.01 and abs(l1 - l0) < 0.01  # same hue and lightness
    for unchanged in [(255, 0, 0), (0, 0, 255), (128, 128, 128), (255, 255, 255), (0, 0, 0)]:
        assert boost_saturation(unchanged) == unchanged  # pure colours and greys have nothing to strengthen


def _near(hex_: str, rgb: tuple[int, int, int], within: int = 40) -> bool:
    got = tuple(int(hex_[k : k + 2], 16) for k in (1, 3, 5))
    return sum((a - b) ** 2 for a, b in zip(got, rgb, strict=True)) ** 0.5 <= within


def test_extract_palette_drops_a_plain_backdrop_and_picks_distinct_colors(ctx) -> None:
    c, pid, _ = ctx
    img = Image.new("RGB", (60, 60), (254, 254, 254))  # opaque white backdrop (not transparent)
    for x in range(10, 30):
        for y in range(10, 50):
            img.putpixel((x, y), (230, 40, 30))  # red, 800 px
    for x in range(30, 50):
        for y in range(10, 50):
            img.putpixel((x, y), (40, 170, 60))  # green, 800 px
    for x in range(34, 40):
        for y in range(20, 26):
            img.putpixel((x, y), (255, 255, 255))  # white detail inside the subject: not backdrop
    buf = io.BytesIO()
    img.save(buf, "PNG")
    a = upload(c, pid, ("dragon.png", buf.getvalue(), "image/png")).json()["imported"][0]["id"]
    colors = c.get(f"/api/assets/{a}/palette?count=5").json()["colors"]
    hexes = [x["hex"] for x in colors]
    # The two real colours lead; the backdrop (about 1/3 of the image) does not appear as a big white swatch.
    assert {_near(h, (230, 40, 30)) for h in hexes[:2]} == {True, False}
    assert {_near(h, (40, 170, 60)) for h in hexes[:2]} == {True, False}
    for h, x in zip(hexes, colors, strict=True):
        if _near(h, (254, 254, 254), 20):
            assert x["share"] <= 5  # only the small white detail inside the subject
    assert len(set(hexes)) == len(hexes)  # no repeated shades
    assert sum(x["share"] for x in colors) in range(98, 103)


def test_extract_palette_keeps_a_flat_image(ctx) -> None:
    c, pid, _ = ctx
    a = upload(c, pid, ("flat.png", img_bytes("PNG", size=(30, 30)), "image/png")).json()["imported"][0]["id"]
    colors = c.get(f"/api/assets/{a}/palette").json()["colors"]
    assert [x["hex"] for x in colors] == [_hex(boost_saturation((255, 0, 0)))] and colors[0]["share"] == 100
