"""Batch queue and worker (spec §13, §20.1).

One in-process worker runs tasks strictly one at a time (spec §13.4: sequential by default).
Every state change is written to SQLite first and then broadcast to SSE subscribers, so a
browser refresh or an app restart can always rebuild progress from the database.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sqlite3
from collections.abc import Callable, Iterator
from typing import Any

from ..assets import AssetError, asset_file, get_asset_row, import_image, sanitize_display_name
from ..config import Settings
from ..db import connect, now_iso, transaction
from ..providers import ProviderError, ProviderRegistry
from ..providers.base import GenerateRequest

log = logging.getLogger("nodecanvas.generation")

ACTIVE_TASK = ("queued", "preparing", "running", "cancel_requested")
RUNNING_TASK = ("preparing", "running", "cancel_requested")
RETRYABLE_TASK = ("failed", "interrupted")
# Errors that will hit every following task too: stop scheduling and wait for the user (spec §29.4, §29.5).
PAUSE_CODES = {"AUTH_REQUIRED", "AUTH_EXPIRED", "PERMISSION_DENIED", "RATE_LIMITED", "QUOTA_EXCEEDED", "PROVIDER_UNAVAILABLE"}
PAUSE_REASON = {
    "AUTH_REQUIRED": "Paused: the provider is not connected. Connect it, then Resume.",
    "AUTH_EXPIRED": "Paused: the provider session expired. Connect again, then Resume.",
    "PERMISSION_DENIED": "Paused: the account cannot use image generation. Resume after fixing access.",
    "RATE_LIMITED": "Paused: rate limited by the provider. Wait a while, then Resume.",
    "QUOTA_EXCEEDED": "Paused: usage limit reached. Resume once your quota resets.",
    "PROVIDER_UNAVAILABLE": "Paused: the provider is unavailable. Resume later.",
}

LATEST_ATTEMPTS = """
    SELECT t.* FROM generation_tasks t
    WHERE t.batch_id = ? AND t.attempt_number = (
        SELECT MAX(attempt_number) FROM generation_tasks o WHERE o.batch_id = t.batch_id AND o.slot_index = t.slot_index
    )
    ORDER BY t.slot_index
"""


class EventBus:
    """Fan-out of generation events to SSE subscribers. Use from the event loop thread only."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def publish(self, event: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            with contextlib.suppress(asyncio.QueueFull):  # a stalled client re-syncs from the API
                queue.put_nowait(event)


def batch_dict(row: sqlite3.Row, active: int = 0) -> dict[str, Any]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "generate_node_id": row["generate_node_id"],
        "name": row["name"],
        "provider_id": row["provider_id"],
        "mode": row["mode"],
        "status": row["status"],
        "status_reason": row["status_reason"],
        "expected_count": row["expected_count"],
        "completed_count": row["completed_count"],
        "failed_count": row["failed_count"],
        "cancelled_count": row["cancelled_count"],
        "active_count": active,
        "cancel_requested": bool(row["cancel_requested"]),
        "created_at": row["created_at"],
        "finished_at": row["finished_at"],
    }


