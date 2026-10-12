"""Generation endpoints (spec §24.6).

Routes that touch the engine are `async` so they run on the event loop that owns the worker
and the SSE event bus.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..assets import list_assets
from ..config import Settings
from ..db import now_iso, transaction
from ..deps import get_conn, get_settings
from ..errors import ApiError
from ..generation.engine import ACTIVE_TASK, LATEST_ATTEMPTS, RETRYABLE_TASK, GenerationEngine, load_batch, refresh_batch, task_dict
from ..generation.plan import AssetMeta, Plan, PlanError, build_plan
from ..providers import ProviderRegistry
from ..schemas import Graph
from .auth import Registry

router = APIRouter(prefix="/api/generations", tags=["generations"])

Conn = Annotated[sqlite3.Connection, Depends(get_conn)]
Cfg = Annotated[Settings, Depends(get_settings)]


def get_engine(request: Request) -> GenerationEngine:
    return request.app.state.engine


Engine = Annotated[GenerationEngine, Depends(get_engine)]

KEEPALIVE_SECONDS = 15


class PlanBody(BaseModel):
    project_id: str
    generate_node_id: str = Field(min_length=1, max_length=64)
    # The graph as the user sees it when pressing Generate: the immutable snapshot (spec §13.1).
    graph: Graph
    # Chosen by the client so the node that receives the results can be saved before the batch exists.
    batch_id: uuid.UUID | None = None


class RetryBody(BaseModel):
    # Omitted: retry every failed or interrupted task. Given: new attempts for exactly these tasks.
    task_ids: list[str] | None = None


def _project(conn: sqlite3.Connection, project_id: str) -> None:
    if conn.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone() is None:
        raise ApiError(404, "NOT_FOUND", "Project not found.")


def _plan(conn: sqlite3.Connection, settings: Settings, body: PlanBody) -> Plan:
    _project(conn, body.project_id)
    assets = {
        a["id"]: AssetMeta(a["name"], a["missing"], a["width"], a["height"])
        for a in list_assets(conn, settings, body.project_id, include_deleted=True)
    }
    return build_plan(body.graph, body.generate_node_id, assets, max_input_images=settings.max_input_images)


def _capability_errors(plan: Plan, registry: ProviderRegistry) -> list[tuple[str, str]]:
    provider = registry.get(plan.provider_id)
    if provider is None:
        return [("PROVIDER_UNAVAILABLE", f"Unknown provider '{plan.provider_id}'.")]
    caps = provider.get_capabilities()
    errors: list[tuple[str, str]] = []
    ops = {t.operation for t in plan.tasks}
    # "unknown" is allowed and shown as unverified; only a known "unsupported" blocks (spec §19.6).
    if "generate" in ops and caps.text_to_image == "unsupported":
        errors.append(("UNSUPPORTED_CAPABILITY", f"{provider.name} cannot create images from text only."))
    if "edit" in ops and caps.image_editing == "unsupported":
        errors.append(("UNSUPPORTED_CAPABILITY", f"{provider.name} cannot work from input images."))
    images = max(
        (
            bool(t.original_asset_id) + len(t.extra_original_asset_ids) + len(t.theme_asset_ids) + len(t.reference_asset_ids)
            for t in plan.tasks
        ),
        default=0,
    )
    if caps.max_reference_images is not None and images > caps.max_reference_images:
        errors.append(
            ("REFERENCE_LIMIT_EXCEEDED", f"{provider.name} accepts at most {caps.max_reference_images} images per request; this needs {images}.")
        )
    return errors


@router.post("/preview")
async def preview(body: PlanBody, conn: Conn, settings: Cfg, registry: Registry) -> dict[str, Any]:
    """Preview Request (spec §14.4): compiled prompt per task, inputs, settings and total."""
    try:
        plan = _plan(conn, settings, body)
    except PlanError as exc:
        return {"ok": False, "errors": exc.errors, "total_tasks": 0, "tasks": []}
    provider = registry.get(plan.provider_id)
    cap_errors = _capability_errors(plan, registry)
    return {
        "ok": not cap_errors,
        "errors": [m for _, m in cap_errors],
        "provider": None
        if provider is None
        else {
            "id": provider.id,
            "name": provider.name,
            "experimental": provider.experimental,
            "auth_state": await provider.check_auth(),
            "capabilities": asdict(provider.get_capabilities()),
        },
        "mode": plan.mode,
        "settings": plan.settings,
        "theme_asset_ids": plan.theme_asset_ids,
        "reference_asset_ids": plan.reference_asset_ids,
        "palette": plan.palette,
        "total_tasks": len(plan.tasks),
        "tasks": [
            {
                "slot_index": t.slot_index,
                "variant_index": t.variant_index,
                "source_asset_id": t.original_asset_id,
                "extra_original_asset_ids": t.extra_original_asset_ids,
                "source_name": t.source.name if t.source else None,
                "operation": t.operation,
                "aspect_ratio": t.aspect_ratio,
                "prompt": t.prompt,
            }
            for t in plan.tasks
        ],
    }


@router.post("", status_code=201)
async def create(body: PlanBody, conn: Conn, settings: Cfg, registry: Registry, engine: Engine) -> dict[str, Any]:
    try:
        plan = _plan(conn, settings, body)
    except PlanError as exc:
        raise ApiError(400, "INVALID_INPUT", exc.errors[0], errors=exc.errors) from None
    cap_errors = _capability_errors(plan, registry)
    if cap_errors:
        raise ApiError(400, cap_errors[0][0], cap_errors[0][1], errors=[m for _, m in cap_errors])
    provider = registry.get(plan.provider_id)
    assert provider is not None
    if await provider.check_auth() != "connected":
        raise ApiError(409, "AUTH_REQUIRED", f"Connect {provider.name} before generating.")
    busy = conn.execute(
        "SELECT 1 FROM generation_batches WHERE project_id = ? AND generate_node_id = ? AND status IN ('queued', 'running')",
        (body.project_id, plan.generate_node_id),
    ).fetchone()
    if busy:
        raise ApiError(409, "BATCH_ACTIVE", "This Generate node already has a batch running. Cancel it or wait.")

    batch_id = str(body.batch_id or uuid.uuid4())
    if conn.execute("SELECT 1 FROM generation_batches WHERE id = ?", (batch_id,)).fetchone():
        raise ApiError(409, "BATCH_EXISTS", "A generation with this id already exists.")
    ts = now_iso()
    snapshot = {
        "graph": body.graph.model_dump(),
        "settings": plan.settings,
        "palette": plan.palette,
        "theme_asset_ids": plan.theme_asset_ids,
        "reference_asset_ids": plan.reference_asset_ids,
        "source_asset_ids": [s.asset_id for s in plan.sources],
    }
    with transaction(conn):
        conn.execute(
            "INSERT INTO generation_batches (id, project_id, generate_node_id, mode, expected_count, status,"
            " snapshot_json, created_at, provider_id, name) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
            (batch_id, body.project_id, plan.generate_node_id, plan.mode, len(plan.tasks), json.dumps(snapshot), ts,
             plan.provider_id, plan.name),
        )
        conn.executemany(
            "INSERT INTO generation_tasks (id, batch_id, source_asset_id, variant_index, status, prompt_snapshot,"
            " provider_request_json, created_at, slot_index, source_name) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
            [
                (
                    str(uuid.uuid4()),
                    batch_id,
                    t.original_asset_id,
                    t.variant_index,
                    t.prompt,
                    json.dumps(
                        {
                            "operation": t.operation,
                            "original_asset_id": t.original_asset_id,
                            "extra_original_asset_ids": t.extra_original_asset_ids,
                            "theme_asset_ids": t.theme_asset_ids,
                            "reference_asset_ids": t.reference_asset_ids,
                            "settings": {**plan.settings, "aspect_ratio": t.aspect_ratio},
                        }
                    ),
                    ts,
                    t.slot_index,
                    t.source.name if t.source else None,
                )
                for t in plan.tasks
            ],
        )
    engine.publish_batch(conn, batch_id)
    engine.wake()
    return {"batch": load_batch(conn, batch_id), "tasks": _tasks(conn, batch_id)}


def _batch_or_404(conn: sqlite3.Connection, batch_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM generation_batches WHERE id = ?", (batch_id,)).fetchone()
    if row is None:
        raise ApiError(404, "NOT_FOUND", "Generation not found.")
    return row


def _tasks(conn: sqlite3.Connection, batch_id: str) -> list[dict[str, Any]]:
    pid = _batch_or_404(conn, batch_id)["project_id"]
    rows = conn.execute(
        "SELECT * FROM generation_tasks WHERE batch_id = ? ORDER BY slot_index, attempt_number", (batch_id,)
    )
    return [task_dict(r, pid) for r in rows]


@router.get("")
def list_batches(project_id: str, conn: Conn, limit: int = 50) -> list[dict[str, Any]]:
    _project(conn, project_id)
    ids = [
        r[0]
        for r in conn.execute(
            "SELECT id FROM generation_batches WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
            (project_id, max(1, min(limit, 200))),
        )
    ]
    return [b for b in (load_batch(conn, i) for i in ids) if b]


@router.get("/events")
async def events(project_id: str, request: Request, engine: Engine) -> StreamingResponse:
    """Server-sent events for one project's batches and tasks."""
    queue = engine.bus.subscribe()

    async def stream():  # type: ignore[no-untyped-def]
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                except TimeoutError:
                    if await request.is_disconnected():
                        return
                    yield ": keepalive\n\n"
                    continue
                if event.get("project_id") == project_id:
                    yield f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
        finally:
            engine.bus.unsubscribe(queue)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@router.get("/{batch_id}")
