"""Image asset import and storage (spec §6, §22).

Uploaded bytes are stored unchanged under projects/{project_id}/assets/{asset_id}.{ext};
only the thumbnail is derived. Paths are always built server-side from validated ids.
"""

from __future__ import annotations

import colorsys
import hashlib
import io
import shutil
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


def convert_generated_image(data: bytes, output_format: str) -> bytes:
    """Validate provider bytes before conversion. PNG/WebP keep alpha; JPEG uses white."""
    if output_format not in ("png", "webp", "jpg"):
        raise AssetError("INVALID_INPUT", "Unsupported output format.")
    decoded = decode_image(data)
    if decoded.ext == output_format:
        return data
    try:
        with Image.open(io.BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source).convert("RGBA")
            buffer = io.BytesIO()
            if output_format == "jpg":
                image = Image.alpha_composite(Image.new("RGBA", image.size, "white"), image).convert("RGB")
                image.save(buffer, "JPEG", quality=95, subsampling=0)
            elif output_format == "webp":
                image.save(buffer, "WEBP", lossless=True, exact=True)
            else:
                image.save(buffer, "PNG")
            return buffer.getvalue()
    except (OSError, ValueError) as exc:
        raise AssetError("STORAGE_ERROR", f"Could not convert the returned image: {exc}") from exc


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
        "deleted": row["deleted_at"] is not None,
        "missing": row["deleted_at"] is not None or not (pdir / row["relative_path"]).is_file(),
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


def list_assets(
    conn: sqlite3.Connection, settings: Settings, project_id: str, *, include_deleted: bool = False
) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM assets WHERE project_id = ? AND (? OR deleted_at IS NULL) ORDER BY created_at, rowid",
        (project_id, include_deleted),
    )
    return [_row_to_dict(r, settings) for r in rows]


def asset_file(settings: Settings, row: sqlite3.Row, *, thumbnail: bool = False) -> Path:
    if row["deleted_at"] is not None:
        raise AssetError("ASSET_MISSING", "This image was deleted from the library.", status=404)
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


def delete_assets(conn: sqlite3.Connection, settings: Settings, project_id: str, asset_ids: list[str]) -> list[str]:
    """Hide assets from the library and move their files to backups (recoverable, never erased).

    The rows stay so generation history and old snapshots still resolve; they read as missing.
    """
    ids = []
    for asset_id in dict.fromkeys(asset_ids):
        row = get_asset_row(conn, asset_id)
        if row["project_id"] != project_id:
            raise AssetError("NOT_FOUND", "Asset not found in this project.", status=404)
        if row["deleted_at"] is None:
            ids.append(row)
    with transaction(conn):
        conn.executemany("UPDATE assets SET deleted_at = ? WHERE id = ?", [(now_iso(), r["id"]) for r in ids])
    pdir = project_dir(settings, project_id).resolve()
    trash = settings.workspace_dir / "backups" / "deleted-assets" / str(uuid.UUID(project_id))
    for r in ids:
        for rel in (r["relative_path"], r["thumbnail_path"]):
            src = (pdir / rel).resolve() if rel else None
            if src is None or not src.is_relative_to(pdir) or not src.is_file():
                continue
            dest = trash / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(src, dest)
    return [r["id"] for r in ids]


# Palette extraction tuning (RGB distances are 0..441).
_PALETTE_SIZE = 128  # work on a small copy
_BG_TOLERANCE = 34  # how close to the background colour a pixel must be to count as background
_MIN_DISTINCT = 46  # chosen colours must differ by at least this much
_FINE_COLORS = 32  # quantise finely first, then pick the distinct main colours from those
_PALETTE_SATURATION_BOOST = 0.15  # picked colours get a little more saturated: 15% of the way to full saturation


