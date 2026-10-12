"""Asset endpoints (spec §24.4)."""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from .. import assets as svc
from ..config import Settings
from ..deps import get_conn, get_settings
from ..errors import ApiError

router = APIRouter(tags=["assets"])

Conn = Annotated[sqlite3.Connection, Depends(get_conn)]
Cfg = Annotated[Settings, Depends(get_settings)]

READ_CHUNK = 1024 * 1024


def _raise(exc: svc.AssetError) -> None:
    raise ApiError(exc.status, exc.code, exc.message) from None


def _require_project(conn: sqlite3.Connection, project_id: str) -> None:
    if conn.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone() is None:
        raise ApiError(404, "NOT_FOUND", "Project not found.")


async def _read_limited(upload: UploadFile, limit: int) -> bytes:
    """Read at most limit+1 bytes so oversized uploads are rejected without buffering them whole."""
    chunks: list[bytes] = []
    total = 0
    while chunk := await upload.read(READ_CHUNK):
        total += len(chunk)
        if total > limit:
            raise svc.AssetError("INVALID_INPUT", f"The file is larger than {limit // (1024 * 1024)} MB.", status=413)
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/api/assets/import")
async def import_assets(
    conn: Conn,
    settings: Cfg,
    project_id: Annotated[str, Form()],
    files: Annotated[list[UploadFile], File()],
) -> dict[str, Any]:
    _require_project(conn, project_id)
    if len(files) > settings.max_import_files:
        raise ApiError(413, "INVALID_INPUT", f"Import at most {settings.max_import_files} files at a time.")

    imported: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for index, upload in enumerate(files):
        try:
            data = await _read_limited(upload, settings.max_import_bytes)
            # Decoding and thumbnailing are CPU-bound; keep them off the event loop.
            asset = await run_in_threadpool(svc.import_image, conn, settings, project_id, upload.filename, data)
            imported.append(asset | {"index": index})
        except svc.AssetError as exc:
            errors.append({"index": index, "filename": upload.filename, "code": exc.code, "message": exc.message})
        finally:
            await upload.close()
    return {"imported": imported, "errors": errors}


@router.get("/api/projects/{project_id}/assets")
def list_project_assets(project_id: str, conn: Conn, settings: Cfg) -> list[dict[str, Any]]:
    _require_project(conn, project_id)
    return svc.list_assets(conn, settings, project_id)


@router.get("/api/assets/{asset_id}")
def get_asset(asset_id: str, conn: Conn, settings: Cfg) -> dict[str, Any]:
    try:
        return svc.get_asset(conn, settings, asset_id)
    except svc.AssetError as exc:
        _raise(exc)
        raise  # unreachable; keeps type checkers happy


def _file_response(conn: sqlite3.Connection, settings: Settings, asset_id: str, *, thumbnail: bool, download: bool) -> FileResponse:
    try:
        row = svc.get_asset_row(conn, asset_id)
        path = svc.asset_file(settings, row, thumbnail=thumbnail)
    except svc.AssetError as exc:
        _raise(exc)
        raise
    return FileResponse(
        path,
        media_type="image/webp" if thumbnail else row["mime_type"],
        filename=None if thumbnail else (row["display_name"] or row["original_filename"]),
        content_disposition_type="attachment" if download else "inline",
        # Asset files never change in place (replace creates a new asset), so they can be cached hard.
        headers={"Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/api/assets/{asset_id}/thumbnail")
def get_thumbnail(asset_id: str, conn: Conn, settings: Cfg) -> FileResponse:
    return _file_response(conn, settings, asset_id, thumbnail=True, download=False)


@router.get("/api/assets/{asset_id}/file")
def get_file(asset_id: str, conn: Conn, settings: Cfg) -> FileResponse:
    return _file_response(conn, settings, asset_id, thumbnail=False, download=False)


@router.get("/api/assets/{asset_id}/download")
def download(asset_id: str, conn: Conn, settings: Cfg) -> FileResponse:
    return _file_response(conn, settings, asset_id, thumbnail=False, download=True)


class AssetDelete(BaseModel):
    asset_ids: list[str] = Field(min_length=1, max_length=1000)


@router.post("/api/projects/{project_id}/assets/delete")
def delete_assets(project_id: str, body: AssetDelete, conn: Conn, settings: Cfg) -> dict[str, Any]:
    _require_project(conn, project_id)
    try:
        return {"deleted": svc.delete_assets(conn, settings, project_id, body.asset_ids)}
    except svc.AssetError as exc:
        _raise(exc)
        raise


@router.get("/api/assets/{asset_id}/palette")
def asset_palette(asset_id: str, conn: Conn, settings: Cfg, count: int = 5) -> dict[str, Any]:
    """Dominant colours of an image (used by the Color Palette node's "Extract from image")."""
    try:
        return {"colors": svc.extract_palette(conn, settings, asset_id, count)}
    except svc.AssetError as exc:
        _raise(exc)
        raise


class AssetPatch(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@router.patch("/api/assets/{asset_id}")
def patch_asset(asset_id: str, body: AssetPatch, conn: Conn, settings: Cfg) -> dict[str, Any]:
    try:
        return svc.rename_asset(conn, settings, asset_id, body.name)
    except svc.AssetError as exc:
        _raise(exc)
        raise
