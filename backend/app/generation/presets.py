"""The two prompt presets (the only ones): restyle a whole game screen, or create an asset sheet.

The wording is the user's own template. Two small changes: there is no attached art-direction file in
this app, so the art direction travels inside the user request ("art direction notes"), and the optional
asset selection reads "none" when empty.
"""

from __future__ import annotations

SCREEN = "screen"
ASSETS = "assets"
DEFAULT_PRESET = SCREEN

LABELS = {SCREEN: "Game screen restyle", ASSETS: "Asset sheet"}
# What the Original image is, for the "attached images" notes.
ORIGINAL_NOUN = {SCREEN: "the original game screenshot", ASSETS: "the original game screenshot or asset reference image"}
ASSET_SELECTION_NONE = "none (identify the distinct reusable gameplay assets yourself)"

SCREEN_TEMPLATE = """You are a professional mobile game artist.

INPUTS
- Original game screenshot.
- Art direction notes, if the user request includes any.
- User request: {{USER_PROMPT}}

TASK
Restyle the provided game screenshot according to the user request
and the art direction notes.

PRESERVE GAMEPLAY AND LAYOUT
The original screenshot is the source of truth for:
- Gameplay objects, their functions and quantities.
- Object positions, grouping, grid, shelves, slots and spacing.
- Camera perspective and relative object proportions.
- Gameplay states, obstacles, counters and special indicators.

Maintain a one-to-one correspondence between original and restyled
gameplay elements. Do not add, remove, rearrange or invent mechanics.

PRESERVE EXISTING HUD
Keep all existing gameplay HUD, including level, score, timer,
progress indicators and buttons.
Preserve their positions, text, numbers, values and functions.
Restyle their frames, materials and icons to match the requested style,
while keeping them readable.
Do not invent additional HUD.

Remove only clearly promotional banners, advertising slogans and
advertising decorations. Do not mistake gameplay characters or
interactive elements for advertising.
Leave removed advertising areas visually quiet; do not redistribute
the gameplay layout to fill them.

APPLY THE USER REQUEST
Apply the requested theme or material to existing objects while
preserving their functional identity.

A themed container must remain a container.
Do not turn objects into pets, characters or mascots unless requested.
A material change must not change gameplay states or mechanics.
Change obstacle themes only when the user requests it.

Unspecified details should remain consistent with the original.
Do not expand a short request into an invented story or environment.

THEME THE ASSETS FIRST
The main goal is a clearly re-themed game. Redraw the visual assets
(gameplay objects, containers, obstacles, buttons, HUD frames and icons)
so each one visibly belongs to the requested theme: change their form
language, materials and details, not only their colors.
Keep each asset's core function recognizable and its gameplay state
unchanged, so the game can still be played exactly as before.

ART DIRECTION
Follow all applicable requirements in the art direction notes, if any.
Within those requirements, prioritize:
- Clear silhouettes and solid, well-defined volumes.
- Attractive proportions and consistent visual scale.
- Bright, harmonious colors and clear visual hierarchy.
- Consistent lighting and restrained contact shadows.
- Clean materials and controlled surface detail.
- Immediate readability at mobile screen size.

If the requested style uses texture, such as wool or crochet,
make the material recognizable without obscuring shapes or creating noise.

BACKGROUND AND SUPPORTS
Use a plain, quiet background unless the user explicitly requests
an environment or the background contains essential gameplay information.
Preserve gameplay-relevant platforms and supports, but simplify
their decorative treatment.
Do not add scenery, props, mascots, particles or excessive glow.
Keep requested gameplay effects localized to the relevant objects.

PRIORITIES
1. Preserve core gameplay: mechanics, object functions and quantities,
   layout and existing HUD information.
2. Re-theme the assets to the user request as fully as possible.
3. Follow the art direction notes.
4. Improve visual polish without violating the above.

OUTPUT
Return one restyled game screen with the same aspect ratio as the input.
Do not output an asset sheet or promotional illustration."""

ASSETS_TEMPLATE = """You are a professional mobile game asset artist.

INPUTS
- Original game screenshot or asset reference image.
- Art direction notes, if the user request includes any.
- User request: {{USER_PROMPT}}
- Optional asset selection: {{ASSET_SELECTION}}

TASK
Create a clean asset sheet of the selected gameplay assets,
applying the user request and the art direction notes.

ASSET SELECTION
If an asset selection is provided, create only those assets.
Otherwise, identify the distinct reusable gameplay assets visible
in the reference.

Show each distinct asset once.
Include meaningful visual variants and gameplay states.
Do not duplicate identical assets merely because they appear
multiple times in the screenshot.
Do not invent assets that are absent from the reference.

PRESERVE IDENTITY AND FUNCTION
Keep each asset's recognizable basic form, functional parts,
orientation and distinguishing features.

Apply the requested theme to the existing asset.
Containers must remain containers, flowers must remain flowers,
and obstacles must remain recognizable gameplay obstacles.
Do not replace objects with pets or characters unless requested.
A material change must not alter their gameplay role.

Preserve gameplay states unless the user explicitly requests a change.
Create shared obstacle effects as separate reusable assets when they
can be separated cleanly from the underlying object.
Keep inseparable composite objects together.

STYLE CONSISTENCY
Follow all applicable requirements in the art direction notes, if any.
Use consistent:
- Shape language and proportions.
- Camera angle and rendering perspective.
- Lighting direction and shadow treatment.
- Materials, palette and level of detail.

Prioritize clear silhouettes, solid volumes, harmonious colors
and readability at mobile screen size.
Keep texture controlled, including for wool or crochet styles.
Do not invent additional decorative features from a brief user request.

ASSET SHEET PRESENTATION
Arrange assets in a clean, evenly spaced grid.
Center each asset in its own cell with enough padding.
Keep comparable assets at a consistent relative scale.
Show complete silhouettes without cropping or overlap.

Use a transparent background.
No environment, shelves used only for presentation, decorative props,
promotional banners or full-screen HUD.
Include HUD assets only when explicitly selected.

No labels, captions, watermarks or grid lines.
Preserve text or numbers only when they are integral to a selected asset.
Do not bake large ground shadows or surrounding scene effects into assets.

OUTPUT
Return one coherent asset sheet.
This is a visual asset sheet, not a packed texture atlas."""

TEMPLATES = {SCREEN: SCREEN_TEMPLATE, ASSETS: ASSETS_TEMPLATE}


def render_edit(user_prompt: str) -> str:
    return ("Edit the attached image according to the user's requested changes. "
            "Preserve all details, composition, style and transparency that the user did not ask to change. "
            "Return one edited image, with the same aspect ratio as the input.\n\n"
            "REQUESTED CHANGES\n" + user_prompt.strip())


def render(preset: str, user_prompt: str, asset_selection: str = "") -> str:
    """Fill the template. `{{USER_PROMPT}}` and `{{ASSET_SELECTION}}` are replaced as plain text."""
    text = TEMPLATES[preset].replace("{{USER_PROMPT}}", user_prompt.strip())
    return text.replace("{{ASSET_SELECTION}}", asset_selection.strip() or ASSET_SELECTION_NONE)
