from __future__ import annotations

import asyncio
import io
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.db import connect, now_iso
from app.generation.engine import GenerationEngine
from app.generation.plan import AssetMeta, PlanError, build_plan
from app.main import create_app
from app.providers import ProviderError, ProviderRegistry
from app.providers.base import Capabilities, GenerateRequest, GenerateResult, ImageProvider
from app.schemas import Graph

CSRF = {"x-nodecanvas-csrf": "1"}
DONE = {"completed", "partially_completed", "failed", "cancelled", "paused", "interrupted"}


def png(color: str = "blue", size: tuple[int, int] = (32, 32)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


class FakeProvider(ImageProvider):
    id = "fake"
    name = "Fake"

    def __init__(self) -> None:
        self.calls: list[tuple[str, GenerateRequest]] = []
        self.outcomes: list[Any] = []  # ProviderError instances fail that call; anything else succeeds
        self.auth_state = "connected"
        self.gate: threading.Event | None = None
        self.started = threading.Event()

    async def authenticate(self):  # type: ignore[override]
        return self.auth_state

    async def check_auth(self):  # type: ignore[override]
        return self.auth_state

    def get_capabilities(self) -> Capabilities:
        return Capabilities()

    async def _run(self, op: str, request: GenerateRequest) -> GenerateResult:
        self.calls.append((op, request))
        self.started.set()
        if self.gate is not None:
            while not self.gate.is_set():
                await asyncio.sleep(0.01)
        outcome = self.outcomes.pop(0) if self.outcomes else None
        if isinstance(outcome, ProviderError):
            raise outcome
        return GenerateResult(image_bytes=png(), mime_type="image/png", reported_model="fake-model")

    async def generate(self, request: GenerateRequest) -> GenerateResult:
        return await self._run("generate", request)

    async def edit(self, request: GenerateRequest) -> GenerateResult:
        return await self._run("edit", request)

    def normalize_result(self, raw: Any) -> GenerateResult:
        return raw

    def normalize_error(self, exc: BaseException) -> ProviderError:
        return ProviderError("UNKNOWN_ERROR", str(exc))


# --- graph helpers --------------------------------------------------------------------------------


def node(id_: str, type_: str, **data: Any) -> dict[str, Any]:
    return {"id": id_, "type": type_, "position": {"x": 0, "y": 0}, "data": {"title": id_, **data}}


def edge(source: str, target: str, handle: str) -> dict[str, Any]:
    return {"id": f"{source}-{target}-{handle}", "source": source, "sourceHandle": "out", "target": target, "targetHandle": handle}


def gen(**data: Any) -> dict[str, Any]:
    base = {
        "providerId": "fake",
        "model": "",
        "preset": "screen",
        "assetSelection": "",
        "mode": "manual",
        "outputCount": 1,
        "variantsPerInput": 1,
        "aspectRatio": "1:1",
        "quality": "auto",
        "outputFormat": "png",
        "primaryOriginalNodeId": None,
    }
    return node("g", "generate", **{**base, **data})


def orig(id_: str = "orig", asset: str = "a1") -> dict[str, Any]:
    return node(id_, "image", assetId=asset, notes="", roles=[])


def prompt(text: str = "Change it to a crochet style.", id_: str = "p", **data: Any) -> dict[str, Any]:
    return node(id_, "prompt", **{"text": text, "enabled": True, **data})


def graph(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, Any]:
    return {"nodes": nodes, "edges": edges, "viewport": {"x": 0, "y": 0, "zoom": 1}}


ASSETS = {
    "a1": AssetMeta("flower_01.png", False),
    "a2": AssetMeta("flower_02.png", False),
    "a3": AssetMeta("flower_03.png", False),
    "t1": AssetMeta("style.png", False),
    "gone": AssetMeta("gone.png", True),
}


def plan(g: dict[str, Any], assets: dict[str, AssetMeta] = ASSETS, max_images: int = 16):
    return build_plan(Graph(**g), "g", assets, max_input_images=max_images)


def errors_of(g: dict[str, Any], **kw: Any) -> list[str]:
    with pytest.raises(PlanError) as exc:
        plan(g, **kw)
    return exc.value.errors


def collection(id_: str, *asset_ids: str, disabled: tuple[str, ...] = (), overrides: dict[str, str] | None = None):
    items = [
        {"id": f"i{n}", "assetId": a, "enabled": a not in disabled, "promptOverride": (overrides or {}).get(a, "")}
        for n, a in enumerate(asset_ids)
    ]
    return node(id_, "collection", role="input", description="", items=items)


# --- plan: modes and counts ----------------------------------------------------------------------



def test_manual_count_makes_n_variations_of_the_original() -> None:
    p = plan(graph([gen(outputCount=3), prompt(), orig()], [edge("p", "g", "prompt"), edge("orig", "g", "original")]))
    assert len(p.tasks) == 3
    assert [t.variant_index for t in p.tasks] == [1, 2, 3]
    assert all(t.operation == "edit" and t.original_asset_id == "a1" for t in p.tasks)


def test_result_edit_uses_current_output_and_change_request_without_restyle_template() -> None:
    g = graph([gen(editResult=True), prompt("Remove the blue flower only."), node("result", "output", assetId="a2")],
              [edge("p", "g", "prompt"), edge("result", "g", "original")])
    p = plan(g)
    assert len(p.tasks) == 1 and p.tasks[0].original_asset_id == "a2"
    assert p.tasks[0].operation == "edit"
    assert "Remove the blue flower only." in p.tasks[0].prompt
    assert "Preserve all details" in p.tasks[0].prompt
    assert "PRESERVE GAMEPLAY AND LAYOUT" not in p.tasks[0].prompt
    assert "the image to edit" in p.tasks[0].prompt
    assert p.settings["preset"] == "result_edit"


@pytest.mark.parametrize("preset,edit", [("screen", False), ("assets", False), ("screen", True)])
def test_short_prompt_recovers_the_user_input_and_preserves_full_template(preset, edit) -> None:
    from app.generation.prompt_parts import split_prompt
    request = "Make the flowers pink.\nKeep the pots blue."
    p = plan(graph([gen(preset=preset, editResult=edit, assetSelection="flowers"), prompt(request), orig()],
                   [edge("p", "g", "prompt"), edge("orig", "g", "original")]))
    full = p.tasks[0].prompt
    parts = split_prompt(full, p.settings)
    assert parts["user_prompt"] == request
    assert parts["prefix"] + parts["user_prompt"] + parts["suffix"] == full
    assert "ADDITIONAL INPUTS" in parts["suffix"]


@pytest.mark.parametrize("value", [0, 5, 1.5, True, "2", None])
def test_legacy_concurrency_setting_is_ignored(value) -> None:
    g = graph([gen(concurrency=value), prompt(), orig()], [edge("p", "g", "prompt"), edge("orig", "g", "original")])
    assert "concurrency" not in plan(g).settings



def test_both_presets_need_an_original() -> None:
    no_original = graph([gen(), prompt()], [edge("p", "g", "prompt")])
    assert any("Game screen restyle needs an original image" in e for e in errors_of(no_original))
    sheet = graph([gen(preset="assets"), prompt()], [edge("p", "g", "prompt")])
    assert any("Asset sheet needs an original image" in e for e in errors_of(sheet))


def test_manual_several_originals_requires_primary() -> None:
    nodes = [gen(), prompt(), node("o1", "original", assetId="a1"), node("o2", "original", assetId="a2")]
    edges = [edge("p", "g", "prompt"), edge("o1", "g", "original"), edge("o2", "g", "original")]
    assert any("Primary original" in e for e in errors_of(graph(nodes, edges)))
    nodes[0] = gen(primaryOriginalNodeId="o2")
    assert [t.original_asset_id for t in plan(graph(nodes, edges)).tasks] == ["a2"]


def test_match_inputs_flattens_collection_and_multiplies_variants() -> None:
    g = graph(
        [gen(mode="match", variantsPerInput=2), prompt(), collection("c", "a1", "a2", "a3", disabled=("a2",))],
        [edge("p", "g", "prompt"), edge("c", "g", "original")],
    )
    p = plan(g)
    assert [(t.original_asset_id, t.variant_index) for t in p.tasks] == [("a1", 1), ("a1", 2), ("a3", 1), ("a3", 2)]
    assert [t.slot_index for t in p.tasks] == [0, 1, 2, 3]


def test_match_inputs_without_originals_fails() -> None:
    errs = errors_of(graph([gen(mode="match"), prompt()], [edge("p", "g", "prompt")]))
    assert any("Match inputs needs" in e for e in errs)
    g = graph([gen(mode="match"), prompt(), collection("c", "a1", disabled=("a1",))], [edge("p", "g", "prompt"), edge("c", "g", "original")])
    assert any("no enabled images" in e for e in errors_of(g))


def test_task_limit() -> None:
    g = graph([gen(mode="match", variantsPerInput=5), prompt(), collection("c", *["a1"] * 41)], [edge("p", "g", "prompt"), edge("c", "g", "original")])
    assert any("limit is 200" in e for e in errors_of(g))


def test_no_prompt_is_an_error() -> None:
    assert any("Prompt node with text" in e for e in errors_of(graph([gen(), prompt("  ")], [edge("p", "g", "prompt")])))
    disabled = prompt(enabled=False)
    assert errors_of(graph([gen(), disabled], [edge("p", "g", "prompt")]))


def test_missing_asset_blocks_plan() -> None:
    g = graph([gen(), prompt(), node("o", "original", assetId="gone")], [edge("p", "g", "prompt"), edge("o", "g", "original")])
    assert any("missing" in e for e in errors_of(g))


def test_image_limit() -> None:
    themes = [node(f"t{i}", "theme", assetId="t1", roles=["artStyle"], notes="") for i in range(3)]
    g = graph([gen(), prompt(), *themes], [edge("p", "g", "prompt"), *[edge(f"t{i}", "g", "theme") for i in range(3)]])
    assert any("at most 2" in e for e in errors_of(g, max_images=2))


# --- plan: validation of the graph itself -------------------------------------------------------------


def test_server_rejects_wrong_port_and_second_palette() -> None:
    pal = lambda i: node(i, "palette", colors=[])  # noqa: E731
    g = graph([gen(), prompt(), pal("x"), pal("y")], [edge("p", "g", "prompt"), edge("x", "g", "palette"), edge("y", "g", "palette"), edge("p", "g", "theme")])
    errs = errors_of(g)
    assert any("accepts only one connection" in e for e in errs)
    assert any("cannot connect to the theme port" in e for e in errs)


def test_server_rejects_cycles() -> None:
    g = graph(
        [gen(), prompt(), node("c", "collection", role="output", items=[]), node("g2", "generate")],
        [edge("p", "g", "prompt"), edge("g", "c", "in"), edge("g2", "g", "original"), edge("g", "g2", "original")],
    )
    assert any("loop" in e for e in errors_of(g))


# --- plan: prompt compilation ----------------------------------------------------------------------



def test_each_prompt_gets_the_full_set_of_outputs() -> None:
    edges = [edge("p", "g", "prompt"), edge("p2", "g", "prompt"), edge("orig", "g", "original")]
    p = plan(graph([gen(outputCount=3), prompt("Crochet."), prompt("Wood.", "p2"), orig()], edges))
    assert [t.slot_index for t in p.tasks] == list(range(6))
    assert [t.prompt_number for t in p.tasks] == [1, 1, 1, 2, 2, 2]
    assert [t.variant_index for t in p.tasks] == [1, 2, 3, 1, 2, 3]
    assert all(t.prompt_count == 2 for t in p.tasks)
    assert all("Crochet." in t.prompt for t in p.tasks[:3]) and all("Wood." in t.prompt for t in p.tasks[3:])
    m = plan(graph([gen(mode="match", variantsPerInput=2), prompt("A"), prompt("B", "p2"), collection("c", "a1", "a2")],
                   [edge("p", "g", "prompt"), edge("p2", "g", "prompt"), edge("c", "g", "original")]))
    assert len(m.tasks) == 2 * 2 * 2  # prompts x originals x variants
    one = plan(graph([gen(outputCount=2), prompt("A"), prompt("B", "p2", enabled=False), orig()],
                     [edge("p", "g", "prompt"), edge("p2", "g", "prompt"), edge("orig", "g", "original")]))
    assert len(one.tasks) == 2 and one.tasks[0].prompt_count == 1  # a disabled prompt adds nothing


def test_vivid_objects_note_appears_with_a_theme_image_or_palette_only() -> None:
    base = [gen(), prompt(), orig()]
    edges = [edge("p", "g", "prompt"), edge("orig", "g", "original")]
    marker = "Keep the main gameplay objects vivid."
    assert marker not in plan(graph(base, edges)).tasks[0].prompt
    theme = node("t", "image", assetId="t1", roles=["artStyle"], notes="")
    assert marker in plan(graph([*base, theme], [*edges, edge("t", "g", "theme")])).tasks[0].prompt
    pal = node("pal", "palette", colors=[{"hex": "#ff0000", "role": "primary", "ratio": 60}])
    assert marker in plan(graph([*base, pal], [*edges, edge("pal", "g", "palette")])).tasks[0].prompt


def test_variation_keeps_the_original_image_as_a_secondary_original() -> None:
    nodes = [gen(editResult=True, primaryOriginalNodeId="result"), prompt("Create a subtle variation."),
             node("result", "output", assetId="a2"), orig("context", "a1")]
    edges = [edge("p", "g", "prompt"), edge("result", "g", "original"), edge("context", "g", "original")]
    p = plan(graph(nodes, edges))
    task = p.tasks[0]
    assert task.original_asset_id == "a2" and task.extra_original_asset_ids == ["a1"]  # the varied image is image 1
    assert "Attached image 1 is the image to edit." in task.prompt
    assert "- Context: attached image 2 is the original image(s) this result was made from." in task.prompt
    assert "edit image 1." in task.prompt
    assert task.operation == "edit"


def test_free_prompt_sends_the_request_as_written_without_the_game_template() -> None:
    from app.generation.prompt_parts import split_prompt

    theme = node("t", "image", assetId="t1", roles=["artStyle"], notes="")
    edges = [edge("p", "g", "prompt"), edge("orig", "g", "original"), edge("t", "g", "theme")]
    p = plan(graph([gen(preset="free"), prompt("Turn the flowers into paper cut-outs."), orig(), theme], edges))
    text = p.tasks[0].prompt
    assert text.startswith("Turn the flowers into paper cut-outs.")
    for game_only in ("You are a professional mobile game", "PRESERVE GAMEPLAY", "THE STYLE MUST REACH", "Keep the main gameplay objects vivid."):
        assert game_only not in text
    assert "ADDITIONAL INPUTS" in text and "Attached image 1 is the original image." in text  # inputs are still described
    assert "Style references:" in text
    assert p.settings["preset"] == "free"
    # The editable request is recovered exactly, so Retry shows what the user wrote.
    assert split_prompt(text, p.settings)["user_prompt"] == "Turn the flowers into paper cut-outs."
    assert any("original image" in e for e in errors_of(graph([gen(preset="free"), prompt()], [edge("p", "g", "prompt")])))


def test_the_task_limit_counts_every_prompt() -> None:
    edges = [edge("p", "g", "prompt"), edge("p2", "g", "prompt"), edge("orig", "g", "original")]
    errs = errors_of(graph([gen(outputCount=150), prompt("A"), prompt("B", "p2"), orig()], edges))
    assert any("300 tasks" in e for e in errs)


def test_the_prompt_is_the_chosen_preset_with_the_request_and_the_extras() -> None:
    nodes = [
        gen(preset="screen"),
        prompt("Make it crochet. Repaint {asset_name}."),
        prompt("Keep colours bright.", "p2"),
        node("o", "image", assetId="a1", notes="", roles=[]),
        node("t", "image", assetId="t1", roles=["lighting", "artStyle"], notes="Glossy."),
        node("pal", "palette", colors=[{"hex": "#ff0000", "role": "primary", "ratio": 60}]),
    ]
    edges = [edge("p", "g", "prompt"), edge("p2", "g", "prompt"), edge("o", "g", "original"), edge("t", "g", "theme"), edge("pal", "g", "palette")]
    both = plan(graph(nodes, edges))
    text = both.tasks[0].prompt
    assert text.startswith("You are a professional mobile game artist.")  # preset 1
    assert "- User request: Make it crochet. Repaint flower_01.\n" in text  # placeholders filled
    assert "Keep colours bright." not in text  # each Prompt node is its own request
    assert "- User request: Keep colours bright.\n" in both.tasks[1].prompt
    assert "{{" not in text  # no template marker is left behind
    assert "Art direction notes" in text and "attached art" not in text.lower()
    extras = text.split("ADDITIONAL INPUTS\n")[1]
    assert extras.splitlines() == [
        "- Attached image 1 is the original game screenshot.",
        "- Style references: attached image 2 is style references. Follow their art style and lighting. Glossy. Do not copy their subjects.",
        "- Color palette: use primary #FF0000 (about 60%).",
        "- Keep the main gameplay objects vivid. Even if the palette or style references are muted or pale, they "
        "must stay saturated, high-contrast and clearly stand out from the background, supports and HUD. Use the "
        "palette and style references for the overall look and secondary elements, not to wash out the key objects. "
        "Objects that are told apart by color for gameplay must keep their original colors but still be redrawn in the theme's art style; other elements may follow the palette and theme.",
        "- Requested output aspect ratio: 1:1. This overrides any aspect-ratio rule above.",
    ]

    nodes[0] = gen(preset="assets", assetSelection="pots, ice and number badges", aspectRatio="match")
    sheet = plan(graph(nodes, edges)).tasks[0].prompt
    assert sheet.startswith("You are a professional mobile game asset artist.")
    assert "- Optional asset selection: pots, ice and number badges" in sheet
    assert "Attached image 1 is the original game screenshot or asset reference image." in sheet
    assert "aspect-ratio rule above" not in sheet  # "match" adds no aspect line

    nodes[0] = gen(preset="assets")
    assert "- Optional asset selection: none (identify the distinct reusable gameplay assets yourself)" in plan(graph(nodes, edges)).tasks[0].prompt


def test_an_unknown_preset_is_refused_and_the_old_options_are_ignored() -> None:
    base = [prompt(), orig()]
    edges = [edge("p", "g", "prompt"), edge("orig", "g", "original")]
    assert any("Choose a preset" in e for e in errors_of(graph([gen(preset="poster"), *base], edges)))
    # Saved projects still carry the removed game-asset fields; they change nothing.
    old = gen(assetCategory="Item", artStyle="Soft 3D", background="white", preserveSubject=True, consistentFraming=True)
    assert plan(graph([old, *base], edges)).tasks[0].prompt == plan(graph([gen(), *base], edges)).tasks[0].prompt
    legacy_prompt = prompt(constraints="No text", role="style", order=3, assetCategory="Item", artStyle="x")
    assert plan(graph([gen(), legacy_prompt, orig()], edges)).tasks[0].prompt == plan(graph([gen(), *base], edges)).tasks[0].prompt



def test_unknown_and_unfillable_placeholders_are_reported() -> None:
    edges = [edge("p", "g", "prompt"), edge("orig", "g", "original")]
    errs = errors_of(graph([gen(), prompt("Draw {thing}"), orig()], edges))
    assert any("Unknown placeholder {thing}" in e for e in errs)
    errs = errors_of(graph([gen(), prompt("Draw {collection_name}"), orig()], edges))
    assert any("{collection_name} cannot be filled" in e for e in errs)
    assert "Draw flower_01" in plan(graph([gen(), prompt("Draw {asset_name}"), orig()], edges)).tasks[0].prompt


def test_invalid_palette_hex() -> None:
    g = graph([gen(), prompt(), orig(), node("pal", "palette", colors=[{"hex": "#12", "role": "primary"}])], [edge("p", "g", "prompt"), edge("orig", "g", "original"), edge("pal", "g", "palette")])
    assert any("not a valid HEX" in e for e in errors_of(g))


# --- API + worker -----------------------------------------------------------------------------------


@pytest.fixture
def ctx(tmp_path: Path):
    settings = Settings(workspace_dir=tmp_path / "ws", credentials_dir=tmp_path / "creds", codex_cli_home=tmp_path / "codex")
    app = create_app(settings)
    fake = FakeProvider()
    app.state.providers = ProviderRegistry([fake])
    with TestClient(app) as c:
        pid = c.post("/api/projects", json={"name": "P"}, headers=CSRF).json()["id"]
        yield c, pid, fake, settings


def import_assets(c: TestClient, pid: str, *names: str) -> list[str]:
    res = c.post(
        "/api/assets/import",
        data={"project_id": pid},
        files=[("files", (n, png("red"), "image/png")) for n in names],
        headers=CSRF,
    )
    return [a["id"] for a in res.json()["imported"]]


def start(c: TestClient, pid: str, g: dict[str, Any]):
    return c.post("/api/generations", json={"project_id": pid, "generate_node_id": "g", "graph": g}, headers=CSRF)


def wait(c: TestClient, batch_id: str, timeout: float = 5.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        batch = c.get(f"/api/generations/{batch_id}").json()
        if batch["status"] in DONE and batch["active_count"] == 0 or batch["status"] in ("paused", "interrupted"):
            return batch
        time.sleep(0.02)
    raise AssertionError(f"batch did not settle: {batch}")


def solo_graph(c: TestClient, pid: str, **gen_data: Any) -> dict[str, Any]:
    """One prompt, one uploaded original ("main.png"), one Generate node."""
    (asset,) = import_assets(c, pid, "main.png")
    return graph([gen(**gen_data), prompt(), orig("orig", asset)], [edge("p", "g", "prompt"), edge("orig", "g", "original")])


def match_graph(ids: list[str], variants: int = 1) -> dict[str, Any]:
    return graph(
        [gen(mode="match", variantsPerInput=variants), prompt("Repaint {asset_name}"), collection("c", *ids)],
        [edge("p", "g", "prompt"), edge("c", "g", "original")],
    )


def test_batch_runs_and_stores_outputs(ctx) -> None:
    c, pid, fake, settings = ctx
    ids = import_assets(c, pid, "flower_01.png", "flower_02.png")
    res = start(c, pid, match_graph(ids))
    assert res.status_code == 201, res.text
    batch = wait(c, res.json()["batch"]["id"])
    assert (batch["status"], batch["completed_count"], batch["expected_count"]) == ("completed", 2, 2)

    tasks = c.get(f"/api/generations/{batch['id']}/tasks").json()
    assert [t["source_asset_id"] for t in tasks] == ids
    assert all(t["status"] == "completed" and t["result"]["width"] == 32 for t in tasks)
    assert "Repaint flower_01" in tasks[0]["prompt"] and tasks[0]["prompt"].startswith("You are a professional mobile game artist.")
    # Each call carried its own original image first.
    assert [op for op, _ in fake.calls] == ["edit", "edit"]
    assert fake.calls[0][1].original_image == png("red")

    assets = {a["id"]: a for a in c.get(f"/api/projects/{pid}/assets").json()}
    out = assets[tasks[0]["output_asset_id"]]
    assert (out["name"], out["origin"]) == ("flower_01_v01.png", "generated")


@pytest.mark.parametrize("concurrency", [1, 2, 4])
def test_worker_stays_sequential_with_legacy_concurrency(ctx, concurrency) -> None:
    c, pid, fake, _ = ctx
    fake.gate = threading.Event()
    batch_id = start(c, pid, solo_graph(c, pid, outputCount=5, concurrency=concurrency)).json()["batch"]["id"]
    try:
        deadline = time.monotonic() + 3
        while len(fake.calls) < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(fake.calls) == 1
        time.sleep(0.05)
        assert len(fake.calls) == 1
    finally:
        fake.gate.set()
    batch = wait(c, batch_id)
    assert batch["status"] == "completed" and batch["completed_count"] == 5
    assert len(fake.calls) == 5


@pytest.mark.parametrize("separate_projects", [False, True])
def test_generate_nodes_run_concurrently_but_each_node_stays_sequential(ctx, separate_projects) -> None:
    c, pid, fake, _ = ctx
    other_pid = c.post("/api/projects", json={"name": "Other"}, headers=CSRF).json()["id"] if separate_projects else pid
    first_graph = solo_graph(c, pid, outputCount=3)
    second_graph = solo_graph(c, other_pid, outputCount=3)
    second_id = "g" if separate_projects else "other-g"
    for n in second_graph["nodes"]:
        if n["id"] == "g":
            n["id"] = second_id
    for e in second_graph["edges"]:
        if e["target"] == "g":
            e["target"] = second_id
    fake.gate = threading.Event()
    try:
        first = start(c, pid, first_graph)
        assert first.status_code == 201, first.text
        second = c.post("/api/generations", json={"project_id": other_pid,
                        "generate_node_id": second_id, "graph": second_graph}, headers=CSRF)
        assert second.status_code == 201, second.text
        deadline = time.monotonic() + 3
        while len(fake.calls) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(fake.calls) == 2
        time.sleep(0.05)
        assert len(fake.calls) == 2
        for response in (first, second):
            tasks = c.get(f"/api/generations/{response.json()['batch']['id']}/tasks").json()
            assert sum(t["status"] in ("preparing", "running") for t in tasks) == 1
    finally:
        fake.gate.set()
    for response in (first, second):
        assert wait(c, response.json()["batch"]["id"])["completed_count"] == 3


@pytest.mark.parametrize("fmt,mime", [("png", "image/png"), ("webp", "image/webp"), ("jpg", "image/jpeg")])
def test_generation_stores_requested_format(ctx, fmt, mime) -> None:
    c, pid, _, _ = ctx
    batch_id = start(c, pid, solo_graph(c, pid, outputFormat=fmt)).json()["batch"]["id"]
    assert wait(c, batch_id)["status"] == "completed"
    task = c.get(f"/api/generations/{batch_id}/tasks").json()[0]
    assert task["result"]["mime_type"] == mime
    assert task["result"]["provider_mime_type"] == "image/png"
    response = c.get(f"/api/assets/{task['output_asset_id']}/file")
    assert response.headers["content-type"] == mime


def test_edit_generated_result_sends_its_pixels_not_the_first_original(ctx) -> None:
    c, pid, fake, _ = ctx
    first = start(c, pid, solo_graph(c, pid)).json()["batch"]["id"]
    wait(c, first)
    old = c.get(f"/api/generations/{first}/tasks").json()[0]["output_asset_id"]
    edit_graph = graph([gen(editResult=True), prompt("Make only the flowers pink."), node("result", "output", assetId=old),
                        node("edited", "output", assetId=None, sourceNodeId="result")],
                       [edge("p", "g", "prompt"), edge("result", "g", "original"), edge("result", "edited", "edit")])
    response = start(c, pid, edit_graph)
    assert response.status_code == 201, response.text
    edited = wait(c, response.json()["batch"]["id"])
    assert edited["status"] == "completed"
    assert fake.calls[-1][1].original_image == png()
    assert fake.calls[-1][1].original_image != png("red")
    assert "Make only the flowers pink." in fake.calls[-1][1].prompt
    assert "PRESERVE GAMEPLAY AND LAYOUT" not in fake.calls[-1][1].prompt
    assert c.get(f"/api/assets/{old}/file").status_code == 200


def test_origin_prompt_follows_edits_back_to_the_request_that_made_the_image(ctx) -> None:
    c, pid, _, _ = ctx
    first = start(c, pid, solo_graph(c, pid)).json()["batch"]["id"]
    wait(c, first)
    old = c.get(f"/api/generations/{first}/tasks").json()[0]["output_asset_id"]
    assert c.get(f"/api/assets/{old}/origin-prompt").json() == {"prompts": ["Change it to a crochet style."]}
    edit_graph = graph([gen(editResult=True), prompt("Make only the flowers pink."), node("result", "output", assetId=old),
                        node("edited", "output", assetId=None, sourceNodeId="result")],
                       [edge("p", "g", "prompt"), edge("result", "g", "original"), edge("result", "edited", "edit")])
    second = start(c, pid, edit_graph).json()["batch"]["id"]
    wait(c, second)
    new = c.get(f"/api/generations/{second}/tasks").json()[0]["output_asset_id"]
    assert c.get(f"/api/assets/{new}/origin-prompt").json()["prompts"] == ["Change it to a crochet style.", "Make only the flowers pink."]
    upload = c.post("/api/assets/import", data={"project_id": pid}, files=[("files", ("u.png", png(), "image/png"))], headers=CSRF)
    assert c.get(f"/api/assets/{upload.json()['imported'][0]['id']}/origin-prompt").json() == {"prompts": []}


def test_regenerate_chosen_success_preserves_old_attempt_and_deduplicates_ids(ctx) -> None:
    c, pid, fake, _ = ctx
    batch_id = start(c, pid, solo_graph(c, pid)).json()["batch"]["id"]
    wait(c, batch_id)
    original = c.get(f"/api/generations/{batch_id}/tasks").json()[0]
    response = c.post(f"/api/generations/{batch_id}/retry", json={"task_ids": [original["id"], original["id"]]}, headers=CSRF)
    assert response.status_code == 200 and response.json()["retried"] == 1
    assert wait(c, batch_id)["completed_count"] == 1
    tasks = c.get(f"/api/generations/{batch_id}/tasks").json()
    assert len(tasks) == 2 and len(fake.calls) == 2
    assert tasks[0]["output_asset_id"] == original["output_asset_id"]
    assert tasks[1]["output_asset_id"] != original["output_asset_id"]
    assert fake.calls[0][1].prompt == fake.calls[1][1].prompt


@pytest.mark.parametrize("edited", ["Change only the flowers to pink.", "", "   "])
def test_retry_can_edit_prompt_and_keeps_original_inputs_and_settings(ctx, edited) -> None:
    c, pid, fake, _ = ctx
    batch_id = start(c, pid, solo_graph(c, pid)).json()["batch"]["id"]
    wait(c, batch_id)
    original = c.get(f"/api/generations/{batch_id}/tasks").json()[0]
    response = c.post(f"/api/generations/{batch_id}/retry", json={"task_ids": [original["id"]], "prompt": edited}, headers=CSRF)
    assert response.status_code == 200
    assert wait(c, batch_id)["status"] == "completed"
    tasks = c.get(f"/api/generations/{batch_id}/tasks").json()
    assert tasks[0]["prompt"] == original["prompt"]
    assert tasks[1]["prompt"] == (edited.strip() or original["prompt"])
    assert tasks[1]["request"] == original["request"]
    assert fake.calls[1][1].original_image == fake.calls[0][1].original_image == png("red")
    assert fake.calls[1][1].settings == fake.calls[0][1].settings


def test_failures_keep_successes_and_retry_failed_only(ctx) -> None:
    c, pid, fake, _ = ctx
    ids = import_assets(c, pid, "a.png", "b.png", "c.png")
    fake.outcomes = [None, ProviderError("EMPTY_RESULT", "nothing"), None]
    batch = wait(c, start(c, pid, match_graph(ids)).json()["batch"]["id"])
    assert (batch["status"], batch["completed_count"], batch["failed_count"]) == ("partially_completed", 2, 1)

    res = c.post(f"/api/generations/{batch['id']}/retry", json={}, headers=CSRF)
    assert res.json()["retried"] == 1
    batch = wait(c, batch["id"])
    assert (batch["status"], batch["completed_count"], batch["failed_count"]) == ("completed", 3, 0)
    tasks = c.get(f"/api/generations/{batch['id']}/tasks").json()
    assert len(tasks) == 4  # the failed attempt stays in history
    assert [t["attempt_number"] for t in tasks if t["slot_index"] == 1] == [1, 2]
    assert len(fake.calls) == 4  # successful images were not generated again


def test_rate_limit_pauses_then_resume(ctx) -> None:
    c, pid, fake, _ = ctx
    ids = import_assets(c, pid, "a.png", "b.png", "c.png")
    fake.outcomes = [None, ProviderError("RATE_LIMITED", "slow down")]
    batch = wait(c, start(c, pid, match_graph(ids)).json()["batch"]["id"])
    assert batch["status"] == "paused" and "rate limited" in batch["status_reason"]
    assert (batch["completed_count"], batch["failed_count"], batch["active_count"]) == (1, 1, 1)
    assert len(fake.calls) == 2  # no automatic retry, and the third task was not sent

    c.post(f"/api/generations/{batch['id']}/resume", headers=CSRF)
    batch = wait(c, batch["id"])
    assert (batch["status"], batch["completed_count"], batch["failed_count"]) == ("partially_completed", 2, 1)


def test_cancel_keeps_completed_outputs(ctx) -> None:
    c, pid, fake, _ = ctx
    ids = import_assets(c, pid, "a.png", "b.png", "c.png")
    fake.gate = threading.Event()
    batch_id = start(c, pid, match_graph(ids)).json()["batch"]["id"]
    assert fake.started.wait(2)
    res = c.post(f"/api/generations/{batch_id}/cancel", headers=CSRF).json()
    assert res["note"] and "cannot be stopped" in res["note"]
    fake.gate.set()
    batch = wait(c, batch_id)
    assert (batch["status"], batch["completed_count"], batch["cancelled_count"]) == ("cancelled", 1, 2)
    assert len(fake.calls) == 1

    # Resume sends the cancelled (never sent) tasks.
    c.post(f"/api/generations/{batch_id}/resume", headers=CSRF)
    batch = wait(c, batch_id)
    assert (batch["status"], batch["completed_count"]) == ("completed", 3)


def test_requires_connected_provider_and_valid_graph(ctx) -> None:
    c, pid, fake, _ = ctx
    fake.auth_state = "not_connected"
    res = start(c, pid, solo_graph(c, pid))
    assert res.status_code == 409 and res.json()["error"]["code"] == "AUTH_REQUIRED"
    fake.auth_state = "connected"
    res = start(c, pid, graph([gen(mode="match"), prompt()], [edge("p", "g", "prompt")]))
    assert res.status_code == 400
    assert any("Match inputs" in e for e in res.json()["error"]["errors"])


def test_preview_lists_compiled_prompts(ctx) -> None:
    c, pid, _, _ = ctx
    ids = import_assets(c, pid, "flower_01.png", "flower_02.png")
    body = {"project_id": pid, "generate_node_id": "g", "graph": match_graph(ids, variants=2)}
    res = c.post("/api/generations/preview", json=body, headers=CSRF).json()
    assert res["ok"] and res["total_tasks"] == 4
    assert res["provider"]["auth_state"] == "connected"
    assert "Repaint flower_02" in res["tasks"][2]["prompt"]
    body["graph"] = graph([gen(), prompt("{nope}")], [edge("p", "g", "prompt")])
    res = c.post("/api/generations/preview", json=body, headers=CSRF).json()
    assert not res["ok"] and "Unknown placeholder" in res["errors"][0]


def test_output_names_and_history_list(ctx) -> None:
    c, pid, fake, _ = ctx
    batch = wait(c, start(c, pid, solo_graph(c, pid, outputCount=2)).json()["batch"]["id"])
    assert batch["status"] == "completed"
    assert [op for op, _ in fake.calls] == ["edit", "edit"]  # both presets always work from the original
    names = sorted(a["name"] for a in c.get(f"/api/projects/{pid}/assets").json() if a["origin"] == "generated")
    assert names == ["main_v01.png", "main_v02.png"]
    assert [b["id"] for b in c.get(f"/api/generations?project_id={pid}").json()] == [batch["id"]]


def test_restart_marks_running_tasks_interrupted(ctx) -> None:
    c, pid, _, settings = ctx
    conn = connect(settings.database_path)
    ts = now_iso()
    conn.execute(
        "INSERT INTO generation_batches (id, project_id, generate_node_id, mode, expected_count, status, snapshot_json,"
        " created_at, provider_id, name) VALUES ('b', ?, 'g', 'manual', 2, 'running', '{}', ?, 'fake', 'G')",
        (pid, ts),
    )
    for tid, status, slot in (("t1", "running", 0), ("t2", "queued", 1)):
        conn.execute(
            "INSERT INTO generation_tasks (id, batch_id, variant_index, status, prompt_snapshot, provider_request_json,"
            " created_at, slot_index) VALUES (?, 'b', 1, ?, 'x', '{}', ?, ?)",
            (tid, status, ts, slot),
        )
    conn.close()

    GenerationEngine(settings, lambda: ProviderRegistry([])).recover()
    batch = c.get("/api/generations/b").json()
    assert batch["status"] == "interrupted"
    tasks = {t["id"]: t["status"] for t in c.get("/api/generations/b/tasks").json()}
    assert tasks == {"t1": "interrupted", "t2": "queued"}


def test_client_chosen_batch_id(ctx) -> None:
    c, pid, _, _ = ctx
    bid = "6f1c2c4e-8a3b-4d7e-9f00-123456789abc"
    body = {"project_id": pid, "generate_node_id": "g", "graph": solo_graph(c, pid), "batch_id": bid}
    res = c.post("/api/generations", json=body, headers=CSRF)
    assert res.status_code == 201 and res.json()["batch"]["id"] == bid
    wait(c, bid)
    again = c.post("/api/generations", json=body, headers=CSRF)
    assert again.status_code == 409 and again.json()["error"]["code"] == "BATCH_EXISTS"


def test_one_image_node_takes_its_role_from_the_port() -> None:
    img = lambda i, a: node(i, "image", assetId=a, notes="", preserve={"shape": True}, instructions="", roles=["lighting"])  # noqa: E731
    g = graph(
        [gen(), prompt(), img("o", "a1"), img("t", "t1"), img("r", "a2"), node("out", "output", assetId="a3")],
        [edge("p", "g", "prompt"), edge("o", "g", "original"), edge("t", "g", "theme"), edge("r", "g", "reference")],
    )
    task = plan(g).tasks[0]
    assert (task.original_asset_id, task.theme_asset_ids, task.reference_asset_ids) == ("a1", ["t1"], ["a2"])
    assert "Follow their lighting." in task.prompt
    # A generated result can feed a port directly.
    g["edges"][1] = edge("out", "g", "original")
    assert plan(g).tasks[0].original_asset_id == "a3"


def test_project_delete_refused_while_batch_runs(ctx) -> None:
    c, pid, fake, _ = ctx
    fake.gate = threading.Event()
    batch_id = start(c, pid, solo_graph(c, pid)).json()["batch"]["id"]
    assert fake.started.wait(2)
    res = c.delete(f"/api/projects/{pid}", headers=CSRF)
    assert res.status_code == 409 and res.json()["error"]["code"] == "BATCH_ACTIVE"
    fake.gate.set()
    wait(c, batch_id)
    assert c.delete(f"/api/projects/{pid}", headers=CSRF).status_code == 204


def test_palette_image_port_is_valid_and_single() -> None:
    img = lambda i: node(i, "image", assetId="a1", notes="", preserve={}, instructions="", roles=[])  # noqa: E731
    pal = node("pal", "palette", colors=[{"hex": "#112233", "role": "primary", "ratio": 60}])
    base = [gen(), prompt(), orig(), img("i1"), img("i2"), pal]
    edges = [edge("p", "g", "prompt"), edge("orig", "g", "original"), edge("pal", "g", "palette"), edge("i1", "pal", "image")]
    assert plan(graph(base, edges)).tasks  # an image feeding a palette is fine
    errs = errors_of(graph(base, [*edges, edge("i2", "pal", "image")]))
    assert any("accepts only one connection" in e for e in errs)


def test_manual_count_sends_every_original_with_the_primary_first() -> None:
    nodes = [gen(primaryOriginalNodeId="o2"), prompt(), node("o1", "image", assetId="a1", notes="", preserve={}, instructions="", roles=[]),
             node("o2", "image", assetId="a2", notes="", preserve={}, instructions="", roles=[]), collection("c", "a3")]
    edges = [edge("p", "g", "prompt"), edge("o1", "g", "original"), edge("o2", "g", "original"), edge("c", "g", "original")]
    task = plan(graph(nodes, edges)).tasks[0]
    assert task.original_asset_id == "a2"  # the primary
    assert task.extra_original_asset_ids == ["a1", "a3"]  # the rest, in connection order, collection items included
    assert "- Additional originals: attached images 2–3 are also provided as originals (secondary)" in task.prompt

    # Match inputs: one original per task, so nothing extra.
    nodes[0] = gen(mode="match")
    assert all(not t.extra_original_asset_ids for t in plan(graph(nodes, edges)).tasks)
    # They count towards the image limit.
    nodes[0] = gen(primaryOriginalNodeId="o2")
    assert any("at most 2" in e for e in errors_of(graph(nodes, edges), max_images=2))  # primary + 2 extras = 3 images


def test_extra_originals_reach_the_provider_in_prompt_order(ctx) -> None:
    c, pid, fake, _ = ctx
    ids = import_assets(c, pid, "main.png", "other.png")
    img = lambda i, a: node(i, "image", assetId=a, notes="", preserve={}, instructions="", roles=[])  # noqa: E731
    g = graph([gen(primaryOriginalNodeId="m"), prompt(), img("m", ids[0]), img("x", ids[1])],
              [edge("p", "g", "prompt"), edge("x", "g", "original"), edge("m", "g", "original")])
    wait(c, start(c, pid, g).json()["batch"]["id"])
    request = fake.calls[0][1]
    assert request.original_image == png("red")
    assert len(request.reference_images) == 1  # the extra original follows the primary



def test_match_original_aspect_resolves_to_the_closest_preset_per_original() -> None:
    assets = {**ASSETS, "shot": AssetMeta("level36.png", False, 1080, 1920)}
    g = graph([gen(aspectRatio="match"), prompt(), orig("o", "shot")], [edge("p", "g", "prompt"), edge("o", "g", "original")])
    task = plan(g, assets=assets).tasks[0]
    assert task.aspect_ratio == "9:16"
    assert "aspect-ratio rule above" not in task.prompt  # the preset already says "same aspect ratio as the input"



def test_extract_node_only_outputs_to_an_input_collection() -> None:
    src = node("src", "image", assetId="t1", notes="", roles=[])
    ex = node("x", "extract", hint="", detections=None, off=[], generateNodeId=None)
    ok = graph([gen(), prompt(), orig(), src, ex], [edge("p", "g", "prompt"), edge("orig", "g", "original"), edge("src", "x", "image")])
    assert plan(ok).tasks  # it does not take part in the generation

    # It has nothing to give to a Generate node.
    wired = graph([gen(), prompt(), orig(), src, ex], [edge("p", "g", "prompt"), edge("src", "x", "image"), edge("x", "g", "original")])
    assert any("cannot connect" in e for e in errors_of(wired))
    two = graph([gen(), prompt(), orig(), src, node("src2", "image", assetId="a1", notes="", roles=[]), ex],
                [edge("p", "g", "prompt"), edge("orig", "g", "original"), edge("src", "x", "image"), edge("src2", "x", "image")])
    assert any("accepts only one connection" in e for e in errors_of(two))

    crops = node('c', 'collection', role='input', items=[
        {'assetId': 'a1', 'enabled': True, 'promptOverride': ''},
        {'assetId': 't1', 'enabled': True, 'promptOverride': ''},
    ])
    workflow = graph([gen(mode='match', preset='assets', variantsPerInput=1), prompt(text='Remove background.'), src, ex, crops],
                     [edge('src', 'x', 'image'), edge('x', 'c', 'extract'), edge('c', 'g', 'original'), edge('p', 'g', 'prompt')])
    tasks = plan(workflow).tasks
    assert len(tasks) == 2
    assert [t.original_asset_id for t in tasks] == ['a1', 't1']
    crops['data']['role'] = 'output'
    assert any('input collection' in e for e in errors_of(workflow))
