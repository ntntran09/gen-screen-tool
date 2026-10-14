"""SQLite access and schema migrations (spec §21)."""

from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

MIGRATIONS: list[tuple[int, str]] = [
    (
        1,
        """
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            viewport_json TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE nodes (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            position_json TEXT NOT NULL,
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_nodes_project ON nodes(project_id);
        CREATE TABLE edges (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            source_handle TEXT,
            target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            target_handle TEXT
        );
        CREATE INDEX idx_edges_project ON edges(project_id);
        CREATE TABLE assets (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            original_filename TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            file_size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            origin TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE collections (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            collection_type TEXT NOT NULL CHECK (collection_type IN ('input','output')),
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE collection_items (
            id TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            asset_id TEXT NOT NULL REFERENCES assets(id),
            sort_index INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            prompt_override TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE generation_batches (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            generate_node_id TEXT NOT NULL,
            mode TEXT NOT NULL,
            expected_count INTEGER NOT NULL,
            completed_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            finished_at TEXT
        );
        CREATE TABLE generation_tasks (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES generation_batches(id) ON DELETE CASCADE,
            source_asset_id TEXT,
            variant_index INTEGER NOT NULL,
            status TEXT NOT NULL,
            prompt_snapshot TEXT NOT NULL,
            provider_request_json TEXT NOT NULL,
            output_asset_id TEXT REFERENCES assets(id),
            error_code TEXT,
            error_message TEXT,
            attempt_number INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            finished_at TEXT
        );
        CREATE TABLE app_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );
        """,
    ),
    (
        2,
        """
        ALTER TABLE assets ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE assets ADD COLUMN thumbnail_path TEXT;
        UPDATE assets SET display_name = original_filename WHERE display_name = '';
        CREATE INDEX idx_assets_project ON assets(project_id);
        """,
    ),
    (
        3,
        # Phase 3 generation: a task "slot" is one expected output; retries add attempts to the same slot.
        """
        ALTER TABLE generation_batches ADD COLUMN provider_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE generation_batches ADD COLUMN name TEXT NOT NULL DEFAULT '';
        ALTER TABLE generation_batches ADD COLUMN cancelled_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE generation_batches ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE generation_batches ADD COLUMN status_reason TEXT;
        ALTER TABLE generation_tasks ADD COLUMN slot_index INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE generation_tasks ADD COLUMN source_name TEXT;
        ALTER TABLE generation_tasks ADD COLUMN result_json TEXT;
        ALTER TABLE generation_tasks ADD COLUMN started_at TEXT;
        CREATE INDEX idx_batches_project ON generation_batches(project_id, created_at);
        CREATE INDEX idx_tasks_batch ON generation_tasks(batch_id, slot_index, attempt_number);
        """,
    ),
    (
        4,
        # Deleted assets keep their row (generation history points at them); files move to backups.
        """
        ALTER TABLE assets ADD COLUMN deleted_at TEXT;
        """,
    ),
    (
        5,
        """
        ALTER TABLE projects ADD COLUMN graph_revision INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE sync_clients (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            client_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            PRIMARY KEY (project_id, client_id)
        );
        """,
    ),
]


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def connect(path: Path) -> sqlite3.Connection:
    # One connection per request, used sequentially; async routes may touch it from a worker thread.
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)  # explicit `transaction()`
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def fold_legacy_workflow_nodes(conn: sqlite3.Connection, db_path: Path, backups_dir: Path) -> None:
    """Move the short-lived stand-alone `workflow` node into the collection that owns the folded flow.

    The Prompt, Generate and style Image nodes of an Extract flow are folded into the Cropped assets
    collection (`foldedIds` there, `groupId` on each folded node). An earlier build kept that list on a
    separate `workflow` node, which is no longer a known node type. Idempotent.
    """
    legacy = conn.execute("SELECT id, project_id, data_json FROM nodes WHERE type = 'workflow'").fetchall()
    if not legacy:
        return
    backups_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    shutil.copy2(db_path, backups_dir / f"database-{stamp}-pre-workflow-fold.sqlite")
    ts = now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        for row in legacy:
            project_id = row[1]
            data = json.loads(row[2])
            members = [m for m in data.get("memberIds", []) if isinstance(m, str)]
            generate_id = data.get("generateNodeId")
            owner = conn.execute(
                "SELECT n.id, n.data_json FROM edges e JOIN nodes n ON n.id = e.source_node_id"
                " WHERE e.project_id = ? AND e.target_node_id = ? AND e.target_handle = 'original' AND n.type = 'collection'",
                (project_id, generate_id),
            ).fetchone()
            for member_id in members:
                found = conn.execute("SELECT data_json FROM nodes WHERE id = ? AND project_id = ?", (member_id, project_id)).fetchone()
                if found is None:
                    continue
                member = json.loads(found[0])
                if owner is not None:
                    member["groupId"] = owner[0]
                else:  # nothing to fold into: show the node again
                    member.pop("groupId", None)
                conn.execute("UPDATE nodes SET data_json = ?, updated_at = ? WHERE id = ?", (json.dumps(member), ts, member_id))
            if owner is not None:
                owner_data = json.loads(owner[1])
                owner_data["foldedIds"] = members
                conn.execute("UPDATE nodes SET data_json = ?, updated_at = ? WHERE id = ?", (json.dumps(owner_data), ts, owner[0]))
                # The folded Generate node is hidden: its results hang off the collection's button.
                for edge in conn.execute(
                    "SELECT target_node_id, target_handle FROM edges WHERE project_id = ? AND source_node_id = ?",
                    (project_id, generate_id),
                ).fetchall():
                    conn.execute(
                        "INSERT INTO edges (id, project_id, source_node_id, source_handle, target_node_id, target_handle)"
                        " VALUES (?, ?, ?, 'out', ?, ?)",
                        (f"wf-{owner[0]}-{uuid.uuid4().hex[:8]}", project_id, owner[0], edge[0], edge[1]),
                    )
            conn.execute("DELETE FROM edges WHERE source_node_id = ? OR target_node_id = ?", (row[0], row[0]))
            conn.execute("DELETE FROM nodes WHERE id = ?", (row[0],))
            conn.execute("UPDATE projects SET graph_revision = graph_revision + 1, updated_at = ? WHERE id = ?", (ts, project_id))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def migrate(db_path: Path, backups_dir: Path) -> None:
    """Apply pending migrations. Backs up an existing database first (spec §27.4)."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    existed = db_path.exists()
    conn = connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
        )
        applied = {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}
        pending = [(v, sql) for v, sql in MIGRATIONS if v not in applied]
        if not pending:
            fold_legacy_workflow_nodes(conn, db_path, backups_dir)
            return
        if existed:
            backups_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            shutil.copy2(db_path, backups_dir / f"database-{stamp}-pre-v{pending[0][0]}.sqlite")
        for version, sql in pending:
            try:
                conn.executescript(
                    f"BEGIN;\n{sql}\nINSERT INTO schema_migrations VALUES ({version}, '{now_iso()}');\nCOMMIT;"
                )
            except sqlite3.Error:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
        fold_legacy_workflow_nodes(conn, db_path, backups_dir)
    finally:
        conn.close()
