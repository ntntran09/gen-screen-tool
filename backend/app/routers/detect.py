"""Find the separate assets in an image with a small chat model (text answer only, no image generation)."""

from __future__ import annotations

import sqlite3
import time
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

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
        found, model = await detect_assets(provider, data, settings.vision_models, body.hint)
    except ProviderError as exc:
        status = {"AUTH_REQUIRED": 409, "AUTH_EXPIRED": 409, "RATE_LIMITED": 429, "QUOTA_EXCEEDED": 429}.get(exc.code, 502)
        raise ApiError(status, exc.code, exc.message) from None
    return {
        "asset_id": asset_id,
        "model": model,
        "elapsed_seconds": round(time.monotonic() - started, 1),
        "assets": detection_dicts(found),
    }
