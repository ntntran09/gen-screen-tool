# Implementation status

## Decisions

- **Build order:** scaffold + Phase 1 (core canvas) first; Phase 0 (provider proof of concept) was deferred by the user.
- **First provider:** the user chose **ChatGPT/Codex OAuth** as the first real provider, knowing that no official, documented image API accepts Codex/ChatGPT OAuth tokens. The integration is unofficial, may break, and may conflict with OpenAI's terms.
- **Codex login (Phase 0, in progress):** uses the device-code flow, the same one Hermes Agent uses (`backend/app/providers/codex_auth.py`): `auth.openai.com/api/accounts/deviceauth/*` with the Codex client id. Tokens are refreshed 120 s before expiry.
  - Credentials are DPAPI-encrypted in `workspace/credentials/codex.cred`, outside every project. They are never returned to the frontend.
  - You can also import a login from `~/.codex/auth.json`. The CLI file is read-only to us, but importing shares the refresh token with the CLI.
- **Codex generation:** posts to `chatgpt.com/backend-api/codex/images/generations` and `/images/edits` (the request shape follows community tools, `model: gpt-image-2`). Capabilities stay `unknown` until a call succeeds. A successful call only marks them `supported` in memory, so the result isn't persisted.
  - **Not yet verified against a real account.** The real check is the "Generate test image" button in the provider dialog (click the Codex chip in the toolbar), which requires an explicit quota-use confirmation.
- **Visual theme:** at the user's request, the theme now follows the Mun mascot / Athena brand instead of the spec's dark theme.
  - Cream canvas `#F7F3EE` (taken from the Mun animation), black line art `#1A1A1A`, Athena orange accent `#FF7A00`, Mun pink `#EE979B`, blush `#F4DCD5`.
  - No gradients or soft shadows, following the Mun guideline. Nodes get a 2px black outline.
  - Tokens live in `frontend/src/index.css` (`@theme`).
- **Generation loader:** `MunLoader` (`frontend/src/components/MunLoader.tsx`) plays `assets/mun/mun-painting.mp4`, Mun painting at an easel.
  - The clip is cropped to Mun, muted, 520×300, 10 s loop, about 850 KB.
  - With reduced motion turned on, it shows a still poster frame instead.
  - Currently used for the provider test generation. Phase 3 should use it for running Output nodes/collections.
- **UI kit:** Tailwind v4 only; shadcn/ui is not installed yet (add it when richer components such as dialogs or menus are needed).
- **Collections live in the graph:** collection items (`assetId`, `enabled`, `promptOverride`, ordered) are stored in the collection node's data, not in the `collections`/`collection_items` tables. Undo/redo, copy/paste and auto-save therefore cover them, and a pasted collection is an independent copy. The two tables stay unused for now; Phase 3 can snapshot items from the graph into `generation_tasks`.
- **Persistence:** the whole graph is saved per project with `PUT /api/projects/{id}` (debounced 800 ms). Node rows are replaced in a single transaction.
- **CSRF:** mutations require the `x-nodecanvas-csrf: 1` header. Host and Origin are checked against local values.

## Phase 1 — done

- All 8 node types, with registry-driven typed ports (spec §11.2, §25).
- Connection validation: type compatibility, single-input Palette, input/output collection roles, duplicate edges, cycle prevention. Each rejection explains its reason in a toast.
- Sidebar drag-and-drop and click-to-add, plus an add-node menu on double-click or right-click.
- Inspector for every node type (prompt, preservation, theme roles, palette editor, Generate mode/settings, Primary Original picker).
- Undo/redo (coalesced text edits), copy/paste/duplicate (keeps internal edges), lock (no move/delete), collapse.
- Projects: create, open, rename and delete (files moved to `backups/deleted-projects`). Last project is reopened on load; graph and viewport auto-save.
- Backend: SQLite schema for all spec §21 tables, plus migrations with a backup taken before each one.

## Phase 2a (assets) — done

