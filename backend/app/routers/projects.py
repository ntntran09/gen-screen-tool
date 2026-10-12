"""Project CRUD and graph persistence (spec §18, §24.3)."""

from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Response

from ..config import Settings
from ..db import now_iso, transaction
from ..deps import get_conn, get_settings
from ..errors import ApiError
from ..schemas import (
    NODE_TYPES,
    Graph,
    GraphEdge,
    GraphNode,
    ProjectCreate,
    ProjectDetail,
    ProjectSummary,
    ProjectUpdate,
    Viewport,
)

router = APIRouter(prefix="/api/projects", tags=["projects"])

Conn = Annotated[sqlite3.Connection, Depends(get_conn)]
Cfg = Annotated[Settings, Depends(get_settings)]


def _summary(row: sqlite3.Row) -> ProjectSummary:
    return ProjectSummary(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _get_row(conn: sqlite3.Connection, project_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        raise ApiError(404, "NOT_FOUND", "Project not found.")
    return row


def _load_graph(conn: sqlite3.Connection, row: sqlite3.Row) -> Graph:
    nodes = []
    for n in conn.execute("SELECT * FROM nodes WHERE project_id = ? ORDER BY rowid", (row["id"],)):
        pos = json.loads(n["position_json"])
        nodes.append(
            GraphNode(
                id=n["id"],
                type=n["type"],
                position={"x": pos["x"], "y": pos["y"]},
                width=pos.get("width"),
                height=pos.get("height"),
                data=json.loads(n["data_json"]),
            )
        )
    edges = [
        GraphEdge(
            id=e["id"],
            source=e["source_node_id"],
            sourceHandle=e["source_handle"],
            target=e["target_node_id"],
            targetHandle=e["target_handle"],
        )
        for e in conn.execute("SELECT * FROM edges WHERE project_id = ? ORDER BY rowid", (row["id"],))
    ]
    return Graph(nodes=nodes, edges=edges, viewport=Viewport(**json.loads(row["viewport_json"])))


def _validate_graph(graph: Graph) -> None:
    ids = set()
    for node in graph.nodes:
        if node.type not in NODE_TYPES:
            raise ApiError(400, "INVALID_INPUT", f"Unknown node type '{node.type}'.")
        if node.id in ids:
            raise ApiError(400, "INVALID_INPUT", f"Duplicate node id '{node.id}'.")
        ids.add(node.id)
    for edge in graph.edges:
        if edge.source not in ids or edge.target not in ids:
            raise ApiError(400, "INVALID_INPUT", f"Edge '{edge.id}' references a missing node.")


def _save_graph(conn: sqlite3.Connection, project_id: str, graph: Graph, ts: str) -> None:
    existing = {
        r["id"]: r["created_at"]
        for r in conn.execute("SELECT id, created_at FROM nodes WHERE project_id = ?", (project_id,))
    }
    conn.execute("DELETE FROM edges WHERE project_id = ?", (project_id,))
    conn.execute("DELETE FROM nodes WHERE project_id = ?", (project_id,))
    conn.executemany(
        "INSERT INTO nodes (id, project_id, type, position_json, data_json, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (
                n.id,
                project_id,
                n.type,
                json.dumps({"x": n.position.get("x", 0), "y": n.position.get("y", 0), "width": n.width, "height": n.height}),
                json.dumps(n.data),
                existing.get(n.id, ts),
                ts,
            )
            for n in graph.nodes
        ],
    )
    conn.executemany(
        "INSERT INTO edges (id, project_id, source_node_id, source_handle, target_node_id, target_handle) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [(e.id, project_id, e.source, e.sourceHandle, e.target, e.targetHandle) for e in graph.edges],
    )
    conn.execute(
        "UPDATE projects SET viewport_json = ? WHERE id = ?",
        (graph.viewport.model_dump_json(), project_id),
    )


@router.get("", response_model=list[ProjectSummary])
def list_projects(conn: Conn) -> list[ProjectSummary]:
    return [_summary(r) for r in conn.execute("SELECT * FROM projects ORDER BY updated_at DESC")]


@router.post("", response_model=ProjectDetail, status_code=201)
def create_project(body: ProjectCreate, conn: Conn, settings: Cfg) -> ProjectDetail:
    project_id = str(uuid.uuid4())
    ts = now_iso()
    with transaction(conn):
        conn.execute(
            "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (project_id, body.name, body.description, ts, ts),
        )
    project_dir = settings.workspace_dir / "projects" / project_id
    for sub in ("assets", "outputs", "thumbnails", "exports"):
        (project_dir / sub).mkdir(parents=True, exist_ok=True)
    row = _get_row(conn, project_id)
    return ProjectDetail(**_summary(row).model_dump(), graph=_load_graph(conn, row))


@router.get("/{project_id}", response_model=ProjectDetail)
def get_project(project_id: str, conn: Conn) -> ProjectDetail:
    row = _get_row(conn, project_id)
    return ProjectDetail(**_summary(row).model_dump(), graph=_load_graph(conn, row))


@router.put("/{project_id}", response_model=ProjectSummary)
def update_project(project_id: str, body: ProjectUpdate, conn: Conn) -> ProjectSummary:
    if body.graph is not None:
        _validate_graph(body.graph)
    ts = now_iso()
    with transaction(conn):
        _get_row(conn, project_id)
        if body.name is not None:
            conn.execute("UPDATE projects SET name = ? WHERE id = ?", (body.name, project_id))
        if body.description is not None:
            conn.execute("UPDATE projects SET description = ? WHERE id = ?", (body.description, project_id))
        if body.graph is not None:
            _save_graph(conn, project_id, body.graph, ts)
        conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (ts, project_id))
    return _summary(_get_row(conn, project_id))


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str, conn: Conn, settings: Cfg) -> Response:
    with transaction(conn):
        _get_row(conn, project_id)
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    # Files are moved aside rather than erased so a mistaken delete stays recoverable.
    # project_id is a DB-validated UUID, so this path cannot escape the workspace.
    safe_id = str(uuid.UUID(project_id))
    project_dir = settings.workspace_dir / "projects" / safe_id
    if project_dir.is_dir():
        trash = settings.workspace_dir / "backups" / "deleted-projects"
        trash.mkdir(parents=True, exist_ok=True)
        stamp = now_iso().replace(":", "").replace("+", "_")
        shutil.move(project_dir, trash / f"{safe_id}-{stamp}")
    return Response(status_code=204)
