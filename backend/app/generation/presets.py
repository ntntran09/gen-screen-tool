"""The prompt presets: restyle a whole game screen, create an asset sheet, or a free prompt with no template.

The wording is the user's own template. Two small changes: there is no attached art-direction file in
this app, so the art direction travels inside the user request ("art direction notes"), and the optional
asset selection reads "none" when empty.
"""

from __future__ import annotations

SCREEN = "screen"
ASSETS = "assets"
FREE = "free"
DEFAULT_PRESET = SCREEN

LABELS = {SCREEN: "Game screen restyle", ASSETS: "Asset sheet", FREE: "Free prompt"}
# What the Original image is, for the "attached images" notes.
ORIGINAL_NOUN = {
    SCREEN: "the original game screenshot",
    ASSETS: "the original game screenshot or asset reference image",
    FREE: "the original image",
}
ASSET_SELECTION_NONE = "none (identify the distinct reusable gameplay assets yourself)"

SCREEN_TEMPLATE = """You are a professional mobile game artist.

INPUTS
- Original game screenshot.
- Art direction notes, if the user request includes any.
- User request: {{USER_PROMPT}}

TASK
Restyle the provided game screenshot according to the user request
and the art direction notes.

THE STYLE MUST REACH EVERY OBJECT
Apply the theme's art style to everything on the screen, including the
flowers, plants, pieces and every other colored gameplay object, not only
the pots, shelves, background and HUD. Redraw each object in the theme's style, so that no
object keeps the original rendering, for example its soft glossy 3D
shading, realistic petals or airbrushed gradients.
You may change an object's shape, silhouette, pose, proportions and
material freely to fit the theme. A flower can become a graphic,
stylized or entirely different kind of bloom, and a pot can take any form
that suits the theme.
Only three things survive from an original object: its color (hue), its
position on the screen and its count. Different colors must stay clearly
different, so players can still tell the objects apart.

PRESERVE GAMEPLAY AND LAYOUT
The original screenshot is the source of truth for:
- Gameplay objects, their functions and quantities.
- Object positions, grouping, grid, shelves, slots and spacing.
- Camera perspective and relative object proportions.
- Gameplay states, obstacles, counters and special indicators.

Maintain a one-to-one correspondence between original and restyled
gameplay elements. Do not add, remove, rearrange or invent mechanics.

PRESERVE GAMEPLAY COLORS
Some gameplay objects are told apart by color, such as flowers, pieces
or items of different colors. For those objects only, keep the original
color identity: a blue flower stays blue and a red flower stays red,
and objects that were different colors must remain clearly different
colors. Keep the same number of distinct colors as in the original.
Keep only the hue. Their shape, form, material and rendering may all
change: redraw them in the theme's own line work, shading, texture, level
of detail and shape language, so they look drawn by the same artist as
the rest of the screen, not like the original illustration.
Everything else, such as the background, supports, containers that do
not identify gameplay, HUD frames and decoration, may freely take the
theme's colors.

PRESERVE SUBTLE GUIDES AND PATHS
Faint, low-contrast structure is part of the gameplay layout: the pale
paths, channels, tracks, lanes, funnels, recessed areas, empty slots,
grid cells and thin guide lines that show where objects travel or rest.
Keep each of them in the same place with the same shape and extent, and
keep them just as subtle and low-contrast relative to their surroundings.
Re-theme their material and tint, but do not turn a faint guide into a
heavy, thick, high-contrast or decorative element (for example a bold
rope, border, pipe or frame), do not hide it under decoration, and do not
merge it into the background or the surrounding supports.

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

A themed container must still read as a container that holds its contents.
Do not turn objects into pets, characters or mascots unless requested.
A material change must not change gameplay states or mechanics.
Change obstacle themes only when the user requests it.

Unspecified details should remain consistent with the original.
Do not expand a short request into an invented story or environment.

THEME THE ASSETS FIRST
The main goal is a clearly re-themed game. Redraw the visual assets
(gameplay objects, containers, obstacles, buttons, HUD frames and icons)
so each one visibly belongs to the requested theme: change their shape,
form, materials and details, not only their colors.
Keep each asset's gameplay role clear and its gameplay state unchanged,
so the game can still be played exactly as before. Their shape and
silhouette may change as long as they stay readable and fill the same
place on the screen.
Use one consistent art style across the whole screen. This includes the
colored gameplay objects: only their hue is kept, never their original
rendering or shape. Leaving some objects in the original style while the rest
changes is a failure.

ART DIRECTION
Follow all applicable requirements in the art direction notes, if any.
Within those requirements, prioritize:
- Clear silhouettes and solid, well-defined volumes.
- Attractive proportions and consistent visual scale.
- Bright, harmonious colors and clear visual hierarchy.
- Main gameplay objects that are vivid, saturated and clearly stand out
  from the background, supports and HUD, whatever the overall style.
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
   layout, existing HUD information and the original colors of
   objects that are told apart by color.
2. Re-theme the assets to the user request as fully as possible.
3. Follow the art direction notes.
4. Improve visual polish without violating the above.

OUTPUT
Return one restyled game screen with the same aspect ratio as the input.
Do not output an asset sheet or promotional illustration.

BEFORE YOU ANSWER
Check every flower and gameplay piece. If one still looks like the
original rendering instead of the theme's art style, redraw it in the
theme's style, keeping only its color, position and count."""

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

If assets are told apart by color (for example flowers of different
colors), keep each one's original color identity and keep them clearly
different, but redraw them in the theme's rendering style (line work,
shading, texture, detail), not in their original style. Other assets may
take the theme's colors.

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

# No template: the request goes to the model as written. The attached images, palette and aspect ratio are
# still described after it ("ADDITIONAL INPUTS"), like every other preset.
FREE_TEMPLATE = "{{USER_PROMPT}}"

TEMPLATES = {SCREEN: SCREEN_TEMPLATE, ASSETS: ASSETS_TEMPLATE, FREE: FREE_TEMPLATE}


def render_edit(user_prompt: str) -> str:
    return ("Edit the attached image according to the user's requested changes. "
            "Preserve all details, composition, style and transparency that the user did not ask to change. "
            "Return one edited image, with the same aspect ratio as the input.\n\n"
            "REQUESTED CHANGES\n" + user_prompt.strip())


def render(preset: str, user_prompt: str, asset_selection: str = "") -> str:
    """Fill the template. `{{USER_PROMPT}}` and `{{ASSET_SELECTION}}` are replaced as plain text."""
    text = TEMPLATES[preset].replace("{{USER_PROMPT}}", user_prompt.strip())
    return text.replace("{{ASSET_SELECTION}}", asset_selection.strip() or ASSET_SELECTION_NONE)