def _dist(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def _background_mask(rgb: list[tuple[int, int, int]], opaque: list[bool], w: int, h: int) -> list[bool] | None:
    """Pixels of a plain backdrop connected to the image border, or None when there is no such backdrop.

    Generated game assets usually sit on solid white; left in, it would take most of the palette.
    Only the region touching the border is removed, so white parts of the subject itself stay.
    """
    border = [i for i in range(w * h) if opaque[i] and (i % w in (0, w - 1) or i // w in (0, h - 1))]
    if not border:
        return None
    buckets: dict[tuple[int, int, int], list[int]] = {}
    for i in border:
        r, g, b = rgb[i]
        buckets.setdefault((r // 32, g // 32, b // 32), []).append(i)
    members = max(buckets.values(), key=len)
    bg = tuple(sum(rgb[i][c] for i in members) // len(members) for c in range(3))
    near = [i for i in border if _dist(rgb[i], bg) <= _BG_TOLERANCE]  # type: ignore[arg-type]
    if len(near) < 0.9 * len(border):  # a real backdrop is nearly the whole border; a subject touching it is not
        return None
    mask = [False] * (w * h)
    stack = list(near)
    for i in stack:
        mask[i] = True
    while stack:
        i = stack.pop()
        x, y = i % w, i // w
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if not mask[j] and opaque[j] and _dist(rgb[j], bg) <= _BG_TOLERANCE:  # type: ignore[arg-type]
                    mask[j] = True
                    stack.append(j)
    return mask


def boost_saturation(c: tuple[int, int, int], amount: float = _PALETTE_SATURATION_BOOST) -> tuple[int, int, int]:
    """A slightly more saturated version of the colour: same hue and lightness, saturation raised towards full.

    Greys stay grey (they have no hue to strengthen) and fully saturated colours are unchanged.
    """
    h, light, s = colorsys.rgb_to_hls(c[0] / 255, c[1] / 255, c[2] / 255)
    if s < 0.05:  # a grey has no real hue: boosting it would tint it red
        return c
    r, g, b = colorsys.hls_to_rgb(h, light, s + (1 - s) * amount)
    return round(r * 255), round(g * 255), round(b * 255)


def _saturation(c: tuple[int, int, int]) -> float:
    hi, lo = max(c), min(c)
    return 0.0 if hi == 0 else (hi - lo) / hi


def extract_palette(conn: sqlite3.Connection, settings: Settings, asset_id: str, count: int = 5) -> list[dict[str, Any]]:
    """The main, clearly different colours of an image, largest area first.

    Transparent pixels and a plain backdrop touching the border are ignored. Colours are first
    quantised finely, then the palette is picked greedily (area, with a bonus for saturated colours)
    skipping any colour too close to one already chosen, so five picks are five distinct colours
    rather than five shades of the same one. `share` is the area of everything closest to that pick.
    The returned colours are made a little more saturated (`boost_saturation`).
    """
    row = get_asset_row(conn, asset_id)
    path = asset_file(settings, row)
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img).convert("RGBA")
            img.thumbnail((_PALETTE_SIZE, _PALETTE_SIZE), Image.Resampling.LANCZOS)
    except Exception:  # noqa: BLE001
        raise AssetError("INVALID_INPUT", "The image could not be read.") from None
    w, h = img.size
    data = list(img.getdata())
    rgb = [p[:3] for p in data]
    opaque = [p[3] >= 128 for p in data]
    if not any(opaque):
        raise AssetError("INVALID_INPUT", "The image is fully transparent.")
    keep = list(opaque)
    background = _background_mask(rgb, opaque, w, h)
    if background is not None:
        without = [k and not b for k, b in zip(keep, background, strict=True)]
        if sum(without) >= 0.03 * len(keep):  # keep the backdrop if nothing else is left
            keep = without
    pixels = [c for c, k in zip(rgb, keep, strict=True) if k]
    sample = Image.new("RGB", (len(pixels), 1))
    sample.putdata(pixels)
    quant = sample.quantize(colors=_FINE_COLORS, method=Image.Quantize.MEDIANCUT)
    palette = quant.getpalette() or []
    fine = [(n, (palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2])) for n, i in (quant.getcolors() or [])]

    chosen: list[tuple[int, int, int]] = []
    for _, c in sorted(fine, key=lambda t: t[0] * (1 + 1.5 * _saturation(t[1])), reverse=True):
        if len(chosen) >= max(1, min(count, 12)):
            break
        if all(_dist(c, o) >= _MIN_DISTINCT for o in chosen):
            chosen.append(c)

    area = [0] * len(chosen)
    for n, c in fine:
        area[min(range(len(chosen)), key=lambda k: _dist(c, chosen[k]))] += n
    total = sum(area) or 1
    ranked = sorted(zip(area, chosen, strict=True), reverse=True)
    return [{"hex": "#{:02X}{:02X}{:02X}".format(*boost_saturation(c)), "share": round(100 * n / total)} for n, c in ranked]
