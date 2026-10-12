# Implementation status

## Decisions

- **Build order:** scaffold + Phase 1 (core canvas) first; Phase 0 (provider proof of concept) was deferred by the user.
- **First provider:** the user chose **ChatGPT/Codex OAuth** as the first real provider, knowing that no official, documented image API accepts Codex/ChatGPT OAuth tokens. The integration is unofficial, may break, and may conflict with OpenAI's terms.
- **Codex login (Phase 0, in progress):** uses the device-code flow, the same one Hermes Agent uses (`backend/app/providers/codex_auth.py`): `auth.openai.com/api/accounts/deviceauth/*` with the Codex client id. Tokens are refreshed 120 s before expiry.
  - Credentials are DPAPI-encrypted in `workspace/credentials/codex.cred`, outside every project. They are never returned to the frontend.
  - You can also import a login from `~/.codex/auth.json`. The CLI file is read-only to us, but importing shares the refresh token with the CLI.
- **Codex generation:** posts to `chatgpt.com/backend-api/codex/images/generations` and `/images/edits` (the request shape follows community tools, `model: gpt-image-2`). Capabilities stay `unknown` until a call succeeds. A successful call only marks them `supported` in memory, so the result isn't persisted.
  - **Verified on a real account (2026-10-12):** an edit (Original + prompt) through the canvas completed. The backend did not follow the request: asked 1024×1024 / quality auto / white background, it returned 1254×1254 / medium / transparent (real alpha). Treat size, quality and background as hints; exact export sizes need resize/pad (Phase 4).
  - Decision: images go **directly to `gpt-image-2`**, with no Codex chat model in between. A chat-model route (Responses API + hosted `image_generation` tool, as older Hermes versions did) was considered and dropped: it costs extra quota and the chat model can answer in text instead of drawing.
- **Visual theme:** at the user's request, the theme now follows the Mun mascot / Athena brand instead of the spec's dark theme.
  - Cream canvas `#F7F3EE` (taken from the Mun animation), black line art `#1A1A1A`, Athena orange accent `#FF7A00`, Mun pink `#EE979B`, blush `#F4DCD5`.
  - No gradients or soft shadows, following the Mun guideline. Nodes get a 2px black outline.
  - Tokens live in `frontend/src/index.css` (`@theme`).
- **Generation loader:** `MunLoader` (`frontend/src/components/MunLoader.tsx`) plays `assets/mun/mun-painting.mp4`, Mun painting at an easel.
  - The clip is cropped to Mun, muted, 520×300, 10 s loop, about 850 KB.
  - With reduced motion turned on, it shows a still poster frame instead.
  - Used for the provider test generation and on a Generate node while its batch runs.
- **UI kit:** Tailwind v4 only; shadcn/ui is not installed yet (add it when richer components such as dialogs or menus are needed).
- **Collections live in the graph:** collection items (`assetId`, `enabled`, `promptOverride`, ordered) are stored in the collection node's data, not in the `collections`/`collection_items` tables. Undo/redo, copy/paste and auto-save therefore cover them, and a pasted collection is an independent copy. The two tables stay unused. Generation snapshots the whole graph into `generation_batches.snapshot_json`.
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

## Phase 3 (AI workflow) — done

- **Where the logic lives:** the backend owns validation and prompt compilation (`backend/app/generation/plan.py`, pure) so Preview Request and the real run use the same code. The frontend sends the graph exactly as shown; it becomes the batch's immutable snapshot.
  - Server-side graph checks now re-run port typing, single Palette, collection roles, duplicates and cycles (port table mirrors `frontend/src/graph/registry.ts`, keep them in sync).
  - Inputs: originals (Original nodes and enabled Input Collection items, in connection order), themes, references, palette. Missing or foreign assets block the run (§29.8).
  - Prompt order follows §14.2: prompts (role, then `order`, then connection order) → asset identity → original instructions/preservation → theme roles/notes → references → palette → game-asset settings → per-asset override → output (aspect ratio, background).
  - Placeholders `{asset_name}`, `{asset_index}`, `{collection_name}`, `{variant_index}`. Unknown names, or names without a value (e.g. `{asset_name}` in text-to-image), are validation errors.
  - Limits: 200 tasks, 5 variants, and an app limit of 16 images per request (`NODECANVAS_MAX_INPUT_IMAGES`; the Codex limit is unverified). A capability only blocks when it is known `unsupported`.
