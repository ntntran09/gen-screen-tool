"""Turn a graph snapshot into generation tasks (spec §12, §13.1 steps 1–4, §14, §25).

Pure functions: no I/O. The caller supplies asset metadata so this module can check that
every input image exists before anything is queued.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePath
from typing import Any

from ..schemas import Graph, GraphNode

MAX_TASKS = 200
MAX_VARIANTS = 5

# Mirrors frontend/src/graph/registry.ts. The frontend checks the same rules while editing;
# they are re-checked here because the backend must not trust the client (spec §25).
# Every image-holding node outputs "image"; its role comes from the port it feeds. "original" and
# "theme" are node types from older projects, kept so their snapshots still validate.
OUTPUT_TYPE = {
    "prompt": "prompt",
    "image": "image",
    "original": "image",
    "theme": "image",
    "palette": "palette",
    "collection": "assetList",
    "generate": "generated",
    "output": "image",
}
INPUT_PORTS: dict[str, dict[str, tuple[tuple[str, ...], bool]]] = {
    # port id -> (accepted types, multiple)
    "generate": {
        "prompt": (("prompt",), True),
        "original": (("image", "assetList"), True),
        "reference": (("image",), True),
        "theme": (("image",), True),
        "palette": (("palette",), False),
    },
    "palette": {"image": (("image",), False)},
    "collection": {"in": (("generated",), False)},
    "output": {"in": (("generated",), False)},
}

ROLE_RANK = {"main": 0, "style": 1, "constraints": 2, "output": 3}
PRESERVE_LABELS = {
    "mainSubject": "main subject",
    "silhouette": "silhouette",
    "shape": "shape",
    "proportions": "proportions",
    "composition": "composition",
    "objectCount": "object count",
}
THEME_ROLE_LABELS = {
    "artStyle": "art style",
    "lighting": "lighting",
    "shading": "shading",
    "material": "materials",
    "mood": "mood",
    "composition": "composition",
    "texture": "textures",
}
BACKGROUND_TEXT = {
    "white": "plain white background",
    "transparent": "transparent background if possible, otherwise a plain flat background",
}
PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
PLACEHOLDERS = ("asset_name", "asset_index", "collection_name", "variant_index")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

# A whole game screen (screenshot or mockup) is re-themed without changing how it plays.
GAME_SCREEN = "Game Screen"
GAME_SCREEN_TEXT = (
    "Game screen: the original is a complete game screen, not a single asset. Re-theme the whole screen but keep the "
    "gameplay identical: the same layout and grid, the same number of objects in the same positions, sizes and grouping, "
    "every UI/HUD element (counters, timers, buttons, badges, labels) in its place and readable, and the same text and "
    "numbers. Only the visual style, colours and materials change; do not add, remove, merge or move gameplay elements."
)
GAME_SCREEN_PRESERVE = ["composition", "objectCount"]
# "Match original" picks the closest supported preset to the original image's shape.
MATCH_ASPECT = "match"
ASPECT_PRESETS = {"1:1": 1.0, "3:4": 3 / 4, "4:3": 4 / 3, "9:16": 9 / 16, "16:9": 16 / 9}


def closest_aspect(width: int, height: int) -> str:
    ratio = width / height if height else 1.0
    return min(ASPECT_PRESETS, key=lambda k: abs(ASPECT_PRESETS[k] - ratio))


class PlanError(Exception):
    """Validation failed. `errors` are user-facing sentences."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


@dataclass(frozen=True)
class AssetMeta:
    name: str
    missing: bool
    width: int = 0
    height: int = 0


@dataclass
class Source:
    """One original image after collections are flattened (spec §13.1 step 2)."""

    asset_id: str
    name: str
    node_id: str
    collection_name: str | None = None
    preserve: list[str] = field(default_factory=list)
    instructions: str = ""
    override: str = ""


@dataclass
class TaskPlan:
    slot_index: int
    variant_index: int
    source: Source | None
    source_index: int | None
    prompt: str
    operation: str  # "generate" (text only) or "edit" (with input images)
    original_asset_id: str | None
    theme_asset_ids: list[str]
    reference_asset_ids: list[str]
    aspect_ratio: str = "1:1"  # resolved per task when the setting is "Match original"


