"""Provider discovery and the Phase 0 live test (spec §24.2)."""

from __future__ import annotations

import base64
import io
import time
import uuid
from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from PIL import Image
from pydantic import BaseModel, Field

from ..config import Settings
from ..deps import get_settings
from ..errors import ApiError
from ..providers import ProviderError
from ..providers.base import GenerateRequest
from .auth import Registry

router = APIRouter(prefix="/api/providers", tags=["providers"])

Cfg = Annotated[Settings, Depends(get_settings)]


@router.get("")
async def providers(registry: Registry) -> list[dict[str, Any]]:
    return [
        {
            "id": p.id,
            "name": p.name,
            "experimental": p.experimental,
            "may_consume_quota": p.may_consume_quota,
            "auth_state": await p.check_auth(),
        }
        for p in registry.list()
    ]


@router.get("/{provider_id}/capabilities")
def capabilities(provider_id: str, registry: Registry) -> dict[str, Any]:
    provider = registry.get(provider_id)
    if provider is None:
        raise ApiError(404, "NOT_FOUND", "Unknown provider.")
    return asdict(provider.get_capabilities())


class TestBody(BaseModel):
    # Explicit opt-in: the test makes a real generation request against the user's account.
    confirm_quota_use: bool = False
    prompt: str = Field(
        default="A single cute red potion bottle game icon, centered, plain white background, no text.",
        min_length=1,
        max_length=2000,
    )
    aspect_ratio: str = "1:1"


@router.post("/{provider_id}/test")
async def test_provider(provider_id: str, body: TestBody, registry: Registry, settings: Cfg) -> dict[str, Any]:
    provider = registry.get(provider_id)
    if provider is None:
        raise ApiError(404, "NOT_FOUND", "Unknown provider.")
    if provider.may_consume_quota and not body.confirm_quota_use:
        raise ApiError(400, "CONFIRMATION_REQUIRED", "This test generates a real image and uses your account quota.")

    started = time.monotonic()
    requested = {"aspect_ratio": body.aspect_ratio}
    try:
        result = await provider.generate(GenerateRequest(prompt=body.prompt, settings=requested))
    except ProviderError as exc:
        raise ApiError(502, exc.code, exc.message) from None

    try:
        with Image.open(io.BytesIO(result.image_bytes)) as img:
            img.load()
            width, height = img.size
            has_alpha = img.mode in ("RGBA", "LA") or "transparency" in img.info
    except Exception:  # noqa: BLE001
        raise ApiError(502, "EMPTY_RESULT", "The returned file could not be decoded as an image.") from None

    ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[result.mime_type]
    out_dir = settings.workspace_dir / "provider-tests"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{provider_id}-{uuid.uuid4()}.{ext}"
    path.write_bytes(result.image_bytes)

    return {
        "ok": True,
        "elapsed_seconds": round(time.monotonic() - started, 1),
        "requested": requested,
        "reported_model": result.reported_model,
        "reported_settings": result.reported_settings,
        "actual": {"width": width, "height": height, "mime_type": result.mime_type, "has_alpha": has_alpha,
                   "bytes": len(result.image_bytes)},
        "saved_as": path.name,
        "preview": f"data:{result.mime_type};base64,{base64.b64encode(result.image_bytes).decode()}",
    }
