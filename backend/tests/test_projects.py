from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

CSRF = {"x-nodecanvas-csrf": "1"}


@pytest.fixture
def client(tmp_path: Path):
    app = create_app(
        Settings(workspace_dir=tmp_path / "ws", credentials_dir=tmp_path / "creds", codex_cli_home=tmp_path / "codex")
    )
    with TestClient(app) as c:
        yield c


def _graph():
    return {
        "nodes": [
            {"id": "p1", "type": "prompt", "position": {"x": 0, "y": 0}, "data": {"title": "Prompt", "text": "a flower"}},
            {"id": "g1", "type": "generate", "position": {"x": 300, "y": 0}, "data": {"title": "Generate"}},
        ],
        "edges": [{"id": "e1", "source": "p1", "sourceHandle": "out", "target": "g1", "targetHandle": "prompt"}],
        "viewport": {"x": 10, "y": 20, "zoom": 0.5},
    }


def test_create_save_and_reload_graph(client: TestClient, tmp_path: Path) -> None:
    created = client.post("/api/projects", json={"name": "Flowers"}, headers=CSRF)
    assert created.status_code == 201
    pid = created.json()["id"]
    assert (tmp_path / "ws" / "projects" / pid / "assets").is_dir()

    saved = client.put(f"/api/projects/{pid}", json={"graph": _graph()}, headers=CSRF)
    assert saved.status_code == 200, saved.text

    loaded = client.get(f"/api/projects/{pid}").json()
    assert loaded["name"] == "Flowers"
    assert [n["id"] for n in loaded["graph"]["nodes"]] == ["p1", "g1"]
    assert loaded["graph"]["nodes"][0]["data"]["text"] == "a flower"
    assert loaded["graph"]["edges"][0]["targetHandle"] == "prompt"
    assert loaded["graph"]["viewport"] == {"x": 10, "y": 20, "zoom": 0.5}


def test_graph_with_dangling_edge_is_rejected(client: TestClient) -> None:
    pid = client.post("/api/projects", json={}, headers=CSRF).json()["id"]
    graph = _graph()
    graph["edges"][0]["target"] = "missing"
    res = client.put(f"/api/projects/{pid}", json={"graph": graph}, headers=CSRF)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_INPUT"


def test_unknown_node_type_is_rejected(client: TestClient) -> None:
    pid = client.post("/api/projects", json={}, headers=CSRF).json()["id"]
    graph = _graph()
    graph["nodes"][0]["type"] = "script"
    assert client.put(f"/api/projects/{pid}", json={"graph": graph}, headers=CSRF).status_code == 400


def test_delete_moves_files_aside(client: TestClient, tmp_path: Path) -> None:
    pid = client.post("/api/projects", json={}, headers=CSRF).json()["id"]
    assert client.delete(f"/api/projects/{pid}", headers=CSRF).status_code == 204
    assert client.get(f"/api/projects/{pid}").status_code == 404
    assert not (tmp_path / "ws" / "projects" / pid).exists()
    assert any((tmp_path / "ws" / "backups" / "deleted-projects").iterdir())


def test_mutation_without_csrf_header_is_rejected(client: TestClient) -> None:
    res = client.post("/api/projects", json={})
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "CSRF_REJECTED"