@dataclass
class Plan:
    generate_node_id: str
    name: str
    provider_id: str
    mode: str
    settings: dict[str, Any]
    theme_asset_ids: list[str]
    reference_asset_ids: list[str]
    palette: list[dict[str, Any]]
    sources: list[Source]
    tasks: list[TaskPlan]


def stem(name: str) -> str:
    return PurePath(name).stem or name


def _cycle(graph: Graph) -> bool:
    out: dict[str, list[str]] = {}
    for e in graph.edges:
        out.setdefault(e.source, []).append(e.target)
    state: dict[str, int] = {}  # 1 = on stack, 2 = done

    for start in out:
        if state.get(start):
            continue
        stack = [(start, iter(out.get(start, [])))]
        state[start] = 1
        while stack:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                state[node] = 2
                stack.pop()
            elif state.get(nxt) == 1:
                return True
            elif not state.get(nxt):
                state[nxt] = 1
                stack.append((nxt, iter(out.get(nxt, []))))
    return False


def validate_edges(graph: Graph, errors: list[str]) -> None:
    """Typed ports, cardinality, collection roles and cycles (spec §25)."""
    nodes = {n.id: n for n in graph.nodes}
    seen: set[tuple[str, str | None, str, str | None]] = set()
    per_port: dict[tuple[str, str | None], int] = {}
    for e in graph.edges:
        src, dst = nodes.get(e.source), nodes.get(e.target)
        if src is None or dst is None:
            errors.append("A connection points at a node that no longer exists.")
            continue
        out_type = OUTPUT_TYPE.get(src.type) if (e.sourceHandle or "out") == "out" else None
        port = INPUT_PORTS.get(dst.type, {}).get(e.targetHandle or "")
        if out_type is None or port is None:
            errors.append(f"Invalid connection into '{_title(dst)}'.")
            continue
        accepts, multiple = port
        if out_type not in accepts:
            errors.append(f"'{_title(src)}' cannot connect to the {e.targetHandle} port of '{_title(dst)}'.")
        if src.type == "collection" and src.data.get("role") != "input":
            errors.append(f"Only an Input Collection can feed a Generate node ('{_title(src)}').")
        if dst.type == "collection" and dst.data.get("role") != "output":
            errors.append(f"Generated results can only go to an Output Collection ('{_title(dst)}').")
        key = (e.source, e.sourceHandle, e.target, e.targetHandle)
        if key in seen:
            errors.append(f"Duplicate connection into '{_title(dst)}'.")
        seen.add(key)
        count = per_port[(e.target, e.targetHandle)] = per_port.get((e.target, e.targetHandle), 0) + 1
        if not multiple and count == 2:
            errors.append(f"The {e.targetHandle} port of '{_title(dst)}' accepts only one connection.")
    if _cycle(graph):
        errors.append("The graph contains a loop. Remove the connection that feeds a node back into itself.")


def _title(node: GraphNode) -> str:
    return str(node.data.get("title") or node.type)


