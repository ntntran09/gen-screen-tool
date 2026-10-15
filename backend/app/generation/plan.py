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
from . import presets

FOLD_EDGE_PREFIX = "wf-"  # mirrors FOLD_EDGE in frontend/src/store/graphStore.ts
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
    "extract": "extracted",
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
    "extract": {"image": (("image",), False)},
    "collection": {"in": (("generated",), False), "extract": (("extracted",), False)},
    "output": {"in": (("generated",), False), "edit": (("image", "assetList"), False)},
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
PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
PLACEHOLDERS = ("asset_name", "asset_index", "collection_name", "variant_index")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

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
    # Manual count with several originals: the primary is the main one; these are sent along with it.
    extra_original_asset_ids: list[str] = field(default_factory=list)
    # Several Prompt nodes: each one gets its own full set of tasks (1-based).
    prompt_number: int = 1
    prompt_count: int = 1


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
        if e.id.startswith(FOLD_EDGE_PREFIX):
            continue  # display-only shortcut from a folded workflow button to its results; the real edges are checked
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
        if dst.type == "collection":
            role = "input" if e.targetHandle == "extract" else "output"
            if dst.data.get("role") != role:
                errors.append(f"This connection needs an {role} collection ('{_title(dst)}').")
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

    preset = str(d.get("preset") or presets.DEFAULT_PRESET)
    if preset not in presets.TEMPLATES:
        errors.append("Choose a preset on the Generate node: Game screen restyle, Asset sheet or Free prompt.")
        preset = presets.DEFAULT_PRESET

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

    # --- The user request: every enabled Prompt node's text, in connection order.
    prompt_parts: list[str] = []
    for n in _connected(graph, gen.id, "prompt"):
        if not n.data.get("enabled", True):
            continue
        text = str(n.data.get("text") or "").strip()
        if text:
            resolver.check_names(text, f"'{_title(n)}'")
            prompt_parts.append(text)
    if not prompt_parts:
        errors.append("Connect an enabled Prompt node with text to the Generate node.")
    selection = str(d.get("assetSelection") or "").strip()[:500]

    # --- Originals, flattened in connection order (spec §13.1 step 2).
    sources: list[Source] = []
    original_nodes = _connected(graph, gen.id, "original")
    for n in original_nodes:
        if n.type != "collection":
            if not asset_ok(n.data.get("assetId"), _title(n)):
                continue
            sources.append(Source(asset_id=n.data["assetId"], name=stem(assets[n.data["assetId"]].name), node_id=n.id))
        else:
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
    if not any(s for s, _, _ in layout) and not original_nodes:
        errors.append(f"{presets.LABELS[preset]} needs an original image: connect it to the Original port.")
    total_tasks = len(layout) * max(1, len(prompt_parts))
    if total_tasks > MAX_TASKS:
        errors.append(f"This would create {total_tasks} tasks; the limit is {MAX_TASKS}. Split the batch into smaller ones.")

    # Manual count sends every connected original (the primary first); Match inputs sends one per task.
    has_original = any(s for s, _, _ in layout)
    extras_per_task = len(sources) - 1 if mode != "match" and has_original else 0
    per_task_images = (1 if has_original else 0) + extras_per_task + len(theme_ids) + len(ref_ids)
    if per_task_images > max_input_images:
        errors.append(
            f"Each request would attach {per_task_images} images; NodeCanvas allows at most {max_input_images}. "
            "Remove some Original, Theme or Reference images."
        )

    if d.get("outputFormat", "png") not in ("png", "webp", "jpg"):
        errors.append("Output format must be PNG, WebP or JPG.")
    settings = {
        "model": str(d.get("model") or ""),
        "preset": "result_edit" if d.get("editResult") is True else preset,
        "asset_selection": selection,
        "aspect_ratio": d.get("aspectRatio", "match" if preset == presets.SCREEN else "1:1"),
        "quality": d.get("quality", "auto"),
        "output_format": d.get("outputFormat", "png"),
    }

    if errors:
        raise PlanError(list(dict.fromkeys(errors)))

    theme_labels = sorted(
        {THEME_ROLE_LABELS.get(r, r) for n in themes for r in (n.data.get("roles") or ["artStyle"])},
        key=list(THEME_ROLE_LABELS.values()).index,
    )
    theme_notes = [str(n.data.get("notes") or "").strip() for n in themes]
    ref_notes = [str(n.data.get("notes") or "").strip() for n in refs]

    tasks: list[TaskPlan] = []
    # Every enabled Prompt node gets the full layout (originals x variants / outputs), prompt by prompt.
    jobs = [(number, text, entry) for number, text in enumerate(prompt_parts, 1) for entry in layout]
    for slot, (prompt_number, prompt_text, (source, source_index, variant)) in enumerate(jobs):
        values = {
            "asset_name": source.name if source else None,
            "asset_index": str(source_index) if source_index else None,
            "collection_name": source.collection_name if source else None,
            "variant_index": str(variant),
        }
        fill = lambda text: resolver.fill(text, values)  # noqa: E731
        user_prompt = fill(prompt_text)
        edit_result = d.get("editResult") is True
        text = presets.render_edit(user_prompt) if edit_result else presets.render(preset, user_prompt, selection)

        # What else is attached, and how the images are numbered (the template names image 1 only).
        extras = [s for s in sources if s is not source] if (mode != "match" and source) else []
        original_noun = "the image to edit" if edit_result else presets.ORIGINAL_NOUN[preset]
        notes = [f"- Attached image 1 is {original_noun}."]
        next_image = 1
        if source:
            next_image = 2 + len(extras)
            if extras and edit_result:
                # A variation or edit of a generated result: the originals it came from are context only.
                notes.append(
                    f"- Context: {_images_phrase(2, len(extras))} the original image(s) this result was made from. "
                    "Use them only as context, to keep the style, details and composition consistent, and edit image 1."
                )
            elif extras:
                notes.append(
                    f"- Additional originals: {_images_phrase(2, len(extras))} also provided as originals (secondary); "
                    "use them together with image 1."
                )
        if theme_ids:
            follow = _join(theme_labels) if theme_labels else "overall look"
            line = f"- Style references: {_images_phrase(next_image, len(theme_ids))} style references. Follow their {follow}."
            line += "".join(f" {note}" for note in theme_notes if note)
            notes.append(line + " Do not copy their subjects.")
            next_image += len(theme_ids)
        if ref_ids:
            line = f"- Visual references: {_images_phrase(next_image, len(ref_ids))} general visual references."
            notes.append(line + "".join(f" {note}" for note in ref_notes if note))
        if palette:
            colors = [
                f"{c['role']} {c['hex']}" + (f" (about {c['ratio']}%)" if isinstance(c.get("ratio"), (int, float)) else "")
                for c in palette
            ]
            notes.append("- Color palette: use " + ", ".join(colors) + ".")
        if (palette or theme_ids) and preset != presets.FREE:  # a free prompt has no gameplay to protect
            notes.append(
                "- Keep the main gameplay objects vivid. Even if the palette or style references are muted or pale, they "
                "must stay saturated, high-contrast and clearly stand out from the background, supports and HUD. Use the "
                "palette and style references for the overall look and secondary elements, not to wash out the key objects. "
                "Objects that are told apart by color for gameplay must keep their original colors but still be redrawn in the theme's art style; other elements may follow the palette and theme."
            )
        if source and source.override:
            notes.append(f"- For this image: {fill(source.override)}")
        aspect = settings["aspect_ratio"]
        if aspect == MATCH_ASPECT and source:
            meta = assets[source.asset_id]
            aspect = closest_aspect(meta.width, meta.height)
        elif aspect != MATCH_ASPECT:
            notes.append(f"- Requested output aspect ratio: {aspect}. This overrides any aspect-ratio rule above.")
        text += "\n\nADDITIONAL INPUTS\n" + "\n".join(notes)

        tasks.append(
            TaskPlan(
                slot_index=slot,
                variant_index=variant,
                source=source,
                source_index=source_index,
                prompt=text,
                operation="edit",
                original_asset_id=source.asset_id if source else None,
                theme_asset_ids=list(theme_ids),
                reference_asset_ids=list(ref_ids),
                aspect_ratio=aspect,
                extra_original_asset_ids=[s.asset_id for s in extras],
                prompt_number=prompt_number,
                prompt_count=len(prompt_parts),
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
