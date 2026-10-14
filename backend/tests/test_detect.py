from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.analysis import MAX_ASSETS, detect_assets, parse_detections
from app.config import Settings
from app.main import create_app
from app.providers import ProviderError, ProviderRegistry
from app.providers.base import AnalysisResult, Capabilities, GenerateRequest, GenerateResult, ImageProvider
from app.providers.codex import BASE_URL, CodexProvider

from .test_codex import access_token, make_auth

CSRF = {"x-nodecanvas-csrf": "1"}


def png(size: tuple[int, int] = (100, 100), color: str = "red") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


# --- parsing ---------------------------------------------------------------------------------------------


def test_parse_accepts_fenced_json_and_normalises_boxes() -> None:
    text = '```json\n{"assets": [{"name": "  blue   pot ", "description": "d", "box": [500, 250, 100, 750]}]}\n```'
    (d,) = parse_detections(text)
    assert d.name == "blue pot"  # whitespace collapsed
    assert (d.x, d.y, d.w, d.h) == pytest.approx((0.1, 0.25, 0.4, 0.5))  # corners given in reverse order are fixed


def test_parse_drops_bad_items_and_clamps() -> None:
    text = json.dumps(
        {
            "assets": [
                {"name": "ok", "box": [-50, 0, 2000, 500]},  # clamped to the grid
                {"name": "tiny", "box": [0, 0, 5, 5]},  # too small to be an asset
                {"name": "bad", "box": [1, 2, 3]},  # wrong shape
                {"name": "text", "box": ["a", 0, 1, 2]},
                "nonsense",
                {"box": [0, 0, 500, 500]},  # nameless: gets a numbered name
            ]
        }
    )
    got = parse_detections(text)
    assert [d.name for d in got] == ["ok", "asset 2"]
    assert (got[0].x, got[0].w) == (0.0, 1.0)


def test_parse_strips_braces_that_would_look_like_placeholders() -> None:
    (d,) = parse_detections(json.dumps({"assets": [{"name": "pot {asset_name}", "description": "{x} red", "box": [0, 0, 500, 500]}]}))
    assert (d.name, d.description) == ("pot asset_name", "x red")


def test_parse_caps_the_count_and_rejects_garbage() -> None:
    many = json.dumps({"assets": [{"name": f"a{i}", "box": [0, 0, 100, 100]} for i in range(MAX_ASSETS + 20)]})
    assert len(parse_detections(many)) == MAX_ASSETS
    with pytest.raises(ProviderError) as exc:
        parse_detections("I could not see any assets.")
    assert exc.value.code == "EMPTY_RESULT"
    assert parse_detections("[]") == []


# --- model fallback ---------------------------------------------------------------------------------------


class Scripted(ImageProvider):
    id = "scripted"
    name = "Scripted"

    def __init__(self, answers: list[Any]) -> None:
        self.answers, self.models, self.efforts = answers, [], []

    async def authenticate(self):  # type: ignore[no-untyped-def,override]
        return "connected"

    async def check_auth(self):  # type: ignore[no-untyped-def,override]
        return "connected"

    def get_capabilities(self) -> Capabilities:
        return Capabilities()

    async def generate(self, request: GenerateRequest) -> GenerateResult:
        raise NotImplementedError

    async def edit(self, request: GenerateRequest) -> GenerateResult:
        raise NotImplementedError

    def normalize_result(self, raw: Any) -> GenerateResult:
        return raw

    def normalize_error(self, exc: BaseException) -> ProviderError:
        return ProviderError("UNKNOWN_ERROR", str(exc))

    async def analyze_image(
        self, image: bytes, prompt: str, *, instructions: str, model: str, effort: str = "low"
    ) -> AnalysisResult:
        self.models.append(model)
        self.efforts.append(effort)
        answer = self.answers.pop(0)
        if isinstance(answer, ProviderError):
            raise answer
        return AnalysisResult(text=answer, reported_model=model)


GOOD = json.dumps({"assets": [{"name": "pot", "description": "a pot", "box": [100, 100, 400, 500]}]})


def test_falls_back_to_the_next_model_only_when_a_model_is_rejected() -> None:
    p = Scripted([ProviderError("INVALID_INPUT", "unknown model"), GOOD])
    found, model = asyncio.run(detect_assets(p, png(), ("big", "small")))
    assert (p.models, model, [d.name for d in found]) == (["big", "small"], "small", ["pot"])

    p = Scripted([ProviderError("RATE_LIMITED", "slow down"), GOOD])  # retrying another model would not help
    with pytest.raises(ProviderError) as exc:
        asyncio.run(detect_assets(p, png(), ("big", "small")))
    assert exc.value.code == "RATE_LIMITED" and p.models == ["big"]


