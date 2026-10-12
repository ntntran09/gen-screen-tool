# NodeCanvas AI

A local-first, node-based AI game-asset studio. React Flow canvas in the browser, FastAPI + SQLite backend on `127.0.0.1`.

The full product spec lives outside the repo; implementation status is tracked in [docs/STATUS.md](docs/STATUS.md).

## Run (development)

Backend (port 8787):

```bash
cd backend && uv sync && uv run uvicorn app.main:app --host 127.0.0.1 --port 8787
```

Frontend (port 5173, proxies `/api` to the backend):

```bash
cd frontend && npm install && npm run dev
```

Open http://127.0.0.1:5173.

Data is stored in `workspace/NodeCanvasAI/` (override with `NODECANVAS_WORKSPACE`).

## Tests

```bash
cd backend && uv run pytest -q
```

```bash
cd frontend && npx vitest run && npx tsc -b
```

## Layout

- `backend/app/` — FastAPI app: `db.py` (schema + migrations), `routers/` (projects, providers), `providers/` (adapter interface; Codex stub), `security.py` (Host/Origin/CSRF guard).
- `frontend/src/graph/` — node registry, port types and connection validation (pure, unit-tested).
- `frontend/src/store/` — Zustand graph store: undo/redo, copy/paste, lock handling.
- `frontend/src/nodes/`, `frontend/src/components/` — canvas UI, inspector, sidebar, toolbar.

## Canvas shortcuts

Wheel zoom · middle-drag or Space+drag pan · left-drag on empty canvas draws a selection box (selects anything it touches) · Shift+click multi-select · double-click or right-click empty canvas to add a node · Delete · Ctrl+C/V/D/Z/Y/S/A · Ctrl+G group selected images into a collection · Shift+1 fit all · Shift+2 fit selection. Shortcuts are ignored while typing in a field (except Ctrl+S).

Dropping or pasting several images creates one Asset Collection; hold Alt while dropping to get separate nodes.