class _Resolver:
    """Placeholder substitution; collects problems instead of sending unresolved text (spec §5.4)."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        self._reported: set[str] = set()

    def check_names(self, text: str, where: str) -> None:
        for name in PLACEHOLDER_RE.findall(text):
            if name not in PLACEHOLDERS and name not in self._reported:
                self._reported.add(name)
                self.errors.append(
                    f"Unknown placeholder {{{name}}} in {where}. Use one of: "
                    + ", ".join(f"{{{p}}}" for p in PLACEHOLDERS)
                    + "."
                )

    def fill(self, text: str, values: dict[str, str | None]) -> str:
        def sub(m: re.Match[str]) -> str:
            name = m.group(1)
            if name not in PLACEHOLDERS:
                return m.group(0)  # already reported by check_names
            value = values.get(name)
            if value is None:
                key = f"missing:{name}"
                if key not in self._reported:
                    self._reported.add(key)
                    reason = {
                        "asset_name": "there is no original image",
                        "asset_index": "there is no original image",
                        "collection_name": "the original image does not come from a collection",
                    }.get(name, "it has no value")
                    self.errors.append(f"{{{name}}} cannot be filled because {reason}.")
                return m.group(0)
            return value

        return PLACEHOLDER_RE.sub(sub, text)


def _connected(graph: Graph, node_id: str, handle: str) -> list[GraphNode]:
    nodes = {n.id: n for n in graph.nodes}
    return [nodes[e.source] for e in graph.edges if e.target == node_id and e.targetHandle == handle and e.source in nodes]


def _images_phrase(start: int, count: int) -> str:
    if count == 1:
        return f"attached image {start} is"
    return f"attached images {start}–{start + count - 1} are"


def build_plan(
    graph: Graph,
    generate_node_id: str,
    assets: dict[str, AssetMeta],
    *,
    max_input_images: int,
) -> Plan:
    """Validate the graph around one Generate node and compile every task. Raises PlanError."""
    errors: list[str] = []
    gen = next((n for n in graph.nodes if n.id == generate_node_id), None)
    if gen is None or gen.type != "generate":
        raise PlanError(["The Generate node was not found in the graph."])
    d = gen.data
    validate_edges(graph, errors)
    resolver = _Resolver(errors)

    def asset_ok(asset_id: Any, owner: str) -> bool:
        if not isinstance(asset_id, str) or not asset_id:
            errors.append(f"'{owner}' has no image.")
            return False
        meta = assets.get(asset_id)
        if meta is None:
            errors.append(f"The image in '{owner}' is not part of this project.")
            return False
        if meta.missing:
            errors.append(f"The image file for '{owner}' is missing from the workspace.")
            return False
        return True

    # --- Prompts (spec §5.5): role order, then the per-node order field, then connection order.
    prompts = [n for n in _connected(graph, gen.id, "prompt") if n.data.get("enabled", True)]
    prompts.sort(key=lambda n: (ROLE_RANK.get(str(n.data.get("role")), 9), n.data.get("order") or 0))
    prompt_parts: list[str] = []
    for n in prompts:
        for key in ("text", "constraints"):
            text = str(n.data.get(key) or "").strip()
            if text:
                resolver.check_names(text, f"'{_title(n)}'")
                prompt_parts.append(text if key == "text" else f"Constraints: {text}")
    if not prompt_parts:
        errors.append("Connect an enabled Prompt node with text to the Generate node.")

    # --- Originals, flattened in connection order (spec §13.1 step 2).
    # Game-asset settings live on the Prompt node; the first prompt in compile order decides. Older graphs
    # kept them on the Generate node, so fall back to it when the prompt has none.
    ga = next((n.data for n in prompts if "assetCategory" in n.data), d)
    is_screen = ga.get("assetCategory") == GAME_SCREEN
    gen_preserve = [k for k, on in (("mainSubject", ga.get("preserveSubject")), ("silhouette", ga.get("preserveSilhouette"))) if on]
    if is_screen:
        gen_preserve += GAME_SCREEN_PRESERVE
    sources: list[Source] = []
    original_nodes = _connected(graph, gen.id, "original")
    for n in original_nodes:
        if n.type != "collection":
            if not asset_ok(n.data.get("assetId"), _title(n)):
                continue
            own = [k for k, on in (n.data.get("preserve") or {}).items() if on]  # Output nodes have none
            instructions = str(n.data.get("instructions") or "").strip()
            resolver.check_names(instructions, f"'{_title(n)}'")
            sources.append(
                Source(
                    asset_id=n.data["assetId"],
                    name=stem(assets[n.data["assetId"]].name),
                    node_id=n.id,
                    preserve=list(dict.fromkeys(gen_preserve + own)),
                    instructions=instructions,
                )
            )
        elif n.type == "collection":
            for item in n.data.get("items") or []:
                if not item.get("enabled", True):
                    continue
                if not asset_ok(item.get("assetId"), f"{_title(n)} › image"):
                    continue
                override = str(item.get("promptOverride") or "").strip()
                resolver.check_names(override, f"a prompt override in '{_title(n)}'")
                sources.append(
                    Source(
                        asset_id=item["assetId"],
                        name=stem(assets[item["assetId"]].name),
                        node_id=n.id,
                        collection_name=_title(n),
                        preserve=list(gen_preserve),
                        override=override,
                    )
                )

    themes = _connected(graph, gen.id, "theme")
    refs = _connected(graph, gen.id, "reference")
    theme_ids = [n.data["assetId"] for n in themes if asset_ok(n.data.get("assetId"), _title(n))]
    ref_ids = [n.data["assetId"] for n in refs if asset_ok(n.data.get("assetId"), _title(n))]

    palette_nodes = _connected(graph, gen.id, "palette")
    palette: list[dict[str, Any]] = []
    for n in palette_nodes[:1]:
        for c in n.data.get("colors") or []:
            hex_ = str(c.get("hex") or "")
            if not HEX_RE.match(hex_):
                errors.append(f"'{hex_ or '(empty)'}' in '{_title(n)}' is not a valid HEX color.")
                continue
            palette.append({"hex": hex_.upper(), "role": c.get("role") or "accent", "ratio": c.get("ratio")})

    # --- Task layout (spec §12).
    mode = d.get("mode", "manual")
    layout: list[tuple[Source | None, int | None, int]] = []  # (source, source index, variant index)
    if mode == "match":
        variants = int(d.get("variantsPerInput") or 1)
        if not 1 <= variants <= MAX_VARIANTS:
            errors.append(f"Variants per original must be between 1 and {MAX_VARIANTS}.")
        if not original_nodes:
            errors.append("Match inputs needs Original images or an Input Collection connected to the Original port.")
        elif not sources and not errors:
            errors.append("The connected originals have no enabled images to generate from.")
        layout = [(s, i, v) for i, s in enumerate(sources, 1) for v in range(1, variants + 1)]
    else:
        count = int(d.get("outputCount") or 1)
        if not 1 <= count <= MAX_TASKS:
            errors.append(f"Number of outputs must be between 1 and {MAX_TASKS}.")
        chosen: Source | None = None
        if len(sources) == 1:
            chosen = sources[0]
        elif len(sources) > 1:
            primary = d.get("primaryOriginalNodeId")
            chosen = next((s for s in sources if s.node_id == primary and s.collection_name is None), None)
            if chosen is None:
                errors.append(
                    "Several original images are connected. Choose a Primary original in the inspector, or switch to Match inputs."
                )
        elif original_nodes and not errors:
            errors.append("The connected originals have no enabled images to generate from.")
        layout = [(chosen, 1 if chosen else None, v) for v in range(1, count + 1)]
    if d.get("aspectRatio") == MATCH_ASPECT and not any(s for s, _, _ in layout):
        errors.append("Aspect ratio 'Match original' needs an original image. Pick a fixed aspect ratio instead.")
    if len(layout) > MAX_TASKS:
        errors.append(f"This would create {len(layout)} tasks; the limit is {MAX_TASKS}. Split the batch into smaller ones.")

    per_task_images = (1 if any(s for s, _, _ in layout) else 0) + len(theme_ids) + len(ref_ids)
    if per_task_images > max_input_images:
        errors.append(
            f"Each request would attach {per_task_images} images; NodeCanvas allows at most {max_input_images}. "
            "Remove some Theme or Reference images."
        )

    settings = {
        "model": str(d.get("model") or ""),
        "aspect_ratio": d.get("aspectRatio", "1:1"),
        "quality": d.get("quality", "auto"),
        "output_format": d.get("outputFormat", "png"),
        "background": d.get("background", "white"),
        "background_value": str(d.get("backgroundValue") or ""),
        "asset_category": ga.get("assetCategory", "Other"),
    }
    art_style = str(ga.get("artStyle") or "").strip()
    resolver.check_names(art_style, "the art style instructions")
    if settings["background"] == "custom":
        resolver.check_names(settings["background_value"], "the background prompt")

    if errors:
        raise PlanError(list(dict.fromkeys(errors)))

    theme_labels = sorted(
        {THEME_ROLE_LABELS.get(r, r) for n in themes for r in (n.data.get("roles") or ["artStyle"])},
        key=list(THEME_ROLE_LABELS.values()).index,
    )
    theme_notes = [str(n.data.get("notes") or "").strip() for n in themes]
    ref_notes = [str(n.data.get("notes") or "").strip() for n in refs]

    tasks: list[TaskPlan] = []
    for slot, (source, source_index, variant) in enumerate(layout):
        values = {
            "asset_name": source.name if source else None,
            "asset_index": str(source_index) if source_index else None,
            "collection_name": source.collection_name if source else None,
            "variant_index": str(variant),
        }
        fill = lambda text: resolver.fill(text, values)  # noqa: E731
        sections: list[str] = ["\n\n".join(fill(p) for p in prompt_parts)]

        if source:  # 2. Batch asset identity
            where = f' from the collection "{source.collection_name}"' if source.collection_name else ""
            sections.append(f"Asset: {source.name}{where}.")

        next_image = 1
        if source:  # 3. Original image instructions
            text = "Original image: attached image 1 is the original asset to transform."
            if source.preserve:
                text += " Preserve its " + _join([PRESERVE_LABELS.get(k, k) for k in source.preserve]) + "."
            if source.instructions:
                text += " " + fill(source.instructions)
            sections.append(text)
            next_image = 2

        if theme_ids:  # 4. Theme references
            follow = _join(theme_labels) if theme_labels else "overall look"
            text = f"Theme references: {_images_phrase(next_image, len(theme_ids))} style references. Follow their {follow}."
            text += "".join(f" {note}" for note in theme_notes if note)
            if source:
                text += " Do not copy their subjects."
            sections.append(text)
            next_image += len(theme_ids)
        if ref_ids:
            text = f"Visual references: {_images_phrase(next_image, len(ref_ids))} general visual references."
            text += "".join(f" {note}" for note in ref_notes if note)
            sections.append(text)

        if palette:  # 5. Color palette
            colors = [
                f"{c['role']} {c['hex']}" + (f" (about {c['ratio']}%)" if isinstance(c.get("ratio"), (int, float)) else "")
                for c in palette
            ]
            sections.append("Color palette: use " + ", ".join(colors) + ".")

        game = [f"Game asset type: {settings['asset_category']}."]  # 6. Game asset constraints
        if art_style:
            game.append(f"Art style: {fill(art_style)}")
        if is_screen:
            game.append(GAME_SCREEN_TEXT)
        elif ga.get("consistentFraming"):
            game.append("Single centered subject with consistent margins.")
        if ga.get("consistentScale") and not is_screen:
            game.append("Keep a consistent visual scale across the set.")
        sections.append(" ".join(game))

        if source and source.override:  # 7. Per-asset override
            sections.append(f"For this asset: {fill(source.override)}")

        background = settings["background"]  # 8. Output instructions
        if is_screen and background != "custom":
            # A screen keeps its own full-bleed background; white/transparent would break it.
            bg_text = "the screen's own full-bleed background, restyled to the new theme"
        elif background == "solid":
            bg_text = f"solid {settings['background_value'].strip() or 'single-color'} background"
        elif background == "custom":
            bg_text = fill(settings["background_value"].strip()) or "simple background"
        else:
            bg_text = BACKGROUND_TEXT.get(background, "simple background")
        aspect = settings["aspect_ratio"]
        if aspect == MATCH_ASPECT and source:
            meta = assets[source.asset_id]
            aspect = closest_aspect(meta.width, meta.height)
        sections.append(f"Output: aspect ratio {aspect}, {bg_text}.")

        tasks.append(
            TaskPlan(
                slot_index=slot,
                variant_index=variant,
                source=source,
                source_index=source_index,
                prompt="\n\n".join(s for s in sections if s.strip()),
                operation="edit" if (source or theme_ids or ref_ids) else "generate",
                original_asset_id=source.asset_id if source else None,
                theme_asset_ids=list(theme_ids),
                reference_asset_ids=list(ref_ids),
                aspect_ratio=aspect,
            )
        )

    if errors:  # placeholder values that could not be filled
        raise PlanError(list(dict.fromkeys(errors)))

    return Plan(
        generate_node_id=gen.id,
        name=_title(gen),
        provider_id=str(d.get("providerId") or ""),
        mode=mode,
        settings=settings,
        theme_asset_ids=theme_ids,
        reference_asset_ids=ref_ids,
        palette=palette,
        sources=sources,
        tasks=tasks,
    )


def _join(words: list[str]) -> str:
    if len(words) <= 1:
        return "".join(words)
    return ", ".join(words[:-1]) + " and " + words[-1]