def task_dict(row: sqlite3.Row, project_id: str) -> dict[str, Any]:
    return {
        "id": row["id"],
        "batch_id": row["batch_id"],
        "project_id": project_id,
        "slot_index": row["slot_index"],
        "attempt_number": row["attempt_number"],
        "variant_index": row["variant_index"],
        "source_asset_id": row["source_asset_id"],
        "source_name": row["source_name"],
        "status": row["status"],
        "prompt": row["prompt_snapshot"],
        "request": json.loads(row["provider_request_json"]),
        "output_asset_id": row["output_asset_id"],
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
        "error_code": row["error_code"],
        "error_message": row["error_message"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


def refresh_batch(conn: sqlite3.Connection, batch_id: str) -> int:
    """Recount the latest attempt of every slot and settle the batch status. Returns active count."""
    batch = conn.execute("SELECT * FROM generation_batches WHERE id = ?", (batch_id,)).fetchone()
    latest = conn.execute(LATEST_ATTEMPTS, (batch_id,)).fetchall()
    statuses = [t["status"] for t in latest]
    completed = statuses.count("completed")
    failed = sum(statuses.count(s) for s in RETRYABLE_TASK)
    cancelled = statuses.count("cancelled")
    active = sum(statuses.count(s) for s in ACTIVE_TASK)
    status, finished = batch["status"], batch["finished_at"]
    reason = batch["status_reason"]
    if any(s in RUNNING_TASK for s in statuses):
        status, finished = "running", None
    elif active:
        finished = None  # queued work left: keep queued/running/paused/interrupted as set
    else:
        if batch["cancel_requested"]:
            status = "cancelled"
        elif completed == len(latest):
            status = "completed"
        elif completed == 0:
            status = "failed" if failed else "cancelled"
        else:
            status = "partially_completed"
        finished = finished or now_iso()
        if status in ("completed",):
            reason = None
    conn.execute(
        "UPDATE generation_batches SET status = ?, status_reason = ?, completed_count = ?, failed_count = ?,"
        " cancelled_count = ?, finished_at = ? WHERE id = ?",
        (status, reason, completed, failed, cancelled, finished, batch_id),
    )
    return active


def load_batch(conn: sqlite3.Connection, batch_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM generation_batches WHERE id = ?", (batch_id,)).fetchone()
    if row is None:
        return None
    latest = conn.execute(LATEST_ATTEMPTS, (batch_id,)).fetchall()
    return batch_dict(row, sum(1 for t in latest if t["status"] in ACTIVE_TASK))


class GenerationEngine:
    def __init__(self, settings: Settings, registry: Callable[[], ProviderRegistry]) -> None:
        self.settings = settings
        self._registry = registry
        self.bus = EventBus()
        self._wake = asyncio.Event()
        self._worker: asyncio.Task[None] | None = None

    @contextlib.contextmanager
    def db(self) -> Iterator[sqlite3.Connection]:
        conn = connect(self.settings.database_path)
        try:
            yield conn
        finally:
            conn.close()

    # --- lifecycle -------------------------------------------------------------------------

    def start(self) -> None:
        self.recover()
        self._wake = asyncio.Event()  # bind to the running loop
        self._worker = asyncio.create_task(self._run(), name="generation-worker")

    async def stop(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None

    def wake(self) -> None:
        self._wake.set()

    def recover(self) -> None:
        """After a restart, requests that were in flight have an unknown result (spec §13.7)."""
        with self.db() as conn, transaction(conn):
            conn.execute(
                "UPDATE generation_tasks SET status = 'interrupted', error_code = 'INTERRUPTED', error_message = ?,"
                " finished_at = ? WHERE status IN ('preparing', 'running', 'cancel_requested')",
                ("NodeCanvas closed while this request was running. Its result is unknown.", now_iso()),
            )
            for (batch_id,) in conn.execute(
                "SELECT id FROM generation_batches WHERE status IN ('queued', 'running')"
            ).fetchall():
                if refresh_batch(conn, batch_id):
                    conn.execute(
                        "UPDATE generation_batches SET status = 'interrupted', status_reason = ? WHERE id = ?",
                        ("NodeCanvas was closed during this batch. Resume to continue the remaining tasks.", batch_id),
                    )

    # --- events ----------------------------------------------------------------------------

    def publish_batch(self, conn: sqlite3.Connection, batch_id: str) -> None:
        batch = load_batch(conn, batch_id)
        if batch:
            self.bus.publish({"type": "batch", "project_id": batch["project_id"], "batch": batch})

    def publish_task(self, conn: sqlite3.Connection, task_id: str) -> None:
        row = conn.execute(
            "SELECT t.*, b.project_id AS pid FROM generation_tasks t JOIN generation_batches b ON b.id = t.batch_id"
            " WHERE t.id = ?",
            (task_id,),
        ).fetchone()
        if row:
            self.bus.publish({"type": "task", "project_id": row["pid"], "task": task_dict(row, row["pid"])})

    # --- worker ----------------------------------------------------------------------------

    def _next_task(self) -> sqlite3.Row | None:
        with self.db() as conn:
            return conn.execute(
                "SELECT t.id FROM generation_tasks t JOIN generation_batches b ON b.id = t.batch_id"
                " WHERE t.status = 'queued' AND b.status IN ('queued', 'running')"
                " ORDER BY b.created_at, t.slot_index, t.attempt_number LIMIT 1"
            ).fetchone()

    async def _run(self) -> None:
        while True:
            row = self._next_task()
            if row is None:
                await self._wake.wait()
                self._wake.clear()
                continue
            try:
                await self.execute(row["id"])
            except Exception:  # noqa: BLE001 - a broken task must never stop the queue (spec §27.3)
                log.exception("generation task %s crashed", row["id"])
                with self.db() as conn:
                    self._finish(conn, row["id"], "failed", error=("UNKNOWN_ERROR", "Unexpected error while generating."))

    def _set(self, conn: sqlite3.Connection, task_id: str, **fields: Any) -> None:
        cols = ", ".join(f"{k} = ?" for k in fields)
        with transaction(conn):
            conn.execute(f"UPDATE generation_tasks SET {cols} WHERE id = ?", (*fields.values(), task_id))  # noqa: S608
            batch_id = conn.execute("SELECT batch_id FROM generation_tasks WHERE id = ?", (task_id,)).fetchone()[0]
            refresh_batch(conn, batch_id)
        self.publish_task(conn, task_id)
        self.publish_batch(conn, batch_id)

    def _finish(
        self,
        conn: sqlite3.Connection,
        task_id: str,
        status: str,
        *,
        error: tuple[str, str] | None = None,
        output_asset_id: str | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        self._set(
            conn,
            task_id,
            status=status,
            error_code=error[0] if error else None,
            error_message=error[1] if error else None,
            output_asset_id=output_asset_id,
            result_json=json.dumps(result) if result else None,
            finished_at=now_iso(),
        )
        if error and error[0] in PAUSE_CODES:
            batch_id = conn.execute("SELECT batch_id FROM generation_tasks WHERE id = ?", (task_id,)).fetchone()[0]
            with transaction(conn):
                if refresh_batch(conn, batch_id):  # only pause when there is queued work left
                    conn.execute(
                        "UPDATE generation_batches SET status = 'paused', status_reason = ? WHERE id = ?",
                        (PAUSE_REASON[error[0]], batch_id),
                    )
            self.publish_batch(conn, batch_id)

    async def execute(self, task_id: str) -> None:
        with self.db() as conn:
            task = conn.execute("SELECT * FROM generation_tasks WHERE id = ?", (task_id,)).fetchone()
            batch = conn.execute("SELECT * FROM generation_batches WHERE id = ?", (task["batch_id"],)).fetchone()
            self._set(conn, task_id, status="preparing", started_at=now_iso())
            request = json.loads(task["provider_request_json"])

            provider = self._registry().get(batch["provider_id"])
            if provider is None:
                self._finish(conn, task_id, "failed", error=("PROVIDER_UNAVAILABLE", "The selected provider is not available."))
                return
            try:
                original = self._read_asset(conn, request.get("original_asset_id"))
                # Order matters: the prompt numbers the images (original, extra originals, themes, references).
                ids = [*request.get("extra_original_asset_ids", []), *request["theme_asset_ids"], *request["reference_asset_ids"]]
                extras = [self._read_asset(conn, a) for a in ids]
            except AssetError as exc:
                # Never send a request built from an incomplete set of images (spec §29.8).
                self._finish(conn, task_id, "failed", error=("INVALID_INPUT", exc.message))
                return
            if await provider.check_auth() != "connected":
                self._finish(conn, task_id, "failed", error=("AUTH_REQUIRED", "The provider is not connected."))
                return
            current = conn.execute("SELECT status FROM generation_tasks WHERE id = ?", (task_id,)).fetchone()[0]
            if current == "cancel_requested":  # cancelled while preparing: nothing was sent yet
                self._finish(conn, task_id, "cancelled")
                return

            self._set(conn, task_id, status="running")
            gen_request = GenerateRequest(
                prompt=task["prompt_snapshot"],
                original_image=original,
                reference_images=[e for e in extras if e is not None],
                settings=request["settings"],
            )
            try:
                if request["operation"] == "edit":
                    result = await provider.edit(gen_request)
                else:
                    result = await provider.generate(gen_request)
            except ProviderError as exc:
                self._finish(conn, task_id, "failed", error=(exc.code, exc.message))
                return
            except Exception as exc:  # noqa: BLE001
                err = provider.normalize_error(exc)
                log.exception("provider %s raised", batch["provider_id"])
                self._finish(conn, task_id, "failed", error=(err.code, err.message))
                return

            # Store the file before the task is marked completed (spec §21.2).
            base = (
                f"{task['source_name']}_v{task['variant_index']:02d}"
                if task["source_name"]
                else f"{batch['name'] or 'generation'}_{task['slot_index'] + 1:02d}"
            )
            try:
                asset = import_image(
                    conn, self.settings, batch["project_id"], sanitize_display_name(base), result.image_bytes, origin="generated"
                )
            except AssetError as exc:
                code = "STORAGE_ERROR" if exc.code == "STORAGE_ERROR" else "EMPTY_RESULT"
                self._finish(conn, task_id, "failed", error=(code, f"The returned image could not be stored: {exc.message}"))
                return
            # Requested vs actual (spec §19.7): only what the file and the provider report.
            self._finish(
                conn,
                task_id,
                "completed",
                output_asset_id=asset["id"],
                result={
                    "width": asset["width"],
                    "height": asset["height"],
                    "mime_type": asset["mime_type"],
                    "has_alpha": asset["has_alpha"],
                    "file_size": asset["file_size"],
                    "reported_model": result.reported_model,
                    "reported_settings": result.reported_settings,
                },
            )

    def _read_asset(self, conn: sqlite3.Connection, asset_id: str | None) -> bytes | None:
        if not asset_id:
            return None
        return asset_file(self.settings, get_asset_row(conn, asset_id)).read_bytes()