def test_foreign_origin_and_host_are_rejected(client: TestClient) -> None:
    assert client.get("/api/projects", headers={"origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/projects", headers={"host": "evil.example"}).status_code == 403


def test_codex_provider_reports_unknown_capabilities(client: TestClient) -> None:
    providers = client.get("/api/providers").json()
    assert providers[0]["id"] == "codex"
    assert providers[0]["experimental"] is True
    caps = client.get("/api/providers/codex/capabilities").json()
    assert caps["text_to_image"] == "unknown"
    assert caps["verified"] is False


def test_root_redirects_to_frontend(client: TestClient) -> None:
    res = client.get("/", follow_redirects=False)
    assert res.status_code == 307
    assert res.headers["location"] == "http://127.0.0.1:5173"


def test_folded_workflow_nodes_round_trip(client: TestClient) -> None:
    pid = client.post("/api/projects", json={}, headers=CSRF).json()["id"]
    graph = _graph()
    graph["nodes"][0]["data"]["foldedIds"] = ["g1"]  # the owner (a collection in the app) lists what is folded
    graph["nodes"][1]["data"]["groupId"] = "p1"  # folded: hidden in the UI, still a normal node here
    assert client.put(f"/api/projects/{pid}", json={"graph": graph}, headers=CSRF).status_code == 200
    nodes = {n["id"]: n for n in client.get(f"/api/projects/{pid}").json()["graph"]["nodes"]}
    assert nodes["p1"]["data"]["foldedIds"] == ["g1"]
    assert nodes["g1"]["data"]["groupId"] == "p1"


def test_legacy_workflow_node_is_folded_into_its_collection(tmp_path: Path) -> None:
    from app.db import connect, migrate

    settings = Settings(workspace_dir=tmp_path / "ws", credentials_dir=tmp_path / "creds", codex_cli_home=tmp_path / "codex")
    with TestClient(create_app(settings)) as c:
        pid = c.post("/api/projects", json={"name": "Old"}, headers=CSRF).json()["id"]
    conn = connect(settings.database_path)
    now = "2026-01-01T00:00:00+00:00"
    pos = '{"x":0,"y":0,"width":null,"height":null}'

    def node(id_: str, type_: str, data: dict) -> None:
        import json
        conn.execute("INSERT INTO nodes (id, project_id, type, position_json, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                     (id_, pid, type_, pos, json.dumps(data), now, now))

    def edge(id_: str, source: str, target: str, handle: str) -> None:
        conn.execute("INSERT INTO edges (id, project_id, source_node_id, source_handle, target_node_id, target_handle) VALUES (?,?,?,?,?,?)",
                     (id_, pid, source, "out", target, handle))

    node("col", "collection", {"title": "Cropped assets", "role": "input"})
    node("gen", "generate", {"title": "Remove backgrounds", "groupId": "wf"})
    node("pr", "prompt", {"title": "Remove background", "groupId": "wf"})
    node("res", "collection", {"title": "results", "role": "output"})
    node("wf", "workflow", {"title": "Remove backgrounds", "memberIds": ["gen", "pr"], "generateNodeId": "gen"})
    edge("e1", "col", "gen", "original")
    edge("e2", "pr", "gen", "prompt")
    edge("e3", "gen", "res", "in")
    edge("e4", "col", "wf", "original")  # old proxy edges
    edge("e5", "wf", "res", "in")
    before = conn.execute("SELECT graph_revision FROM projects WHERE id = ?", (pid,)).fetchone()[0]
    conn.close()

    migrate(settings.database_path, settings.workspace_dir / "backups")
    migrate(settings.database_path, settings.workspace_dir / "backups")  # idempotent

    with TestClient(create_app(settings)) as c:
        loaded = c.get(f"/api/projects/{pid}").json()
    nodes = {n["id"]: n for n in loaded["graph"]["nodes"]}
    assert "wf" not in nodes
    assert nodes["col"]["data"]["foldedIds"] == ["gen", "pr"]
    assert nodes["gen"]["data"]["groupId"] == "col" and nodes["pr"]["data"]["groupId"] == "col"
    edges = loaded["graph"]["edges"]
    assert not any("wf" in (e["source"], e["target"]) for e in edges)
    assert any(e["source"] == "col" and e["target"] == "res" and e["id"].startswith("wf-col-") for e in edges)  # results hang off the button
    assert any(e["id"] == "e3" for e in edges)  # the real edge stays
    assert list((settings.workspace_dir / "backups").glob("*pre-workflow-fold.sqlite"))
    conn = connect(settings.database_path)
    assert conn.execute("SELECT graph_revision FROM projects WHERE id = ?", (pid,)).fetchone()[0] == before + 1
    conn.close()
