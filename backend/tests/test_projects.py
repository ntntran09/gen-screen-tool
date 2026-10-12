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
