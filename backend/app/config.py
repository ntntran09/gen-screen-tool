"""Runtime configuration. Values come from environment variables with local-first defaults."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    workspace_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("NODECANVAS_WORKSPACE", REPO_ROOT / "workspace" / "NodeCanvasAI")
        )
    )
    # Kept outside the workspace so credentials can never end up in a project or export.
    credentials_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("NODECANVAS_CREDENTIALS_DIR", REPO_ROOT / "workspace" / "credentials")
        )
    )
    codex_cli_home: Path = field(
        default_factory=lambda: Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    )
    max_import_bytes: int = int(os.environ.get("NODECANVAS_MAX_IMPORT_MB", "25")) * 1024 * 1024
    max_import_files: int = int(os.environ.get("NODECANVAS_MAX_IMPORT_FILES", "200"))
    host: str = os.environ.get("NODECANVAS_HOST", "127.0.0.1")
    port: int = int(os.environ.get("NODECANVAS_PORT", "8787"))
    frontend_origins: tuple[str, ...] = tuple(
        o.strip()
        for o in os.environ.get(
            "NODECANVAS_FRONTEND_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173"
        ).split(",")
        if o.strip()
    )

    @property
    def database_path(self) -> Path:
        return self.workspace_dir / "database.sqlite"

    @property
    def allowed_hosts(self) -> set[str]:
        return {f"127.0.0.1:{self.port}", f"localhost:{self.port}", "127.0.0.1", "localhost", "testserver"}

    def ensure_dirs(self) -> None:
        for sub in ("projects", "backups", "logs"):
            (self.workspace_dir / sub).mkdir(parents=True, exist_ok=True)