- **Modes:** Manual count (0 originals → text-to-image; 1 → variations; several → Primary original required) and Match inputs (originals × variants).
- **Queue** (`backend/app/generation/engine.py`): one in-process worker, strictly sequential. Every state change is written to SQLite, then pushed over SSE (`GET /api/generations/events?project_id=`).
  - A task "slot" is one expected output; Retry adds a new attempt row to the same slot, old attempts stay. Counts use the latest attempt per slot.
  - Batch states: queued, running, **paused**, **interrupted**, completed, partially_completed, failed, cancelled. Paused/interrupted are additions: auth, permission, rate-limit, quota and provider-unavailable errors pause the batch instead of failing every task (§29.5).
  - Cancel: queued tasks → cancelled, a running request is left to finish (Codex cannot cancel) and its image is kept. Resume re-queues queued and cancelled tasks. Interrupted tasks (app closed mid-request, result unknown) are never resent automatically; use Retry.
  - Outputs are stored as assets with `origin = generated`, named `{source}_v{NN}` or `{generate title}_{NN}`. Actual size/format/alpha and reported model are saved per task (§19.7).
- **API:** `POST /api/generations/preview`, `POST /api/generations` (optional client `batch_id`), `GET /api/generations?project_id=`, `GET /{id}`, `/{id}/tasks`, `POST /{id}/cancel|retry|resume`, `GET /events`. Migration v3 adds the extra batch/task columns.
- **Canvas results:** pressing Generate first places the result node and saves the graph, then creates the batch with that id, so a reload right after pressing cannot orphan results. One expected result → new Output Image node; several → the Output Collection already connected to that Generate node, or a new one.
  - Results are attached as they arrive, without an undo step. Each node remembers which tasks it already received (`taskId`, `syncedTaskIds`), so a result the user removed is not re-added; on project load, finished batches are synced again.
  - A pasted Output Collection keeps its images but stops receiving batches.
- **UI:** Generate button (shows the task count; no confirmation), progress/Resume/Retry failed on the node, Preview request dialog (per-task compiled prompt, images, palette, settings, provider auth), provider selector, run history, Output Image generation facts (requested vs actual, prompt sent), Output Collection inspector with failed items and Retry, job panel in the status bar.
- **Testing without quota:** `NODECANVAS_FAKE_PROVIDER=1` registers "Local placeholder (testing)", which draws local images and fails on purpose when the prompt contains `[fail]`. The `backend-fake` launch config runs it on a throwaway workspace in the system temp folder.
- Fixed in passing: the Generate inspector re-rendered forever (crash) once anything was connected to its Original port (`useShallow` selector built new objects).

## Canvas tools and single Image node — done

- **One Image node.** Reference / Original / Theme nodes are merged into `image`. Its role comes from the Generate port it feeds; Original, Theme and Reference all accept any image (an Output result too). The node shows its role(s) from its connections, and the inspector shows "As original" (preservation, instructions) and "As theme" (roles) only for the ports it is connected to.
  - Old projects: `original` / `theme` nodes load as `image` with their settings and edges (`upgradeLegacyNode` in `graphStore.ts`); the change is written on the next save. The backend still accepts the old types in snapshots.
  - "Use this image as" conversion and "Use as Original/Theme" on outputs were removed (an output gets "Copy to a new Image node").
