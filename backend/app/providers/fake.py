"""Local placeholder provider for development and UI testing — never calls a network service.

Registered only when NODECANVAS_FAKE_PROVIDER=1. It draws a flat image so the whole
generation pipeline (queue, storage, canvas output) can be exercised without using quota.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
from typing import Any

from PIL import Image, ImageDraw

from .base import AnalysisResult, AuthState, Capabilities, GenerateRequest, GenerateResult, ImageProvider, ProviderError

SIZES = {"1:1": (512, 512), "3:4": (384, 512), "9:16": (288, 512), "4:3": (512, 384), "16:9": (512, 288)}


class FakeProvider(ImageProvider):
    id = "fake"
    name = "Local placeholder (testing)"
    experimental = True
    may_consume_quota = False

    def __init__(self, delay_seconds: float = 1.0) -> None:
        self.delay = delay_seconds

    async def authenticate(self) -> AuthState:
        return "connected"

    async def check_auth(self) -> AuthState:
        return "connected"

    def get_capabilities(self) -> Capabilities:
        return Capabilities(text_to_image="supported", image_editing="supported", cancellation="unsupported", verified=True)

    async def _draw(self, request: GenerateRequest) -> GenerateResult:
        await asyncio.sleep(self.delay)
        if "[fail]" in request.prompt:  # lets a tester produce failed tasks on purpose
            raise ProviderError("EMPTY_RESULT", "Placeholder provider was asked to fail.")
        digest = hashlib.sha256(request.prompt.encode() + (request.original_image or b"")).digest()
        size = SIZES.get(str(request.settings.get("aspect_ratio")), (512, 512))
        img = Image.new("RGB", size, tuple(80 + b % 160 for b in digest[:3]))
        draw = ImageDraw.Draw(img)
        w, h = size
        draw.ellipse((w * 0.25, h * 0.25, w * 0.75, h * 0.75), fill=tuple(255 - b % 120 for b in digest[3:6]), outline="black", width=6)
        draw.text((12, 12), request.prompt.splitlines()[0][:48], fill="black")
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return GenerateResult(image_bytes=buf.getvalue(), mime_type="image/png", reported_model="placeholder")

    async def analyze_image(self, image: bytes, prompt: str, *, instructions: str, model: str) -> AnalysisResult:
        """A fixed 2x2 "detection" so the whole Find-assets flow can be tried without quota."""
        await asyncio.sleep(self.delay / 2)
        boxes = [
            {"name": f"asset {i + 1}", "description": "placeholder", "box": [x, y, x + 450, y + 450]}
            for i, (x, y) in enumerate([(30, 30), (520, 30), (30, 520), (520, 520)])
        ]
        return AnalysisResult(text=json.dumps({"assets": boxes}), reported_model="placeholder")

    async def generate(self, request: GenerateRequest) -> GenerateResult:
        return await self._draw(request)

    async def edit(self, request: GenerateRequest) -> GenerateResult:
        return await self._draw(request)

    def normalize_result(self, raw: Any) -> GenerateResult:
        return raw

    def normalize_error(self, exc: BaseException) -> ProviderError:
        return exc if isinstance(exc, ProviderError) else ProviderError("UNKNOWN_ERROR", "Placeholder provider error.")
