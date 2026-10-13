from __future__ import annotations

import threading

import pytest
from starlette.websockets import WebSocketDisconnect

from tests.test_projects import client, _graph, CSRF
from tests.test_generation import FakeProvider, solo_graph, start, wait
from app.providers import ProviderRegistry

ORIGIN = {"origin": "http://127.0.0.1:5173"}


def room(c, pid, who="client-one", **kwargs):
    return c.websocket_connect(f"/api/projects/{pid}/sync?client_id={who}", headers=ORIGIN, **kwargs)


def setup(c, prefix=""):
    pid = c.post("/api/projects", json={}, headers=CSRF).json()["id"]
    graph = _graph()
    for n in graph["nodes"]:
        n["id"] = prefix + n["id"]
    for e in graph["edges"]:
        for key in ("id", "source", "target"):
            e[key] = prefix + e[key]
    assert c.put(f"/api/projects/{pid}", json={"graph": graph}, headers=CSRF).status_code == 200
    return pid


def edit(ws, seq, ops):
    ws.send_json({"type": "edit", "seq": seq, "ops": ops})
    return ws.receive_json()


def test_room_broadcasts_property_edits_and_preserves_unrelated_fields(client):
    pid = setup(client)
    with room(client, pid) as a, room(client, pid, "client-two") as b:
        assert a.receive_json()["revision"] == b.receive_json()["revision"] == 1
        event = edit(a, 1, [{"kind": "node_patch", "id": "p1", "patch": {"data": {"text": "pink"}}}])
        assert event["revision"] == 2 and b.receive_json() == event
        event = edit(b, 1, [{"kind": "node_patch", "id": "p1", "patch": {"position": {"x": 42, "y": 19}}}])
        assert event["revision"] == 3 and a.receive_json() == event
    graph = client.get(f"/api/projects/{pid}").json()["graph"]
    assert graph["nodes"][0]["position"] == {"x": 42, "y": 19}
    assert graph["nodes"][0]["data"]["text"] == "pink"


def test_last_received_property_wins_and_room_isolation(client):
    pid, other = setup(client), setup(client, "other-")
    with room(client, pid) as a, room(client, pid, "client-two") as b, room(client, other, "other-client") as c:
        a.receive_json(); b.receive_json(); c.receive_json()
        edit(a, 1, [{"kind": "node_patch", "id": "p1", "patch": {"data": {"text": "A"}}}]); b.receive_json()
        edit(b, 1, [{"kind": "node_patch", "id": "p1", "patch": {"data": {"text": "B"}}}]); a.receive_json()
        c.send_json({"type": "ping"})
        assert c.receive_json() == {"type": "pong"}
    assert client.get(f"/api/projects/{pid}").json()["graph"]["nodes"][0]["data"]["text"] == "B"
    assert client.get(f"/api/projects/{other}").json()["graph"]["nodes"][0]["data"]["text"] == "a flower"


def test_duplicate_edit_is_not_applied_again_after_reconnect(client):
    pid = setup(client)
    ops = [{"kind": "node_patch", "id": "p1", "patch": {"data": {"text": "old edit"}}}]
    with room(client, pid) as a:
        a.receive_json()
        assert edit(a, 1, ops)["revision"] == 2
    with room(client, pid, "client-two") as b:
        b.receive_json()
        edit(b, 1, [{"kind": "node_patch", "id": "p1", "patch": {"data": {"text": "new edit"}}}])
    with room(client, pid) as a:
        snapshot = a.receive_json()
        assert snapshot["ack_seq"] == 1 and snapshot["revision"] == 3
        response = edit(a, 1, ops)
        assert response["type"] == "snapshot" and response["revision"] == 3
        assert response["graph"]["nodes"][0]["data"]["text"] == "new edit"
    with client.websocket_connect(f"/api/projects/{pid}/sync?client_id=fresh-page&resume_client_id=client-one", headers=ORIGIN) as a:
        snapshot = a.receive_json()
        assert snapshot["ack_seq"] == 0 and snapshot["resume_ack_seq"] == 1


def test_atomic_validation_and_deleted_nodes_do_not_resurrect(client):
    pid = setup(client)
    with room(client, pid) as a:
        a.receive_json()
        response = edit(a, 1, [{"kind": "node_patch", "id": "p1", "patch": {"data": {"text": "bad"}}}, {"kind": "oops", "id": "p1"}])
        assert response["type"] == "rejected" and response["ack_seq"] == 0
        assert response["graph"]["nodes"][0]["data"]["text"] == "a flower"
        edit(a, 1, [{"kind": "node_remove", "id": "p1"}])
        edit(a, 2, [{"kind": "node_patch", "id": "p1", "patch": {"data": {"text": "late"}}}])
    graph = client.get(f"/api/projects/{pid}").json()["graph"]
    assert [n["id"] for n in graph["nodes"]] == ["g1"] and graph["edges"] == []


