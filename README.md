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

To try generation without using ChatGPT quota, start the backend with `NODECANVAS_FAKE_PROVIDER=1` and pick "Local placeholder (testing)" as the Generate node's provider (better with a separate `NODECANVAS_WORKSPACE`).

## Open it to the local network (LAN)

```bash
cd frontend && npm run dev:lan
```

Then open `http://<this-pc-ip>:5173` from another device on the same network (find the IP with `ipconfig`). Only the web server listens on all interfaces; the backend stays on `127.0.0.1` behind its proxy, and requests from other websites are still rejected.

**There is no sign-in.** Anyone who can reach that address can use the app: see every project and generate images with the signed-in ChatGPT account (quota). Use it only on a network you trust, and stop it (`npm run dev` instead) when you are done. Windows will ask to allow Node.js through the firewall the first time. Devices on a VPN such as Tailscale can reach it too.

## Tests

```bash
cd backend && uv run pytest -q
```

```bash
cd frontend && npx vitest run && npx tsc -b
```

## Layout

- `backend/app/` — FastAPI app: `db.py` (schema + migrations), `routers/` (projects, assets, auth, providers, generations), `providers/` (adapter interface, Codex, local placeholder), `generation/` (`plan.py` validation + prompt compilation, `engine.py` queue worker + SSE bus), `security.py` (Host/Origin/CSRF guard).
- `frontend/src/graph/` — node registry, port types and connection validation (pure, unit-tested).
- `frontend/src/store/` — Zustand stores: graph (undo/redo, copy/paste, result placement), assets, generation (batches, tasks, SSE).
- `frontend/src/nodes/`, `frontend/src/components/` — canvas UI, inspector, sidebar, toolbar.

## Canvas shortcuts

Wheel zoom · middle-drag or Space+drag pan · left-drag on empty canvas draws a selection box (selects anything it touches) · Shift+click multi-select · double-click or right-click empty canvas to add a node · Delete · Ctrl+C/V/D/Z/Y/S/A · Ctrl+G group selected images into a collection · Shift+1 fit all · Shift+2 fit selection. Shortcuts are ignored while typing in a field (except Ctrl+S).

Dropping or pasting several images creates one Asset Collection; hold Alt while dropping to get separate nodes.
