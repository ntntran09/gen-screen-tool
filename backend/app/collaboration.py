"""Ordered, property-level project edits. One server process owns each room."""
from __future__ import annotations

import asyncio
import copy
import json
import sqlite3
from collections import defaultdict
from typing import Any

from .errors import ApiError
from .schemas import Graph, GraphEdge, GraphNode


def result_fields(node: dict) -> set[str]:
    if node["type"] == "output":
        return {"assetId", "taskId"}
    if node["type"] == "collection" and node["data"].get("role") == "output":
        return {"items", "syncedTaskIds"}
    return set()


def validate_frozen_graph(before: Graph, after: Graph, frozen: set[str]) -> None:
    """The HTTP replacement path must obey the same locks as WebSocket edits."""
    new = {n.id: n.model_dump() for n in after.nodes}
    for node in before.nodes:
        if node.id not in frozen:
            continue
        old, changed = node.model_dump(), new.get(node.id)
        if changed is None:
            raise ApiError(409, "NODE_BUSY", "Generating nodes cannot be deleted.")
        allowed = result_fields(old)
        if not old["data"].get("locked"):
            old.pop("position", None)
            changed = {k: v for k, v in changed.items() if k != "position"}
        old["data"] = {k: v for k, v in old["data"].items() if k not in allowed}
        changed = {**changed, "data": {k: v for k, v in changed["data"].items() if k not in allowed}}
        if old != changed:
            raise ApiError(409, "NODE_BUSY", "This node is generating. Wait for it to finish.")
    protected = lambda graph: {e.id: e for e in graph.edges if e.source in frozen or e.target in frozen}
    if protected(before) != protected(after):
        raise ApiError(409, "NODE_BUSY", "Cannot change connections of a generating node.")


def apply_ops(graph: Graph, ops: list[dict[str, Any]], frozen: set[str] | None = None) -> Graph:
    nodes = {n.id: n.model_dump() for n in graph.nodes}
    edges = {e.id: e.model_dump() for e in graph.edges}
    frozen = frozen or set()
    for op in ops:
        kind, id_ = op.get("kind"), op.get("id")
        if not isinstance(id_, str) or not id_:
            raise ApiError(400, "INVALID_EDIT", "An edit requires an object ID.")
        if kind == "node_add":
            node = GraphNode.model_validate(op.get("node"))
            if node.id != id_:
                raise ApiError(400, "INVALID_EDIT", "Node ID mismatch.")
            if id_ not in nodes:  # a delayed update must not replace a newer object
                nodes[id_] = node.model_dump()
        elif kind == "node_patch":
            if id_ not in nodes:
                continue  # deletion wins over a delayed property edit
            patch = op.get("patch")
            if not isinstance(patch, dict) or set(patch) - {"position", "width", "height", "data", "unset"}:
                raise ApiError(400, "INVALID_EDIT", "Invalid node properties.")
            node = nodes[id_]
            if "data" in patch and not isinstance(patch["data"], dict):
                raise ApiError(400, "INVALID_EDIT", "Invalid node data.")
            if id_ in frozen:
                allowed = result_fields(node)
                properties = {"data"} if node["data"].get("locked") else {"data", "position"}
                if set(patch) - properties or set(patch.get("data", {})) - allowed:
                    raise ApiError(409, "NODE_BUSY", "This node is generating. Wait for it to finish.")
            for key in ("position", "width", "height"):
                if key in patch:
                    node[key] = copy.deepcopy(patch[key])
            if "data" in patch:
                if not isinstance(patch["data"], dict):
                    raise ApiError(400, "INVALID_EDIT", "Invalid node data.")
                node["data"].update(copy.deepcopy(patch["data"]))
            unset = patch.get("unset", [])
            if not isinstance(unset, list) or not all(isinstance(k, str) for k in unset):
                raise ApiError(400, "INVALID_EDIT", "Invalid removed properties.")
            for key in unset:
                node["data"].pop(key, None)
        elif kind == "node_remove":
            if id_ in frozen or any(id_ in (e["source"], e["target"]) and (e["source"] in frozen or e["target"] in frozen) for e in edges.values()):
                raise ApiError(409, "NODE_BUSY", "This node is generating. Wait for it to finish.")
            nodes.pop(id_, None)
            edges = {k: e for k, e in edges.items() if id_ not in (e["source"], e["target"])}
        elif kind == "edge_add":
            edge = GraphEdge.model_validate(op.get("edge"))
            if edge.id != id_:
                raise ApiError(400, "INVALID_EDIT", "Edge ID mismatch.")
            if edge.source in nodes and edge.target in nodes:
                if edge.source in frozen or edge.target in frozen:
                    raise ApiError(409, "NODE_BUSY", "Cannot connect a generating node.")
                edges.setdefault(id_, edge.model_dump())
        elif kind == "edge_remove":
            edge = edges.get(id_)
            if edge and (edge["source"] in frozen or edge["target"] in frozen):
                raise ApiError(409, "NODE_BUSY", "Cannot disconnect a generating node.")
            edges.pop(id_, None)
        else:
            raise ApiError(400, "INVALID_EDIT", "Unknown edit type.")
    return Graph.model_validate({"nodes": list(nodes.values()), "edges": list(edges.values()), "viewport": graph.viewport})


