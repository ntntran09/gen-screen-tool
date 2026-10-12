"""Provider authentication (spec §19.1, §24.1). Tokens never appear in responses."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ..errors import ApiError
from ..providers import ProviderError, ProviderRegistry
from ..providers.codex import CodexProvider

router = APIRouter(prefix="/api/auth", tags=["auth"])


def get_registry(request: Request) -> ProviderRegistry:
    return request.app.state.providers


Registry = Annotated[ProviderRegistry, Depends(get_registry)]


def _codex(registry: ProviderRegistry, provider_id: str) -> CodexProvider:
    provider = registry.get(provider_id)
    if not isinstance(provider, CodexProvider):
        raise ApiError(404, "NOT_FOUND", "Unknown provider or provider has no OAuth login.")
    return provider


class ConnectBody(BaseModel):
    provider_id: str = "codex"
    method: Literal["device_code", "import_codex_cli"] = "device_code"


class ProviderBody(BaseModel):
    provider_id: str = "codex"


@router.get("/status")
def status(registry: Registry, provider_id: str = "codex") -> dict[str, Any]:
    return _codex(registry, provider_id).auth.status()


@router.post("/connect")
async def connect(body: ConnectBody, registry: Registry) -> dict[str, Any]:
    auth = _codex(registry, body.provider_id).auth
    try:
        if body.method == "import_codex_cli":
            auth.import_codex_cli()
        else:
            await auth.start_device_login()
    except ProviderError as exc:
        raise ApiError(400 if exc.code == "AUTH_REQUIRED" else 502, exc.code, exc.message) from None
    return auth.status()


@router.post("/cancel")
def cancel(body: ProviderBody, registry: Registry) -> dict[str, Any]:
    auth = _codex(registry, body.provider_id).auth
    auth.cancel_login()
    return auth.status()


@router.post("/disconnect")
def disconnect(body: ProviderBody, registry: Registry) -> dict[str, Any]:
    auth = _codex(registry, body.provider_id).auth
    auth.disconnect()
    return auth.status()