def test_rest_save_requires_current_revision_and_broadcasts(client):
    pid = setup(client)
    with room(client, pid) as a:
        a.receive_json()
        response = client.put(f"/api/projects/{pid}", json={"graph": _graph()}, headers=CSRF)
        assert response.status_code == 409
        response = client.put(f"/api/projects/{pid}", json={"graph": _graph(), "graph_revision": 1}, headers=CSRF)
        assert response.status_code == 200
        assert a.receive_json()["revision"] == 2
        client.put(f"/api/projects/{pid}", json={"name": "Renamed"}, headers=CSRF)
        assert a.receive_json() == {"type": "name", "name": "Renamed"}


def test_deleted_project_notifies_other_tabs(client):
    pid = setup(client)
    with room(client, pid) as a:
        a.receive_json()
        assert client.delete(f"/api/projects/{pid}", headers=CSRF).status_code == 204
        assert a.receive_json() == {"type": "deleted"}


def test_text_and_drawing_annotations_sync_and_reload(client):
    pid = setup(client)
    annotations = [
        {"id": "label", "type": "text", "position": {"x": 20, "y": 30}, "data": {"text": "Review this", "color": "#1a1a1a", "fontSize": 24}},
        {"id": "stroke", "type": "drawing", "position": {"x": 40, "y": 50}, "data": {"points": [{"x": 3, "y": 3}, {"x": 30, "y": 20}], "color": "#1a1a1a", "strokeWidth": 3, "canvasWidth": 33, "canvasHeight": 23}},
    ]
    with room(client, pid) as a, room(client, pid, "client-two") as b:
        a.receive_json(); b.receive_json()
        event = edit(a, 1, [{"kind": "node_add", "id": n["id"], "node": n} for n in annotations])
        assert event["type"] == "edit" and b.receive_json() == event
    loaded = client.get(f"/api/projects/{pid}").json()["graph"]["nodes"]
    assert loaded[-2:][0]["data"]["text"] == "Review this"
    assert loaded[-1]["data"]["points"] == annotations[-1]["data"]["points"]


@pytest.mark.parametrize("headers", [{}, {"origin": "https://evil.example"}, {**ORIGIN, "host": "evil.example"}])
def test_websocket_origin_and_host_guards(client, headers):
    pid = setup(client)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/projects/{pid}/sync?client_id=client-one", headers=headers):
            pass


def test_running_node_and_result_cannot_be_deleted_by_another_tab(client):
    fake = FakeProvider()
    client.app.state.providers = ProviderRegistry([fake])
    pid = client.post("/api/projects", json={}, headers=CSRF).json()["id"]
    graph = solo_graph(client, pid)
    assert client.put(f"/api/projects/{pid}", json={"graph": graph}, headers=CSRF).status_code == 200
    fake.gate = threading.Event()
    try:
        batch_id = start(client, pid, graph).json()["batch"]["id"]
        with room(client, pid) as a:
            a.receive_json()
            response = edit(a, 1, [{"kind": "node_remove", "id": "g"}])
            assert response["code"] == "NODE_BUSY"
            changed = client.get(f"/api/projects/{pid}").json()
            for node in changed["graph"]["nodes"]:
                if node["id"] == "g":
                    node["position"]["x"] += 100
            response = client.put(f"/api/projects/{pid}", json={"graph": changed["graph"], "graph_revision": changed["graph_revision"]}, headers=CSRF)
            assert response.status_code == 200
            assert a.receive_json()["type"] == "snapshot"
            result = {"id": "result", "type": "output", "position": {"x": 600, "y": 0}, "data": {"generationId": batch_id}}
            assert edit(a, 1, [{"kind": "node_add", "id": "result", "node": result}])["type"] == "edit"
            response = edit(a, 2, [{"kind": "node_patch", "id": "result", "patch": {"position": {"x": 700, "y": 100}}}])
            assert response["type"] == "edit"
            response = edit(a, 3, [{"kind": "node_patch", "id": "g", "patch": {"data": {"outputCount": 9}}}])
            assert response["code"] == "NODE_BUSY"
            response = edit(a, 3, [{"kind": "node_remove", "id": "result"}])
            assert response["code"] == "NODE_BUSY"
            response = client.put(f"/api/projects/{pid}", json={"graph": {"nodes": [], "edges": []}, "graph_revision": 4}, headers=CSRF)
            assert response.status_code == 409
    finally:
        fake.gate.set()
    wait(client, batch_id)
    with room(client, pid) as a:
        a.receive_json()
        assert edit(a, 3, [{"kind": "node_remove", "id": "result"}])["type"] == "edit"
