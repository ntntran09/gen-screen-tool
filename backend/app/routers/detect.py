"""Find the separate assets in an image with a small chat model (text answer only, no image generation)."""

from __future__ import annotations

import io
import math
import sqlite3
import time
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from PIL import Image, ImageOps
from starlette.concurrency import run_in_threadpool

from .. import assets as svc
from ..analysis import detect_assets, detection_dicts
from ..config import Settings
from ..deps import get_conn, get_settings
from ..errors import ApiError
from ..providers import ProviderError
from .auth import Registry

router = APIRouter(tags=["detect"])

Conn = Annotated[sqlite3.Connection, Depends(get_conn)]
Cfg = Annotated[Settings, Depends(get_settings)]


class DetectBody(BaseModel):
    provider_id: str = "codex"
    hint: str = Field(default="", max_length=300)
    # Empty means the configured default list.
    model: str = Field(default="", max_length=64, pattern=r"^[A-Za-z0-9._:-]*$")
    # Empty picks the model's default: maximum for Luna, light for the larger models.
    effort: str = Field(default="", pattern=r"^(|low|medium|high|xhigh|max)$")


@router.post("/api/assets/{asset_id}/detect")
async def detect(asset_id: str, body: DetectBody, conn: Conn, settings: Cfg, registry: Registry) -> dict[str, Any]:
    """List the separate assets in an image with their boxes. Uses a small ChatGPT model on the account."""
    provider = registry.get(body.provider_id)
    if provider is None:
        raise ApiError(404, "NOT_FOUND", "Unknown provider.")
    if await provider.check_auth() != "connected":
        raise ApiError(409, "AUTH_REQUIRED", f"Connect {provider.name} first.")
    try:
        row = svc.get_asset_row(conn, asset_id)
        data = svc.asset_file(settings, row).read_bytes()
    except svc.AssetError as exc:
        raise ApiError(exc.status, exc.code, exc.message) from None
    started = time.monotonic()
    try:
        found, model = await detect_assets(provider, data, (body.model,) if body.model else settings.vision_models, body.hint, body.effort or None)
    except ProviderError as exc:
        status = {"AUTH_REQUIRED": 409, "AUTH_EXPIRED": 409, "RATE_LIMITED": 429, "QUOTA_EXCEEDED": 429}.get(exc.code, 502)
        raise ApiError(status, exc.code, exc.message) from None
    return {
        "asset_id": asset_id,
        "model": model,
        "elapsed_seconds": round(time.monotonic() - started, 1),
        "assets": detection_dicts(found),
    }


class CropBox(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    x: float = Field(ge=0, lt=1, allow_inf_nan=False)
    y: float = Field(ge=0, lt=1, allow_inf_nan=False)
    w: float = Field(gt=0, le=1, allow_inf_nan=False)
    h: float = Field(gt=0, le=1, allow_inf_nan=False)


class CropBody(BaseModel):
    boxes: list[CropBox] = Field(min_length=1, max_length=60)


def _crop(asset_id: str, body: CropBody, conn: sqlite3.Connection, settings: Settings) -> list[dict[str, Any]]:
    row = svc.get_asset_row(conn, asset_id)
    path = svc.asset_file(settings, row)
    with Image.open(path) as raw:
        image = ImageOps.exif_transpose(raw).convert('RGBA')
        width, height = image.size
        results = []
        for i, box in enumerate(body.boxes, 1):
            # Floor/ceil include every pixel covered by the box; clamp at image edges.
            bounds = (math.floor(box.x * width), math.floor(box.y * height),
                      min(width, math.ceil((box.x + box.w) * width)),
                      min(height, math.ceil((box.y + box.h) * height)))
            crop = image.crop(bounds)
            buf = io.BytesIO()
            crop.save(buf, 'PNG')
            name = svc.sanitize_display_name(box.name.replace('{', '').replace('}', ''))
            results.append(svc.import_image(conn, settings, row['project_id'], f'{name}_{i:02}.png', buf.getvalue(), origin='crop'))
        return results


@router.post('/api/assets/{asset_id}/crop')
async def crop_assets(asset_id: str, body: CropBody, conn: Conn, settings: Cfg) -> dict[str, Any]:
    """Cut selected detection boxes into separate stored PNG assets. No AI call."""
    try:
        return {'assets': await run_in_threadpool(_crop, asset_id, body, conn, settings)}
    except svc.AssetError as exc:
        raise ApiError(exc.status, exc.code, exc.message) from None
