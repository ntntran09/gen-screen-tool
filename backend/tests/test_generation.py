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
        "mode": "manual",
        "outputCount": 1,
        "variantsPerInput": 1,
        "aspectRatio": "1:1",
        "quality": "auto",
        "outputFormat": "png",
        "background": "white",
        "backgroundValue": "",
        "assetCategory": "Item",
        "artStyle": "",
        "preserveSubject": True,
        "preserveSilhouette": True,
        "consistentFraming": True,
        "consistentScale": False,
        "primaryOriginalNodeId": None,
    }
    return node("g", "generate", **{**base, **data})


def prompt(text: str = "A cute potion", id_: str = "p", **data: Any) -> dict[str, Any]:
    return node(id_, "prompt", **{"text": text, "constraints": "", "enabled": True, "role": "main", "order": 0, **data})


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


def test_manual_text_to_image_creates_n_tasks() -> None:
    p = plan(graph([gen(outputCount=3), prompt()], [edge("p", "g", "prompt")]))
    assert len(p.tasks) == 3
    assert [t.variant_index for t in p.tasks] == [1, 2, 3]
    assert all(t.operation == "generate" and t.original_asset_id is None for t in p.tasks)


def test_manual_one_original_makes_variations() -> None:
    g = graph(
        [gen(outputCount=2), prompt(), node("o", "original", assetId="a1", preserve={"shape": True}, instructions="")],
        [edge("p", "g", "prompt"), edge("o", "g", "original")],
    )
    p = plan(g)
    assert [t.original_asset_id for t in p.tasks] == ["a1", "a1"]
    assert p.tasks[0].operation == "edit"
    assert "Preserve its main subject, silhouette and shape." in p.tasks[0].prompt


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


def test_prompt_order_and_sections() -> None:
    g = graph(
        [
            gen(mode="match", artStyle="Soft 3D", background="solid", backgroundValue="pink"),
            prompt("Style text", "ps", role="style"),
            prompt("Repaint {asset_name} #{asset_index} v{variant_index}", "pm", constraints="No text"),
            collection("c", "a1", overrides={"a1": "Make it blue"}),
            node("t", "theme", assetId="t1", roles=["lighting", "artStyle"], notes="Glossy."),
            node("pal", "palette", colors=[{"hex": "#ff0000", "role": "primary", "ratio": 60}]),
        ],
        [edge("ps", "g", "prompt"), edge("pm", "g", "prompt"), edge("c", "g", "original"), edge("t", "g", "theme"), edge("pal", "g", "palette")],
    )
    text = plan(g).tasks[0].prompt
    order = [
        "Repaint flower_01 #1 v1",
        "Constraints: No text",
        "Style text",
        'Asset: flower_01 from the collection "c".',
        "Original image: attached image 1",
        "Theme references: attached image 2 is style references. Follow their art style and lighting. Glossy.",
        "Color palette: use primary #FF0000 (about 60%).",
        "Game asset type: Item. Art style: Soft 3D",
        "For this asset: Make it blue",
        "Output: aspect ratio 1:1, solid pink background.",
    ]
    positions = [text.index(s) for s in order]
    assert positions == sorted(positions), text


def test_unknown_and_unfillable_placeholders_are_reported() -> None:
    errs = errors_of(graph([gen(), prompt("Draw {thing}")], [edge("p", "g", "prompt")]))
    assert any("Unknown placeholder {thing}" in e for e in errs)
    errs = errors_of(graph([gen(), prompt("Draw {asset_name}")], [edge("p", "g", "prompt")]))
    assert any("{asset_name} cannot be filled" in e for e in errs)


def test_invalid_palette_hex() -> None:
    g = graph([gen(), prompt(), node("pal", "palette", colors=[{"hex": "#12", "role": "primary"}])], [edge("p", "g", "prompt"), edge("pal", "g", "palette")])
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
    assert tasks[0]["prompt"].startswith("Repaint flower_01")
    # Each call carried its own original image first.
    assert [op for op, _ in fake.calls] == ["edit", "edit"]
    assert fake.calls[0][1].original_image == png("red")

    assets = {a["id"]: a for a in c.get(f"/api/projects/{pid}/assets").json()}
    out = assets[tasks[0]["output_asset_id"]]
    assert (out["name"], out["origin"]) == ("flower_01_v01.png", "generated")


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
    res = start(c, pid, graph([gen(), prompt()], [edge("p", "g", "prompt")]))
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
    assert res["tasks"][2]["prompt"].startswith("Repaint flower_02")
    body["graph"] = graph([gen(), prompt("{nope}")], [edge("p", "g", "prompt")])
    res = c.post("/api/generations/preview", json=body, headers=CSRF).json()
    assert not res["ok"] and "Unknown placeholder" in res["errors"][0]


def test_text_only_name_and_list(ctx) -> None:
    c, pid, fake, _ = ctx
    batch = wait(c, start(c, pid, graph([gen(outputCount=2), prompt()], [edge("p", "g", "prompt")])).json()["batch"]["id"])
    assert batch["status"] == "completed"
    assert [op for op, _ in fake.calls] == ["generate", "generate"]
    names = sorted(a["name"] for a in c.get(f"/api/projects/{pid}/assets").json())
    assert names == ["g_01.png", "g_02.png"]
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
    body = {"project_id": pid, "generate_node_id": "g", "graph": graph([gen(), prompt()], [edge("p", "g", "prompt")]), "batch_id": bid}
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