def test_hint_reaches_the_prompt() -> None:
    seen: list[str] = []

    class Spy(Scripted):
        async def analyze_image(self, image, prompt, *, instructions, model, effort="low"):  # type: ignore[no-untyped-def]
            seen.append(prompt)
            return AnalysisResult(text=GOOD)

    asyncio.run(detect_assets(Spy([]), png(), ("m",), hint="only the flowers"))
    assert "only the flowers" in seen[0] and "[x1, y1, x2, y2]" in seen[0]
    assert "list EACH one separately" in seen[0]
    assert "ONE representative instance" not in seen[0]
    assert "POT and the FLOWER as separate" not in seen[0]


# --- the Codex request and its event stream -----------------------------------------------------------------


def sse(*events: tuple[str, dict]) -> bytes:
    return "".join(f"event: {name}\ndata: {json.dumps(payload)}\n\n" for name, payload in events).encode()


def codex(tmp_path: Path, handler) -> CodexProvider:  # type: ignore[no-untyped-def]
    auth = make_auth(tmp_path, lambda r: httpx.Response(500))
    auth.store.save("codex", {"access_token": access_token(), "refresh_token": "rt"})
    return CodexProvider(auth, lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def ask(provider: CodexProvider) -> AnalysisResult:
    return asyncio.run(provider.analyze_image(png(), "p", instructions="i", model="m"))


def test_codex_sends_a_responses_request_with_the_image_and_reads_streamed_text(tmp_path: Path) -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"], seen["body"], seen["headers"] = str(req.url), json.loads(req.content), req.headers
        return httpx.Response(
            200,
            content=sse(
                ("response.created", {"type": "response.created"}),
                ("response.output_text.delta", {"type": "response.output_text.delta", "delta": '{"assets"'}),
                ("response.output_text.delta", {"type": "response.output_text.delta", "delta": ": []}"}),
                ("response.completed", {"type": "response.completed", "response": {"model": "gpt-6-luna-2026"}}),
            ),
        )

    result = asyncio.run(codex(tmp_path, handler).analyze_image(png(), "find", instructions="json", model="gpt-6-luna", effort="max"))
    assert result.text == '{"assets": []}' and result.reported_model == "gpt-6-luna-2026"
    body = seen["body"]
    assert seen["url"] == f"{BASE_URL}/responses"
    assert (body["model"], body["stream"], body["store"], body["instructions"]) == ("gpt-6-luna", True, False, "json")
    assert body["reasoning"] == {"effort": "max"}
    content = body["input"][0]["content"]
    assert content[0] == {"type": "input_text", "text": "find"}
    assert content[1]["type"] == "input_image" and content[1]["image_url"].startswith("data:image/png;base64,")
    assert seen["headers"]["chatgpt-account-id"] == "acct-123456789"


def test_codex_final_text_event_wins_and_failures_map_to_errors(tmp_path: Path) -> None:
    done = sse(("response.output_text.done", {"type": "response.output_text.done", "text": "FINAL"}))
    assert ask(codex(tmp_path, lambda r: httpx.Response(200, content=done))).text == "FINAL"

    failed = sse(("response.failed", {"type": "response.failed", "response": {"error": {"message": "model overloaded"}}}))
    with pytest.raises(ProviderError) as exc:
        ask(codex(tmp_path, lambda r: httpx.Response(200, content=failed)))
    assert exc.value.code == "PROVIDER_UNAVAILABLE" and "overloaded" in exc.value.message

    with pytest.raises(ProviderError) as exc:
        ask(codex(tmp_path, lambda r: httpx.Response(200, content=b"")))
    assert exc.value.code == "EMPTY_RESULT"

    with pytest.raises(ProviderError) as exc:
        ask(codex(tmp_path, lambda r: httpx.Response(429, json={"error": {"message": "usage limit reached"}})))
    assert exc.value.code == "QUOTA_EXCEEDED"


# --- the endpoints -----------------------------------------------------------------------------------------


@pytest.fixture
def ctx(tmp_path: Path):
    settings = Settings(workspace_dir=tmp_path / "ws", credentials_dir=tmp_path / "creds", codex_cli_home=tmp_path / "codex")
    app = create_app(settings)
    provider = Scripted([GOOD])
    app.state.providers = ProviderRegistry([provider])
    with TestClient(app) as c:
        pid = c.post("/api/projects", json={"name": "P"}, headers=CSRF).json()["id"]
        yield c, pid, provider


def upload(c: TestClient, pid: str, data: bytes, name: str = "screen.png") -> str:
    res = c.post("/api/assets/import", data={"project_id": pid}, files=[("files", (name, data, "image/png"))], headers=CSRF)
    return res.json()["imported"][0]["id"]


def test_detect_endpoint_returns_boxes_and_the_model(ctx) -> None:
    c, pid, provider = ctx
    a = upload(c, pid, png((200, 100)))
    res = c.post(f"/api/assets/{a}/detect", json={"provider_id": "scripted", "hint": "pots"}, headers=CSRF)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["asset_id"] == a and body["model"] == "gpt-6-luna"
    assert body["assets"][0]["name"] == "pot" and body["assets"][0]["x"] == pytest.approx(0.1)
    assert provider.models == ["gpt-6-luna"]  # the lightest model is tried first

    provider.answers = [ProviderError("QUOTA_EXCEEDED", "limit")]
    res = c.post(f"/api/assets/{a}/detect", json={"provider_id": "scripted"}, headers=CSRF)
    assert res.status_code == 429 and res.json()["error"]["code"] == "QUOTA_EXCEEDED"
    assert c.post(f"/api/assets/{a}/detect", json={"provider_id": "nope"}, headers=CSRF).status_code == 404


def test_crop_stores_actual_pixels_and_clamps_to_image_edges(ctx) -> None:
    c, pid, provider = ctx
    img = Image.new('RGB', (100, 80), 'red')
    for x in range(50, 100):
        for y in range(80):
            img.putpixel((x, y), (0, 0, 255))
    buf = io.BytesIO(); img.save(buf, 'PNG')
    source = upload(c, pid, buf.getvalue())
    res = c.post(f'/api/assets/{source}/crop', json={'boxes': [
        {'name': 'red', 'x': 0, 'y': 0, 'w': .5, 'h': 1},
        {'name': 'blue', 'x': .5, 'y': .5, 'w': 1, 'h': 1},
    ]}, headers=CSRF)
    assert res.status_code == 200, res.text
    assets = res.json()['assets']
    assert [(a['width'], a['height']) for a in assets] == [(50, 80), (50, 40)]
    assert all(a['project_id'] == pid and a['origin'] == 'crop' for a in assets)
    for asset, color in zip(assets, [(255, 0, 0, 255), (0, 0, 255, 255)]):
        data = c.get(f"/api/assets/{asset['id']}/file").content
        with Image.open(io.BytesIO(data)) as cropped:
            assert cropped.getpixel((0, 0)) == color
    assert provider.models == []  # cropping never invokes AI


@pytest.mark.parametrize('boxes', [[], [{'name': 'x', 'x': 1, 'y': 0, 'w': .2, 'h': .2}],
    [{'name': 'x', 'x': 0, 'y': 0, 'w': 0, 'h': .2}],
    [{'name': 'x', 'x': -.1, 'y': 0, 'w': .2, 'h': .2}]])
def test_crop_rejects_invalid_boxes_without_creating_assets(ctx, boxes) -> None:
    c, pid, _ = ctx
    source = upload(c, pid, png())
    res = c.post(f'/api/assets/{source}/crop', json={'boxes': boxes}, headers=CSRF)
    assert res.status_code == 422
    assert len(c.get(f'/api/projects/{pid}/assets').json()) == 1


def test_crop_refuses_missing_or_deleted_source(ctx) -> None:
    c, pid, _ = ctx
    body = {'boxes': [{'name': 'x', 'x': 0, 'y': 0, 'w': .5, 'h': .5}]}
    assert c.post('/api/assets/missing/crop', json=body, headers=CSRF).status_code == 404
    source = upload(c, pid, png())
    c.post(f'/api/projects/{pid}/assets/delete', json={'asset_ids': [source]}, headers=CSRF)
    assert c.post(f'/api/assets/{source}/crop', json=body, headers=CSRF).status_code == 404


def test_detect_endpoint_uses_only_the_chosen_model_and_rejects_odd_names(ctx) -> None:
    c, pid, provider = ctx
    a = upload(c, pid, png((200, 100)))
    res = c.post(f"/api/assets/{a}/detect", json={"provider_id": "scripted", "model": "my-model.1"}, headers=CSRF)
    assert res.status_code == 200 and res.json()["model"] == "my-model.1"
    assert provider.models == ["my-model.1"]  # no fallback list when a model is chosen
    bad = c.post(f"/api/assets/{a}/detect", json={"provider_id": "scripted", "model": "x y;z"}, headers=CSRF)
    assert bad.status_code == 422 or bad.status_code == 400


def test_effort_defaults_to_max_for_luna_and_low_for_larger_models_unless_chosen() -> None:
    p = Scripted([GOOD, GOOD, GOOD])
    asyncio.run(detect_assets(p, png(), ("gpt-6-luna",)))
    asyncio.run(detect_assets(p, png(), ("gpt-6.1-sol",)))
    asyncio.run(detect_assets(p, png(), ("gpt-6-luna",), effort="medium"))
    assert p.efforts == ["max", "low", "medium"]


def test_detect_endpoint_takes_an_effort_and_rejects_unknown_ones(ctx) -> None:
    c, pid, provider = ctx
    a = upload(c, pid, png((200, 100)))
    res = c.post(f"/api/assets/{a}/detect", json={"provider_id": "scripted", "model": "gpt-6.1-sol", "effort": "high"}, headers=CSRF)
    assert res.status_code == 200 and provider.efforts == ["high"]
    bad = c.post(f"/api/assets/{a}/detect", json={"provider_id": "scripted", "effort": "ultra-mega"}, headers=CSRF)
    assert bad.status_code in (400, 422)
