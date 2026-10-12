"""Find the separate assets in an image with a small chat model.

The model only answers in text (a JSON list of names, descriptions and rough boxes). The boxes say where
an asset is; they are not used to cut pixels out, because they are approximate.
"""

from __future__ import annotations

import io
import json
import re
from dataclasses import asdict, dataclass
from typing import Any

from PIL import Image, ImageOps

from .providers import ProviderError
from .providers.base import ImageProvider

MAX_ASSETS = 60
MAX_SIDE = 1568  # larger images are shrunk before they are sent; boxes are relative so this is safe
# Models answer boxes more reliably on a fixed 0..1000 grid than in pixels of an unknown resize.
GRID = 1000

INSTRUCTIONS = (
    "You are a precise visual inspector for a game art pipeline. You answer with JSON only: no prose, no "
    "markdown fences."
)

PROMPT = """Look at this image (a game screen, mockup or sprite sheet). Find every separate visual asset a game artist
would cut out on its own: characters, creatures, objects, props, items, icons, buttons, counters and other UI elements.
Do NOT list the whole background or a surface that other things sit on, and do not list plain text.

Rules:
- Count carefully. If the same kind of object appears several times, list EACH one separately with its own box.
- Boxes must be tight around the asset and use a {grid}x{grid} grid over the whole image: [x1, y1, x2, y2] with
  (0, 0) the top-left corner and ({grid}, {grid}) the bottom-right corner.
- Give each asset a short, specific name (for example "blue hydrangea pot", "pause button"), plus one short description.
- An asset that is part of a bigger one (a flower in a pot) is listed only if it is a useful asset on its own.
{hint}
Answer ONLY with JSON of this exact shape:
{{"assets": [{{"name": "...", "description": "...", "box": [x1, y1, x2, y2]}}]}}"""


@dataclass
class Detection:
    name: str
    description: str
    # Relative to the image, 0..1.
    x: float
    y: float
    w: float
    h: float


def _json_block(text: str) -> Any:
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.S)
    if fence:
        text = fence.group(1)
    try:
        return json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise


def parse_detections(text: str) -> list[Detection]:
    """Turn the model's answer into clean boxes. Anything malformed is dropped, never guessed."""
    try:
        data = _json_block(text)
    except ValueError:
        raise ProviderError("EMPTY_RESULT", "The model's answer was not valid JSON. Try again.") from None
    items = data.get("assets") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise ProviderError("EMPTY_RESULT", "The model's answer had no asset list. Try again.")
    found: list[Detection] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        box = item.get("box")
        if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
            continue
        x1, y1, x2, y2 = (min(max(float(v), 0.0), GRID) / GRID for v in box)
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1
        if (x2 - x1) < 0.01 or (y2 - y1) < 0.01:  # too small to be a real asset
            continue
        # Braces would read as prompt placeholders ({asset_name}) later, so they never survive.
        clean = lambda v, n: re.sub(r"\s+", " ", re.sub(r"[{}]", "", str(v or ""))).strip()[:n]  # noqa: E731
        name = clean(item.get("name"), 80) or f"asset {len(found) + 1}"
        found.append(Detection(name, clean(item.get("description"), 200), x1, y1, x2 - x1, y2 - y1))
        if len(found) >= MAX_ASSETS:
            break
    return found


def shrink_for_model(data: bytes) -> bytes:
    """Keep the upload small: long sides above MAX_SIDE are scaled down (PNG, keeps transparency)."""
    with Image.open(io.BytesIO(data)) as img:
        img = ImageOps.exif_transpose(img)
        if max(img.size) <= MAX_SIDE:
            return data
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()


async def detect_assets(
    provider: ImageProvider, image: bytes, models: tuple[str, ...], hint: str = ""
) -> tuple[list[Detection], str | None]:
    """Ask the first model the account accepts. Returns the detections and the model that answered."""
    prompt = PROMPT.format(grid=GRID, hint=(f"- Extra guidance from the user: {hint.strip()[:300]}\n" if hint.strip() else ""))
    small = shrink_for_model(image)
    last: ProviderError | None = None
    for model in models:
        try:
            result = await provider.analyze_image(small, prompt, instructions=INSTRUCTIONS, model=model)
        except ProviderError as exc:
            last = exc
            # Only a rejected/unknown model is worth trying the next one for; anything else would repeat.
            if exc.code in ("INVALID_INPUT", "PROVIDER_UNAVAILABLE", "PERMISSION_DENIED"):
                continue
            raise
        return parse_detections(result.text), result.reported_model or model
    raise last or ProviderError("PROVIDER_UNAVAILABLE", "No vision model is available.")


def detection_dicts(items: list[Detection]) -> list[dict[str, Any]]:
    return [asdict(d) for d in items]