- **Tools** (bottom-left, own box above the zoom box): Select (V), Hand (H, left-drag pans), Eraser (E, click or drag over nodes/connections; one stroke = one undo; locked nodes are kept). Escape returns to Select. Middle-drag and Space+drag still pan in every tool.
- Cursors: system arrow (Select), system grab/grabbing hand (Hand), and a custom eraser icon (Eraser, SVG data-URI in `index.css`). Node-type icons (`components/NodeIcon.tsx`) replace the coloured dots in the sidebar, add menu, node and inspector headers.
- **Game Screen asset type:** the Original is a whole game screen (screenshot/mockup). The prompt asks to re-theme it while keeping gameplay identical (layout, object count/positions, UI/HUD, text); composition and object count are added to "preserve"; single-subject framing and the white/transparent background are not sent. Choosing it switches the aspect ratio to **Match original** (`match`), which the backend resolves per task to the preset closest to the original's shape (1080×1920 → 9:16).
- **Delete project:** trash button on each row in the Projects tab (no confirmation). Files move to `backups/deleted-projects`; refused while a batch in that project is queued/running. Deleting the open project opens the most recent other one, or a new one.
- **Delete from library:** select images → Delete (no confirmation). Migration v4 adds `assets.deleted_at`: the row stays (generation history and snapshots point at it) and reads as missing; files move to `backups/deleted-assets/{project}`. Nodes and collection items using those images are emptied as one undo step (undo restores the canvas, not the files). No restore UI yet.
- **Handles:** 14 px with an invisible 30 px hit ring, grow on hover; `connectionRadius` 36 so a drop near a handle connects.
- **Inspector layout:** the header shows the node title (click to rename, Esc cancels), the node type in small text underneath, and icons for collapse and lock (replacing the checkboxes). Duplicate / Delete moved to the bottom, for every node type.
- **Game-asset settings moved from Generate to Prompt** (asset type, art style, keep subject/silhouette, centered framing, same scale). They sit above the prompt text in the Prompt inspector; with several prompts on one Generate node the first by role/order decides. Old projects: `moveGameAssetSettings` copies the settings from the fed Generate node onto its prompts at load; the backend also falls back to the Generate node for old snapshots. Choosing Game Screen sets the fed Generate nodes' aspect to Match original. The Generate "Output" section was renamed "Output image" with plainer labels; the "Format" option was removed from the UI (the stored file keeps what the provider returns).
- **Frozen while generating:** a Generate node with a queued/running batch is frozen: not movable, deletable or connectable, its connections can't be erased, and its inspector is read-only (fieldset) with a "Generating" banner and node badge. It unfreezes when the batch leaves queued/running (done, failed, paused, interrupted). Implementation: `frozenIds` in `graphStore.ts` (`setFrozen`, `isNodeLocked`, `isNodeFrozen`), driven by a `generationStore` subscription. Other nodes (prompts, images) stay editable; a run uses the graph snapshot taken at Generate time.
- **No cancel in the UI (by request):** the Cancel buttons were removed from the node, the status bar and the inspector. The backend `POST /api/generations/{id}/cancel` and `generationStore.cancel` still exist but nothing calls them. A stuck request ends at the provider timeout (300 s) or, after an app restart, as "interrupted".
- **Generation timer:** `useBatchTime` adds up each attempt's own duration (`started_at` → `finished_at`; a running task counts up live each second), so queue waiting, pauses and time with the app closed are not counted. Shown on the Generate node (`⏱ 0:12` while running, `took 1:05` when done), on an Output Collection's "Latest run" line, in the status bar job panel, and as "Took" per image in an Output Image's Generation facts. Interrupted tasks (no end time) count as 0.
- **Palette image input:** the Color Palette node has an `Image` input port (one connection; any Image node or Output result). Connecting an image fills the palette from it, and replacing that image re-reads it (`extractPalette` in `graphStore.ts`, also called from `updateNodeData` when an `assetId` changes). The colours stay editable; "Re-read connected image" refreshes them. Without a connection the inspector offers the library picker below. `PaletteData.extractCount` (2–8, default 5). The backend port table has `palette.image`.
- **Palette extraction:** the Color Palette inspector has "Colors from an image" (library image, 2–8 colours, replace or add). `GET /api/assets/{id}/palette?count=N` works on a 128 px copy: transparent pixels and a plain backdrop touching the border (>= 90% of border pixels one colour; flood-filled, so white parts of the subject stay) are ignored. It quantises to 32 colours, then picks greedily by area with a bonus for saturated colours, skipping any colour within 46 RGB distance of one already chosen, so five picks are five distinct colours. Ratio = area of everything closest to that pick; roles go primary/secondary/accent. (First version used plain median-cut and returned mostly white for assets on an opaque white background.) No AI, no quota. Generating a palette from text with AI is not built.
- **One-connection ports replace:** connecting a new edge to a port that takes one connection (Generate › Palette, Palette › Image, Output and Output Collection inputs) removes the old edge in the same undo step and says so in a toast (`checkConnection` returns `replaces`). Refused while a running generation is on the old connection. The backend still rejects two connections on such a port when generating, but the UI never produces that.
- **LAN access (opt-in):** `npm run dev:lan` (launch config `frontend-lan`) serves the app on `0.0.0.0:5173`; the backend stays on `127.0.0.1`. The Vite proxy rewrites `Origin` to the local frontend origin only when it equals the address the browser is using, so cross-site requests keep their Origin and are rejected. There is no authentication: anyone on the network can use the app and the account quota. If this is kept, add an access code (or serve the built frontend from the backend behind one).
- **Wires by port + primary original:** wires into a Generate node take their port's colour (Prompt blue, Original orange, Theme purple, Palette pink). In Manual count with several originals **every original is sent** to the AI: the Primary original is image 1 and the rest follow it (prompt line "Additional originals: attached images 2-N"), collection items included; they count toward the 16-image limit. The Primary wire is thick and the others are lighter (no labels); **clicking another Original wire makes it primary** (`chooseAsPrimary` in `Canvas.tsx`; a collection cannot be primary). Until one is chosen the wires are dashed, and Generate is refused. Match inputs sends one original per task. Roles are computed by `originalEdgeRoles` (`graph/generation.ts`). Backend: `TaskPlan.extra_original_asset_ids`, sent in order original, extra originals, themes, references.
- **Required ports:** a red `*` after a port name means it must be connected to run (green once connected). On Generate: Prompt always; Original only when the node cannot run without one (`generateNeedsOriginal`): Match inputs, aspect Match original, or a connected Game Screen prompt. The backend enforces the same three rules (Game Screen without an original is refused); Manual count otherwise still runs as text-to-image.
- **Plain-http / LAN gotcha:** browsers hide `crypto.randomUUID` on pages that are not https or localhost, so opened over `http://<lan-ip>:5173` the app could not add nodes, paste, group, or press Generate (the button stuck on "Starting..."). All ids now come from `lib/uuid.ts` (falls back to `getRandomValues`), and `generationStore.start` resets its "starting" flag even on an unexpected error. Don't call `crypto.randomUUID` directly; other secure-context-only APIs (clipboard write, etc.) can fail the same way on LAN.
- **Extract Assets node (AI finds assets, then Redraw nodes):** a node with an `Image` input (required, one connection) and an `Assets` output. The model is a small ChatGPT chat model (`NODECANVAS_VISION_MODEL`, default `gpt-6-luna` then `gpt-5.6-luna`, the "fast and affordable" tier of the account's model list) reached through the Codex Responses endpoint (`POST /backend-api/codex/responses`, streamed, `reasoning.effort=low`, image as `input_image`). It answers JSON only: assets with a name, description and box on a 0..1000 grid (`backend/app/analysis.py`; malformed items dropped, braces stripped, max 60, sides above 1568 px shrunk before upload).
  - **Boxes only say where an asset is.** Nothing is cut out of the image (a crop feature existed and was removed by request: the model's boxes are approximate and its output is never meant to be the final image). Redraw always starts from the whole original.
  - **Flow:** connect an Image, press **Find assets** (`POST /api/assets/{id}/detect`). The inspector shows numbered boxes over the image and a list (tick, rename, optional hint); detections are kept on the node (`detections`, `off`) and ignored once the connected image changes. **Redraw nodes (N)** (`addExtractionWorkflow` in `graphStore.ts`, one undo step) creates the Input Collection "Assets to redraw" on the node's Assets port with the same original image listed once per ticked asset: each item has `label` = the asset name and `promptOverride` = "Take ONLY this one asset from the original image: "name" (description). It is in the top left (about 3-48% across, 3-48% down) of the image. Ignore everything else.", and, unless a Generate already reads that collection, a Prompt ("Redraw the {asset_name} from the original image as a clean, standalone game asset... transparent background...", keep-subject/silhouette off) and a Generate in Match inputs, 1:1, transparent, connected. Pressing it again (after re-finding or unticking) only refreshes the list. It refuses a locked collection. Nothing is generated until Generate is pressed.
  - **`CollectionItem.label`:** optional name for an item. The backend uses it as the task's `{asset_name}` and for the result file name (`{label}_v01.png`), so one image can appear many times; the Collection Viewer shows it instead of the file name.
  - **Ports:** the node outputs port type `extracted`, accepted only by an Input Collection's `extract` input (an Output Collection hides it); it cannot go straight into Generate.
  - **Verified for real (2026-10-12):** one detect call on the 1080x1920 Brain Training screenshot: 16 s, 28 assets (all 20 pots, HUD parts, cat, bottom panel, clock). The Redraw step and node UI were run with the placeholder provider only. Whether the image model can reliably isolate one asset from a whole screen from the text and location alone is untested on the real account. Locations in the prompt come from approximate boxes and a few names are loose.
  - Backend validates the whole graph when generating, so one stale invalid connection anywhere blocks every Generate in that project until it is removed.
- **Right-click** a node (Duplicate, Delete node) or a connection (Delete connection). Right-click on empty canvas still opens Add node.

## Not yet implemented

- Phase 0: real sign-in and an edit are confirmed; text-to-image on a real account is not yet. Persisting verified capabilities and per-provider capability checks in the UI are still missing.
- Collections: no virtualisation in the viewer (fine for the 200-file import limit). Asset deletion and garbage collection are not implemented, so the "Unused" filter only lists assets.
- Phase 3 gaps: only one real Codex run so far (single edit; no real batch). Output actions Regenerate / Create Variation / Add to Collection / Expand to nodes, Download Selected and per-item retry in the Collection Viewer are not built (the API supports retrying chosen task ids). Concurrency setting > 1 is not offered. Output format is recorded but files are not converted.
- Phase 4: export/import ZIP (batch retry/resume already landed with Phase 3).
- Project save (`PUT /api/projects`) still checks only node types, duplicate ids and dangling edges; the full port/cycle rules run when generating.

## Known notes

- Lint shows `react(only-export-components)` warnings in `nodes/nodeTypes.tsx` (fast-refresh only).
- A 204-node perf check on the dev build gave about 12 ms median and 41 ms p95 per frame while dragging. This hasn't been measured on a production build.
- `onlyRenderVisibleElements` is deliberately off: with it on, edges pasted together with their nodes didn't render until the viewport moved.