def frozen_nodes(conn: sqlite3.Connection, project_id: str, graph: Graph) -> set[str]:
    batches = conn.execute(
        "SELECT DISTINCT b.id, b.generate_node_id FROM generation_batches b"
        " LEFT JOIN generation_tasks t ON t.batch_id = b.id WHERE b.project_id = ?"
        " AND (b.status IN ('queued', 'running') OR t.status IN ('preparing', 'running', 'cancel_requested'))",
        (project_id,),
    ).fetchall()
    ids = {b["generate_node_id"] for b in batches}
    batch_ids = {b["id"] for b in batches}
    for n in graph.nodes:
        inline = n.data.get("inlineGeneration") or {}
        if (n.data.get("generationId") in batch_ids or batch_ids.intersection(n.data.get("batchIds") or [])
                or inline.get("id") in ids or batch_ids.intersection(inline.get("batchIds") or [])):
            ids.add(n.id)
    return ids


class Rooms:
    def __init__(self) -> None:
        self.locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.peers: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self.documents: dict[str, Graph] = {}

    def publish(self, project_id: str, event: dict) -> None:
        for queue in tuple(self.peers.get(project_id, ())):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # A slow client reconnects to a fresh snapshot, rather than growing RAM.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "reconnect"})


def encoded_ops_size(ops: list[dict]) -> int:
    return len(json.dumps(ops).encode())


def persist_changes(conn: sqlite3.Connection, project_id: str, before: Graph, after: Graph, ts: str) -> None:
    """Write only changed objects; dragging one node never rewrites the canvas."""
    old_nodes, new_nodes = {n.id: n for n in before.nodes}, {n.id: n for n in after.nodes}
    old_edges, new_edges = {e.id: e for e in before.edges}, {e.id: e for e in after.edges}
    for id_, edge in old_edges.items():
        if new_edges.get(id_) != edge:
            conn.execute("DELETE FROM edges WHERE id = ? AND project_id = ?", (id_, project_id))
    for id_ in old_nodes.keys() - new_nodes.keys():
        conn.execute("DELETE FROM nodes WHERE id = ? AND project_id = ?", (id_, project_id))
    for id_, node in new_nodes.items():
        if old_nodes.get(id_) == node:
            continue
        pos = json.dumps({**node.position, "width": node.width, "height": node.height})
        if id_ in old_nodes:
            conn.execute("UPDATE nodes SET position_json = ?, data_json = ?, updated_at = ? WHERE id = ? AND project_id = ?",
                         (pos, json.dumps(node.data), ts, id_, project_id))
        else:
            conn.execute("INSERT INTO nodes (id, project_id, type, position_json, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (id_, project_id, node.type, pos, json.dumps(node.data), ts, ts))
    for id_, edge in new_edges.items():
        if old_edges.get(id_) == edge:
            continue
        # Edges are immutable: replacing one requires an explicit remove/add pair.
        conn.execute("INSERT INTO edges (id, project_id, source_node_id, source_handle, target_node_id, target_handle) VALUES (?, ?, ?, ?, ?, ?)",
                     (id_, project_id, edge.source, edge.sourceHandle, edge.target, edge.targetHandle))