def test_game_screen_keeps_gameplay_and_matches_aspect() -> None:
    assets = {**ASSETS, "shot": AssetMeta("level36.png", False, 1080, 1920)}
    g = graph(
        [gen(assetCategory="Game Screen", aspectRatio="match", background="white"), prompt("Winter theme"), node("o", "image", assetId="shot")],
        [edge("p", "g", "prompt"), edge("o", "g", "original")],
    )
    task = plan(g, assets=assets).tasks[0]
    assert task.aspect_ratio == "9:16"
    assert "keep the gameplay identical" in task.prompt
    assert "composition" in task.prompt and "object count" in task.prompt
    assert "Single centered subject" not in task.prompt
    assert "white background" not in task.prompt
    assert "Output: aspect ratio 9:16, the screen's own full-bleed background" in task.prompt

    text_only = graph([gen(aspectRatio="match"), prompt()], [edge("p", "g", "prompt")])
    assert any("Match original" in e for e in errors_of(text_only))


def test_project_delete_refused_while_batch_runs(ctx) -> None:
    c, pid, fake, _ = ctx
    fake.gate = threading.Event()
    batch_id = start(c, pid, graph([gen(), prompt()], [edge("p", "g", "prompt")])).json()["batch"]["id"]
    assert fake.started.wait(2)
    res = c.delete(f"/api/projects/{pid}", headers=CSRF)
    assert res.status_code == 409 and res.json()["error"]["code"] == "BATCH_ACTIVE"
    fake.gate.set()
    wait(c, batch_id)
    assert c.delete(f"/api/projects/{pid}", headers=CSRF).status_code == 204


def test_game_asset_settings_come_from_the_prompt() -> None:
    g = graph(
        [gen(assetCategory="Item", artStyle="old"), prompt(assetCategory="Character", artStyle="Chibi", consistentFraming=False)],
        [edge("p", "g", "prompt")],
    )
    text = plan(g).tasks[0].prompt
    assert "Game asset type: Character. Art style: Chibi" in text
    assert "Single centered subject" not in text


def test_palette_image_port_is_valid_and_single() -> None:
    img = lambda i: node(i, "image", assetId="a1", notes="", preserve={}, instructions="", roles=[])  # noqa: E731
    pal = node("pal", "palette", colors=[{"hex": "#112233", "role": "primary", "ratio": 60}])
    base = [gen(), prompt(), img("i1"), img("i2"), pal]
    edges = [edge("p", "g", "prompt"), edge("pal", "g", "palette"), edge("i1", "pal", "image")]
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
    assert "Additional originals: attached images 2–3 are also provided as original assets" in task.prompt

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


def test_game_screen_without_an_original_is_refused() -> None:
    g = graph([gen(), prompt(assetCategory="Game Screen")], [edge("p", "g", "prompt")])
    assert any("Game Screen needs an original image" in e for e in errors_of(g))


def test_extract_node_fills_an_input_collection_and_cannot_feed_generate_directly() -> None:
    src = node("src", "image", assetId="t1", notes="", preserve={}, instructions="", roles=[])
    col = collection("c", "a1", "a2", "a3", disabled=("a2",), overrides={"a1": "the left one"})
    chain = graph([gen(mode="match"), prompt("Redraw {asset_name}"), src, node("x", "extract", hint="", detections=None, off=[]), col],
                  [edge("p", "g", "prompt"), edge("src", "x", "image"), edge("x", "c", "extract"), edge("c", "g", "original")])
    p = plan(chain)
    assert [(t.original_asset_id, t.source.name) for t in p.tasks] == [("a1", "flower_01"), ("a3", "flower_03")]
    assert "For this asset: the left one" in p.tasks[0].prompt

    # Straight into Generate is not a valid connection: the cut-outs live in the collection.
    direct = graph([gen(), prompt(), src, node("x", "extract", hint="", detections=None, off=[])],
                   [edge("p", "g", "prompt"), edge("src", "x", "image"), edge("x", "g", "original")])
    assert any("cannot connect to the original port" in e for e in errors_of(direct))
    # Only an Input Collection takes extracted assets; the Extract node takes exactly one image.
    out_col = node("c", "collection", role="output", description="", items=[])
    wrong = graph([gen(), prompt(), src, node("x", "extract"), out_col], [edge("p", "g", "prompt"), edge("src", "x", "image"), edge("x", "c", "extract")])
    assert any("Extracted assets can only go to an Input Collection" in e for e in errors_of(wrong))
    two = graph([gen(), prompt(), src, node("src2", "image", assetId="a1", notes="", preserve={}, instructions="", roles=[]), node("x", "extract")],
                [edge("p", "g", "prompt"), edge("src", "x", "image"), edge("src2", "x", "image")])
    assert any("accepts only one connection" in e for e in errors_of(two))


def test_a_collection_item_label_names_the_task_so_one_image_can_be_redrawn_per_asset() -> None:
    items = [
        {"id": "i0", "assetId": "a1", "enabled": True, "label": "blue pot", "promptOverride": "the pot at the top left"},
        {"id": "i1", "assetId": "a1", "enabled": True, "label": "pause button", "promptOverride": "the round button"},
        {"id": "i2", "assetId": "a1", "enabled": True, "promptOverride": ""},  # no label: the image name
    ]
    col = node("c", "collection", role="input", description="", items=items)
    p = plan(graph([gen(mode="match"), prompt("Redraw the {asset_name}"), col], [edge("p", "g", "prompt"), edge("c", "g", "original")]))
    assert [t.source.name for t in p.tasks] == ["blue pot", "pause button", "flower_01"]
    assert p.tasks[0].prompt.startswith("Redraw the blue pot")
    assert "For this asset: the pot at the top left" in p.tasks[0].prompt
    assert all(t.original_asset_id == "a1" for t in p.tasks)  # always the full original image