- `POST /api/assets/import` (multipart, many files): each file is checked by signature, decoded fully with Pillow (decompression-bomb guard, no animated images) and limited to 25 MB / 200 files (configurable). Each bad file gets its own error without failing the rest.
- Original bytes are stored unchanged as `projects/{id}/assets/{asset_id}.{ext}`, plus a 512px WebP thumbnail. Files are written before the DB row. Display names are sanitised, and the client never picks a path.
- Endpoints `GET /api/assets/{id}` (`missing` flag), `/thumbnail`, `/file` (inline), `/download` (attachment), `PATCH` rename (display name only), and `GET /api/projects/{id}/assets`.
- Migration v2 adds `display_name` and `thumbnail_path`. It was tested upgrading a v1 DB, with a backup taken first.
- Frontend:
  - Drop files on the canvas to create Reference image nodes (4-column grid). Drop onto an image node to replace its image.
  - Ctrl+V pastes clipboard images, or copied nodes when there's no image.
  - "Choose image" in empty nodes and in the inspector.
  - Thumbnails sit on a checkerboard. A missing file shows a placeholder.
  - Double-click a node, or click the inspector preview, for the full-size lightbox.
  - The inspector shows file facts, rename, download and replace, plus converting between Reference, Original and Theme (keeps the asset and drops edges that no longer fit). Output → "Use as Original/Theme" creates a new node.
- Replace and delete never remove files from disk. Asset garbage collection is not implemented.

## Phase 2b (collections, library) — done

- `CollectionData.items` replaces `collectionId`/`itemCount`. Loading a project fills fields missing from older saved nodes with defaults.
- Dropping or pasting two or more images creates one Input Collection. Hold Alt while dropping to get separate Reference nodes instead. Dropping onto an Input Collection adds to it; dropping one image onto an image node still replaces it.
- Group: select image nodes, then "Group into collection" in the inspector or Ctrl+G. Items follow reading order, an Original's instructions become the item's prompt override, and edges into a Generate node's Original port move to the collection. Locked and empty nodes are left out.
- Ungroup (Input Collection only): one Original node per item, keeping overrides as instructions and reconnecting to the same Generate nodes. The enabled flag is not kept.
- Collection node: thumbnail grid (first 8, "+N"), image/disabled count. Click or double-click it to open the viewer.
- Collection Viewer (modal): enable/disable per image or all, drag (or ←/→) to reorder, per-image prompt override (input collections only), remove, add by button, drop or paste, and click for the full-size Lightbox. Locked collections are read-only. While a dialog is open, canvas shortcuts other than undo/redo/save are ignored.
- Library tab: every project asset, newest first, with name search and All/Uploaded/Generated/Unused filters. Drag tiles onto the canvas, a node or a collection. Ctrl/Shift+click selects several, which can be added as nodes or as a new collection; double-click previews. "Import" stores files without placing them.
- Sidebar Nodes tab: All/Inputs/Images/AI sub-tabs and compact two-column cards; descriptions are shown on hover (title).
- Output Image is no longer offered in the sidebar or add menu (`ADDABLE_KINDS`). The type stays: Phase 3 generation will create Output Image nodes (one result) or an Output Collection (several) next to the Generate node, connected automatically, and reuse an Output Collection that is already connected.
- Prompt node: the main prompt is edited directly in the node (`nodrag nowheel` textarea, coalesced undo); the inspector keeps the full fields.
- Tests: `graph/collections.test.ts`, plus group/ungroup/items/load cases in `store/graphStore.test.ts`.

## Not yet implemented

- Phase 0: confirm a real sign-in, then confirm real generation and edits. Persisting verified capabilities and per-provider capability checks in the UI are still missing.
- Collections: no virtualisation in the viewer (fine for the 200-file import limit). Asset deletion and garbage collection are not implemented, so the "Unused" filter only lists assets.
- Phase 3: prompt compilation, Generate button (disabled), batch queue, SSE, Output nodes.
- Phase 4: export/import ZIP, retry/resume.
- Server-side graph validation checks only node types, duplicate ids and edges pointing at missing nodes. Port typing and cycle rules are enforced in the frontend only, and must be re-checked server-side before generation (Phase 3).

## Known notes

- Lint shows `react(only-export-components)` warnings in `nodes/nodeTypes.tsx` (fast-refresh only).
- A 204-node perf check on the dev build gave about 12 ms median and 41 ms p95 per frame while dragging. This hasn't been measured on a production build.
- `onlyRenderVisibleElements` is deliberately off: with it on, edges pasted together with their nodes didn't render until the viewport moved.
