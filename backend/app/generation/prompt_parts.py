"""Recover the editable user request from a compiled preset without changing it."""
from typing import Any

from . import presets


def split_prompt(prompt: str, settings: dict[str, Any]) -> dict[str, str]:
    marker = "__NODECANVAS_USER_REQUEST_SLOT__"
    preset = settings.get("preset")
    if preset == "result_edit":
        rendered = presets.render_edit(marker)
    elif preset in presets.TEMPLATES:
        rendered = presets.render(preset, marker, str(settings.get("asset_selection") or ""))
    else:
        return {"prefix": "", "user_prompt": prompt, "suffix": ""}
    prefix, template_suffix = rendered.split(marker, 1)
    if not prompt.startswith(prefix):
        return {"prefix": "", "user_prompt": prompt, "suffix": ""}
    boundary = template_suffix or "\n\nADDITIONAL INPUTS\n"
    end = prompt.find(boundary, len(prefix))
    if end < 0:
        if template_suffix:
            return {"prefix": "", "user_prompt": prompt, "suffix": ""}
        end = len(prompt)
    return {"prefix": prefix, "user_prompt": prompt[len(prefix):end], "suffix": prompt[end:]}
