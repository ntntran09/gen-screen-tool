"""Project-room WebSocket transport; origins are checked before accepting."""
from __future__ import annotations

import asyncio
import contextlib
import json
import re
import sqlite3

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from ..collaboration import apply_ops, encoded_ops_size, frozen_nodes, persist_changes
from ..db import connect, now_iso, transaction
from ..errors import ApiError
from .projects import _get_row, _load_graph, _validate_graph

router = APIRouter()


@router.websocket("/api/projects/{project_id}/sync")
async def project_sync(ws: WebSocket, project_id: str) -> None:
    settings, rooms = ws.app.state.settings, ws.app.state.rooms
    client_id = ws.query_params.get("client_id", "")
    resume_id = ws.query_params.get("resume_client_id", "")
    if (ws.headers.get("host", "") not in settings.allowed_hosts
            or ws.headers.get("origin") not in settings.frontend_origins
            or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", client_id)
            or (resume_id and not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", resume_id))):
        await ws.close(code=1008)
        return
    conn = connect(settings.database_path)
    queue: asyncio.Queue = asyncio.Queue(maxsize=128)
    sender = None

    def snapshot() -> dict:
        row = _get_row(conn, project_id)
        graph = rooms.documents.setdefault(project_id, _load_graph(conn, row))
        client = conn.execute("SELECT seq FROM sync_clients WHERE project_id = ? AND client_id = ?", (project_id, client_id)).fetchone()
        resume = conn.execute("SELECT seq FROM sync_clients WHERE project_id = ? AND client_id = ?", (project_id, resume_id)).fetchone() if resume_id else None
        return {"type": "snapshot", "graph": graph.model_dump(), "revision": row["graph_revision"],
                "name": row["name"], "ack_seq": client["seq"] if client else 0,
                "resume_ack_seq": resume["seq"] if resume else 0}

    async def send_events() -> None:
        while True:
            event = await queue.get()
            if event["type"] == "reconnect":
                await ws.close(code=1013)
                return
            await ws.send_json(event)

    try:
        async with rooms.locks[project_id]:
            initial = snapshot()
            await ws.accept()
            rooms.peers[project_id].add(queue)
            queue.put_nowait(initial)
        sender = asyncio.create_task(send_events())
        while True:
            # Bound the decoded protocol even if the ASGI server allows larger frames.
            raw = await ws.receive_text()
            if len(raw.encode()) > 1_000_000:
                await ws.close(code=1009)
                break
            try:
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ValueError("Invalid message.")
                if message.get("type") == "ping":
                    queue.put_nowait({"type": "pong"})
                    continue
                seq, ops = message.get("seq"), message.get("ops")
                if (message.get("type") != "edit" or type(seq) is not int or seq < 1
                        or not isinstance(ops, list) or not 1 <= len(ops) <= 1000
                        or not all(isinstance(op, dict) for op in ops) or encoded_ops_size(ops) > 900_000):
                    raise ValueError("Invalid edit message.")
                async with rooms.locks[project_id]:
                    row = _get_row(conn, project_id)
                    receipt = conn.execute("SELECT seq FROM sync_clients WHERE project_id = ? AND client_id = ?", (project_id, client_id)).fetchone()
                    ack = receipt["seq"] if receipt else 0
                    if seq <= ack:
                        queue.put_nowait(snapshot())
                        continue
                    if seq != ack + 1:
                        raise ApiError(409, "SYNC_SEQUENCE", "Reconnect before sending more changes.")
                    before = rooms.documents.get(project_id) or _load_graph(conn, row)
                    after = apply_ops(before, ops, frozen_nodes(conn, project_id, before))
                    _validate_graph(after)
                    ts, revision = now_iso(), row["graph_revision"] + 1
                    with transaction(conn):
                        persist_changes(conn, project_id, before, after, ts)
                        conn.execute("UPDATE projects SET graph_revision = ?, updated_at = ? WHERE id = ?", (revision, ts, project_id))
                        conn.execute("INSERT INTO sync_clients VALUES (?, ?, ?) ON CONFLICT(project_id, client_id) DO UPDATE SET seq = excluded.seq", (project_id, client_id, seq))
                    rooms.documents[project_id] = after
                    rooms.publish(project_id, {"type": "edit", "client_id": client_id, "seq": seq,
                                               "revision": revision, "ops": ops})
            except (ValueError, TypeError, ValidationError, ApiError, sqlite3.IntegrityError) as exc:
                code = exc.detail["code"] if isinstance(exc, ApiError) else "INVALID_EDIT"
                message = exc.detail["message"] if isinstance(exc, ApiError) else "Invalid canvas edit."
                async with rooms.locks[project_id]:
                    queue.put_nowait({"type": "rejected", "code": code, "message": message, **{k: v for k, v in snapshot().items() if k != "type"}})
    except (WebSocketDisconnect, RuntimeError):
        pass
    except ApiError:
        await ws.close(code=1008)
    finally:
        if sender:
            sender.cancel()
            with contextlib.suppress(asyncio.CancelledError, RuntimeError, WebSocketDisconnect):
                await sender
        rooms.peers[project_id].discard(queue)
        if not rooms.peers[project_id]:
            rooms.peers.pop(project_id, None)
            rooms.documents.pop(project_id, None)
        conn.close()
