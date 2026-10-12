"""Image asset import and storage (spec §6, §22).

Uploaded bytes are stored unchanged under projects/{project_id}/assets/{asset_id}.{ext};
only the thumbnail is derived. Paths are always built server-side from validated ids.
"""

from __future__ import annotations

import hashlib
import io
import sqlite3
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from .config import Settings
from .db import now_iso, transaction

THUMB_MAX = 512
# Decompression-bomb guard: 64 MP is far above any game asset we expect.
MAX_PIXELS = 64_000_000

FORMATS = {
    # Pillow format -> (mime, extension)
    "PNG": ("image/png", "png"),
    "JPEG": ("image/jpeg", "jpg"),
    "WEBP": ("image/webp", "webp"),
}


class AssetError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass
class DecodedImage:
    mime: str
    ext: str
    width: int
    height: int
    has_alpha: bool
    thumbnail: bytes


def _signature_format(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if data.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


def decode_image(data: bytes) -> DecodedImage:
    """Validate signature, decode fully, and build a thumbnail. Raises AssetError."""
    sig = _signature_format(data)
    if sig is None:
        raise AssetError("INVALID_INPUT", "Not a PNG, JPG or WebP image.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as probe:
                if probe.format != sig:
                    raise AssetError("INVALID_INPUT", "File contents do not match its image format.")
                if probe.width * probe.height > MAX_PIXELS:
                    raise AssetError("INVALID_INPUT", "Image is too large (over 64 megapixels).")
                if getattr(probe, "n_frames", 1) > 1:
                    raise AssetError("INVALID_INPUT", "Animated images are not supported.")
                probe.load()
                img = ImageOps.exif_transpose(probe)
                width, height = img.size
                has_alpha = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
                thumb = img.convert("RGBA" if has_alpha else "RGB")
                thumb.thumbnail((THUMB_MAX, THUMB_MAX), Image.Resampling.LANCZOS)
                buf = io.BytesIO()
                thumb.save(buf, "WEBP", quality=85, method=4)
    except AssetError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise AssetError("INVALID_INPUT", "Image is too large to decode safely.") from None
    except Exception:  # noqa: BLE001 - any decoder failure means the file is unusable
        raise AssetError("INVALID_INPUT", "The image could not be decoded.") from None
    mime, ext = FORMATS[sig]
    return DecodedImage(mime, ext, width, height, has_alpha, buf.getvalue())


def project_dir(settings: Settings, project_id: str) -> Path:
    return settings.workspace_dir / "projects" / str(uuid.UUID(project_id))


def sanitize_display_name(name: str | None) -> str:
    base = Path(name or "").name.strip()  # drop any client-supplied directories
    base = "".join(ch for ch in base if ch.isprintable() and ch not in '<>:"/\\|?*')
    return base[:200] or "image"


def import_image(
    conn: sqlite3.Connection,
    settings: Settings,
    project_id: str,
    filename: str | None,
    data: bytes,
    origin: str = "upload",
) -> dict[str, Any]:
    # The extension is only advisory (pasted images have none); the signature check and a
    # full decode are what decide whether a file is accepted.
    if len(data) == 0:
        raise AssetError("INVALID_INPUT", "The file is empty.")
    if len(data) > settings.max_import_bytes:
        mb = settings.max_import_bytes // (1024 * 1024)
        raise AssetError("INVALID_INPUT", f"The file is larger than {mb} MB.", status=413)

    decoded = decode_image(data)
    asset_id = str(uuid.uuid4())
    pdir = project_dir(settings, project_id)
    rel_file = f"assets/{asset_id}.{decoded.ext}"
    rel_thumb = f"thumbnails/{asset_id}.webp"
    file_path = pdir / rel_file
    thumb_path = pdir / rel_thumb
    file_path.parent.mkdir(parents=True, exist_ok=True)
    thumb_path.parent.mkdir(parents=True, exist_ok=True)

    # Write files before the DB row so a stored asset never points at a missing file (spec §21.2).
    try:
        file_path.write_bytes(data)
        thumb_path.write_bytes(decoded.thumbnail)
    except OSError:
        file_path.unlink(missing_ok=True)
        thumb_path.unlink(missing_ok=True)
        raise AssetError("STORAGE_ERROR", "Could not write the image to the workspace.", status=500) from None

    display = sanitize_display_name(filename)
    if not Path(display).suffix:
        display = f"{display}.{decoded.ext}"
    try:
        with transaction(conn):
            conn.execute(
                "INSERT INTO assets (id, project_id, original_filename, display_name, relative_path, thumbnail_path,"
                " mime_type, width, height, file_size, sha256, origin, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    asset_id,
                    project_id,
                    display,
                    display,
                    rel_file,
                    rel_thumb,
                    decoded.mime,
                    decoded.width,
                    decoded.height,
                    len(data),
                    hashlib.sha256(data).hexdigest(),
                    origin,
                    now_iso(),
                ),
            )
    except sqlite3.Error:
        file_path.unlink(missing_ok=True)
        thumb_path.unlink(missing_ok=True)
        raise
    return get_asset(conn, settings, asset_id) | {"has_alpha": decoded.has_alpha}


def _row_to_dict(row: sqlite3.Row, settings: Settings) -> dict[str, Any]:
    pdir = project_dir(settings, row["project_id"])
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "name": row["display_name"] or row["original_filename"],
        "original_filename": row["original_filename"],
        "mime_type": row["mime_type"],
        "format": row["mime_type"].split("/")[-1].upper().replace("JPEG", "JPG"),
        "width": row["width"],
        "height": row["height"],
        "file_size": row["file_size"],
        "sha256": row["sha256"],
        "origin": row["origin"],
        "created_at": row["created_at"],
        "missing": not (pdir / row["relative_path"]).is_file(),
    }


def get_asset_row(conn: sqlite3.Connection, asset_id: str) -> sqlite3.Row:
    try:
        uuid.UUID(asset_id)
    except ValueError:
        raise AssetError("NOT_FOUND", "Asset not found.", status=404) from None
    row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    if row is None:
        raise AssetError("NOT_FOUND", "Asset not found.", status=404)
    return row


def get_asset(conn: sqlite3.Connection, settings: Settings, asset_id: str) -> dict[str, Any]:
    return _row_to_dict(get_asset_row(conn, asset_id), settings)


def list_assets(conn: sqlite3.Connection, settings: Settings, project_id: str) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at, rowid", (project_id,))
    return [_row_to_dict(r, settings) for r in rows]


def asset_file(settings: Settings, row: sqlite3.Row, *, thumbnail: bool = False) -> Path:
    rel = row["thumbnail_path"] if thumbnail else row["relative_path"]
    pdir = project_dir(settings, row["project_id"]).resolve()
    path = (pdir / rel).resolve() if rel else None
    if path is None or not path.is_relative_to(pdir) or not path.is_file():
        raise AssetError("ASSET_MISSING", "The image file is missing from the workspace.", status=404)
    return path


def rename_asset(conn: sqlite3.Connection, settings: Settings, asset_id: str, name: str) -> dict[str, Any]:
    get_asset_row(conn, asset_id)
    with transaction(conn):
        conn.execute("UPDATE assets SET display_name = ? WHERE id = ?", (sanitize_display_name(name), asset_id))
    return get_asset(conn, settings, asset_id)
