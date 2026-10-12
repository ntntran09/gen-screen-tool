"""Provider adapter interface (spec §19.4, §19.6, §20.4).

Capabilities are tri-state: a capability that has not been verified against the real
provider is reported as "unknown", never assumed to be supported.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

Tristate = Literal["supported", "unsupported", "unknown"]

ErrorCode = Literal[
    "AUTH_REQUIRED",
    "AUTH_EXPIRED",
    "PERMISSION_DENIED",
    "PROVIDER_UNAVAILABLE",
    "RATE_LIMITED",
    "QUOTA_EXCEEDED",
    "INVALID_INPUT",
    "REFERENCE_LIMIT_EXCEEDED",
    "UNSUPPORTED_CAPABILITY",
    "NETWORK_ERROR",
    "GENERATION_TIMEOUT",
    "EMPTY_RESULT",
    "STORAGE_ERROR",
    "UNKNOWN_ERROR",
]

AuthState = Literal[
    "not_connected", "connecting", "connected", "expired", "permission_error", "provider_unavailable"
]


class ProviderError(Exception):
    def __init__(self, code: ErrorCode, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class Capabilities:
    text_to_image: Tristate = "unknown"
    image_editing: Tristate = "unknown"
    max_reference_images: int | None = None  # None = unknown
    aspect_ratios: list[str] | None = None
    output_formats: list[str] | None = None
    background_options: list[str] | None = None
    native_batch: Tristate = "unknown"
    cancellation: Tristate = "unknown"
    verified: bool = False


@dataclass
class GenerateRequest:
    prompt: str
    original_image: bytes | None = None
    reference_images: list[bytes] = field(default_factory=list)
    settings: dict[str, Any] = field(default_factory=dict)


@dataclass
class GenerateResult:
    image_bytes: bytes
    mime_type: str
    reported_model: str | None = None
    reported_settings: dict[str, Any] = field(default_factory=dict)


class ImageProvider(ABC):
    id: str
    name: str
    experimental: bool = False
    may_consume_quota: bool = True

    @abstractmethod
    async def authenticate(self) -> AuthState: ...

    @abstractmethod
    async def check_auth(self) -> AuthState: ...

    @abstractmethod
    def get_capabilities(self) -> Capabilities: ...

    @abstractmethod
    async def generate(self, request: GenerateRequest) -> GenerateResult: ...

    @abstractmethod
    async def edit(self, request: GenerateRequest) -> GenerateResult: ...

    @abstractmethod
    def normalize_result(self, raw: Any) -> GenerateResult: ...

    @abstractmethod
    def normalize_error(self, exc: BaseException) -> ProviderError: ...
