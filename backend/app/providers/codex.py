"""ChatGPT / Codex OAuth image provider — EXPERIMENTAL.

Auth: device-code OAuth (see codex_auth.py). Generation calls the ChatGPT backend's Codex
image endpoints, which are undocumented. Request/response shapes follow community tools
and must be confirmed by the Phase 0 test before anything is marked as supported.
"""

from __future__ import annotations

import base64
from typing import Any

import httpx

from .base import AuthState, Capabilities, GenerateRequest, GenerateResult, ImageProvider, ProviderError
from .codex_auth import CodexAuth

BASE_URL = "https://chatgpt.com/backend-api/codex"
GENERATIONS_URL = f"{BASE_URL}/images/generations"
EDITS_URL = f"{BASE_URL}/images/edits"
DEFAULT_MODEL = "gpt-image-2"
ORIGINATOR = "nodecanvas-ai"
USER_AGENT = "NodeCanvasAI/0.1"
TIMEOUT = httpx.Timeout(connect=15.0, read=300.0, write=60.0, pool=15.0)

# gpt-image style sizes; the backend may still return something else (spec §19.7).
SIZE_FOR_ASPECT = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "9:16": "1024x1536",
    "4:3": "1536x1024",
    "16:9": "1536x1024",
}

_MIME_BY_MAGIC = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"RIFF", "image/webp"),
]


def sniff_mime(data: bytes) -> str | None:
    for magic, mime in _MIME_BY_MAGIC:
        if data.startswith(magic):
            if mime == "image/webp" and data[8:12] != b"WEBP":
                continue
            return mime
    return None


class CodexProvider(ImageProvider):
    id = "codex"
    name = "ChatGPT / Codex (OAuth)"
    experimental = True
    may_consume_quota = True

    def __init__(self, auth: CodexAuth, client_factory: Any = None) -> None:
        self.auth = auth
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=TIMEOUT))
        self.verified: dict[str, bool] = {}

    async def authenticate(self) -> AuthState:
        await self.auth.start_device_login()
        return self.auth.state()

    async def check_auth(self) -> AuthState:
        return self.auth.state()

    def get_capabilities(self) -> Capabilities:
        def tri(key: str) -> Any:
            return "supported" if self.verified.get(key) else "unknown"

        return Capabilities(
            text_to_image=tri("text_to_image"),
            image_editing=tri("image_editing"),
            max_reference_images=None,
            aspect_ratios=None,
            output_formats=None,
            background_options=None,
            native_batch="unknown",
            cancellation="unsupported",
            verified=bool(self.verified),
        )

    async def _headers(self) -> dict[str, str]:
        token, info = await self.auth.access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "originator": ORIGINATOR,
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        }
        if info.get("account_id"):
            headers["ChatGPT-Account-ID"] = info["account_id"]
        if info.get("residency"):
            headers["x-openai-internal-codex-residency"] = str(info["residency"]).strip()
        return headers

    def _body(self, request: GenerateRequest) -> dict[str, Any]:
        s = request.settings
        body: dict[str, Any] = {
            "model": s.get("model") or DEFAULT_MODEL,
            "prompt": request.prompt,
            "size": SIZE_FOR_ASPECT.get(s.get("aspect_ratio", "1:1"), "1024x1024"),
        }
        if s.get("quality") and s["quality"] != "auto":
            body["quality"] = s["quality"]
        return body

    async def _post(self, url: str, body: dict[str, Any]) -> dict[str, Any]:
        headers = await self._headers()
        try:
            async with self._client_factory() as client:
                res = await client.post(url, json=body, headers=headers)
                if res.status_code == 401:
                    # Token may have been revoked early: refresh once and retry.
                    headers = await self._headers_after_refresh()
                    res = await client.post(url, json=body, headers=headers)
        except httpx.TimeoutException:
            raise ProviderError("GENERATION_TIMEOUT", "The image request timed out. Its result is unknown.") from None
        except httpx.TransportError:
            raise ProviderError("NETWORK_ERROR", "Network error while contacting ChatGPT. Result unknown.") from None
        if res.status_code != 200:
            raise self._http_error(res)
        try:
            return res.json()
        except ValueError:
            raise ProviderError("UNKNOWN_ERROR", "ChatGPT returned a non-JSON response.") from None

    async def _headers_after_refresh(self) -> dict[str, str]:
        await self.auth.access_token(force_refresh=True)
        return await self._headers()

    async def generate(self, request: GenerateRequest) -> GenerateResult:
        raw = await self._post(GENERATIONS_URL, self._body(request))
        result = self.normalize_result(raw)
        self.verified["text_to_image"] = True
        return result

    async def edit(self, request: GenerateRequest) -> GenerateResult:
        images = ([request.original_image] if request.original_image else []) + request.reference_images
        if not images:
            raise ProviderError("INVALID_INPUT", "Image editing needs at least one input image.")
        body = self._body(request)
        body["images"] = [
            {"image_url": f"data:{sniff_mime(img) or 'image/png'};base64,{base64.b64encode(img).decode()}"}
            for img in images
        ]
        result = self.normalize_result(await self._post(EDITS_URL, body))
        self.verified["image_editing"] = True
        return result

    def normalize_result(self, raw: Any) -> GenerateResult:
        items = raw.get("data") if isinstance(raw, dict) else None
        if not items or not isinstance(items, list) or not items[0].get("b64_json"):
            raise ProviderError("EMPTY_RESULT", "ChatGPT returned no image.")
        try:
            data = base64.b64decode(items[0]["b64_json"], validate=True)
        except ValueError:
            raise ProviderError("EMPTY_RESULT", "ChatGPT returned an unreadable image.") from None
        mime = sniff_mime(data)
        if mime is None:
            raise ProviderError("EMPTY_RESULT", "ChatGPT returned data that is not a supported image.")
        reported = {k: raw.get(k) for k in ("size", "quality", "background", "output_format") if raw.get(k)}
        return GenerateResult(image_bytes=data, mime_type=mime, reported_model=raw.get("model"), reported_settings=reported)

    def _http_error(self, res: httpx.Response) -> ProviderError:
        status = res.status_code
        detail = ""
        try:
            err = res.json().get("error") or res.json().get("detail")
            detail = err.get("message", "") if isinstance(err, dict) else str(err or "")
        except ValueError:
            pass
        detail = detail[:300]
        if status == 401:
            return ProviderError("AUTH_EXPIRED", "ChatGPT session is no longer valid. Connect again.")
        if status == 403:
            return ProviderError("PERMISSION_DENIED", f"This ChatGPT account cannot use image generation here. {detail}".strip())
        if status == 404:
            return ProviderError("PROVIDER_UNAVAILABLE", "The Codex image endpoint was not found. It may have changed.")
        if status == 429:
            quota = "quota" in detail.lower() or "limit" in detail.lower()
            return ProviderError("QUOTA_EXCEEDED" if quota else "RATE_LIMITED", detail or "Usage limit reached. Try later.")
        if status == 400:
            return ProviderError("INVALID_INPUT", detail or "ChatGPT rejected the request.")
        return ProviderError("PROVIDER_UNAVAILABLE", f"ChatGPT image service error (HTTP {status}). {detail}".strip())

    def normalize_error(self, exc: BaseException) -> ProviderError:
        if isinstance(exc, ProviderError):
            return exc
        return ProviderError("UNKNOWN_ERROR", "Unexpected provider error.")