def get_batch(batch_id: str, conn: Conn) -> dict[str, Any]:
    _batch_or_404(conn, batch_id)
    return load_batch(conn, batch_id)  # type: ignore[return-value]


@router.get("/{batch_id}/tasks")
def get_tasks(batch_id: str, conn: Conn) -> list[dict[str, Any]]:
    return _tasks(conn, batch_id)


@router.post("/{batch_id}/cancel")
async def cancel(batch_id: str, conn: Conn, engine: Engine) -> dict[str, Any]:
    """Stop scheduling; keep finished outputs (spec §13.6)."""
    _batch_or_404(conn, batch_id)
    ts = now_iso()
    with transaction(conn):
        conn.execute("UPDATE generation_batches SET cancel_requested = 1 WHERE id = ?", (batch_id,))
        changed = [
            r[0]
            for r in conn.execute(
                "SELECT id FROM generation_tasks WHERE batch_id = ? AND status IN ('queued', 'preparing', 'running')",
                (batch_id,),
            )
        ]
        conn.execute(
            "UPDATE generation_tasks SET status = 'cancelled', finished_at = ? WHERE batch_id = ? AND status = 'queued'",
            (ts, batch_id),
        )
        running = conn.execute(
            "UPDATE generation_tasks SET status = 'cancel_requested' WHERE batch_id = ? AND status IN ('preparing', 'running')",
            (batch_id,),
        ).rowcount
        refresh_batch(conn, batch_id)
    for task_id in changed:
        engine.publish_task(conn, task_id)
    engine.publish_batch(conn, batch_id)
    note = (
        "The request already sent cannot be stopped on the provider's side; its image will be kept if it arrives."
        if running
        else None
    )
    return {"batch": load_batch(conn, batch_id), "note": note}


