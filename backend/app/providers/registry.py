from __future__ import annotations

from ..config import Settings
from ..credentials import CredentialStore
from .base import ImageProvider
from .codex import CodexProvider
from .codex_auth import CodexAuth


class ProviderRegistry:
    def __init__(self, providers: list[ImageProvider]) -> None:
        self._providers = {p.id: p for p in providers}

    def list(self) -> list[ImageProvider]:
        return list(self._providers.values())

    def get(self, provider_id: str) -> ImageProvider | None:
        return self._providers.get(provider_id)


def build_registry(settings: Settings) -> ProviderRegistry:
    store = CredentialStore(settings.credentials_dir)
    return ProviderRegistry([CodexProvider(CodexAuth(store, codex_cli_home=settings.codex_cli_home))])