def _requeue(conn: sqlite3.Connection, batch_id: str) -> None:
    conn.execute(
        "UPDATE generation_batches SET status = CASE WHEN status = 'running' THEN 'running' ELSE 'queued' END,"
        " status_reason = NULL, cancel_requested = 0, finished_at = NULL WHERE id = ?",
        (batch_id,),
    )


@router.post("/{batch_id}/retry")
async def retry(batch_id: str, body: RetryBody, conn: Conn, engine: Engine) -> dict[str, Any]:
    """New attempts for failed tasks, or for the chosen ones (spec §13.5). Old attempts stay in history."""
    _batch_or_404(conn, batch_id)
    latest = {r["id"]: r for r in conn.execute(LATEST_ATTEMPTS, (batch_id,)).fetchall()}
    if body.task_ids is None:
        targets = [r for r in latest.values() if r["status"] in RETRYABLE_TASK]
    else:
        unknown = [t for t in body.task_ids if t not in latest]
        if unknown:
            raise ApiError(400, "INVALID_INPUT", "Only the latest attempt of a task can be retried.")
        targets = [latest[t] for t in body.task_ids]
        if any(r["status"] in ACTIVE_TASK for r in targets):
            raise ApiError(409, "TASK_ACTIVE", "A selected task is still queued or running.")
    if not targets:
        raise ApiError(400, "NOTHING_TO_RETRY", "There are no failed tasks to retry.")
    ts = now_iso()
    new_ids = []
    with transaction(conn):
        for r in targets:
            new_id = str(uuid.uuid4())
            new_ids.append(new_id)
            conn.execute(
                "INSERT INTO generation_tasks (id, batch_id, source_asset_id, variant_index, status, prompt_snapshot,"
                " provider_request_json, attempt_number, created_at, slot_index, source_name)"
                " VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
                (new_id, batch_id, r["source_asset_id"], r["variant_index"], r["prompt_snapshot"], r["provider_request_json"],
                 r["attempt_number"] + 1, ts, r["slot_index"], r["source_name"]),
            )
        _requeue(conn, batch_id)
        refresh_batch(conn, batch_id)
    for task_id in new_ids:
        engine.publish_task(conn, task_id)
    engine.publish_batch(conn, batch_id)
    engine.wake()
    return {"batch": load_batch(conn, batch_id), "retried": len(new_ids)}


@router.post("/{batch_id}/resume")
async def resume(batch_id: str, conn: Conn, engine: Engine) -> dict[str, Any]:
    """Continue unfinished tasks: queued ones, and cancelled ones that were never sent (spec §13.7).

    Interrupted tasks are not resent automatically because their result is unknown; use Retry.
    """
    _batch_or_404(conn, batch_id)
    latest = conn.execute(LATEST_ATTEMPTS, (batch_id,)).fetchall()
    revived = [r["id"] for r in latest if r["status"] == "cancelled"]
    if not revived and not any(r["status"] == "queued" for r in latest):
        raise ApiError(400, "NOTHING_TO_RESUME", "No unfinished tasks to resume. Use Retry for failed or interrupted ones.")
    with transaction(conn):
        conn.executemany(
            "UPDATE generation_tasks SET status = 'queued', finished_at = NULL WHERE id = ?", [(i,) for i in revived]
        )
        _requeue(conn, batch_id)
        refresh_batch(conn, batch_id)
    for task_id in revived:
        engine.publish_task(conn, task_id)
    engine.publish_batch(conn, batch_id)
    engine.wake()
    return {"batch": load_batch(conn, batch_id)}
