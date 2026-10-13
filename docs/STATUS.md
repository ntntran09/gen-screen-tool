# Implementation status

## Decisions

- **Build order:** scaffold + Phase 1 (core canvas) first; Phase 0 (provider proof of concept) was deferred by the user.
- **First provider:** the user chose **ChatGPT/Codex OAuth** as the first real provider, knowing that no official, documented image API accepts Codex/ChatGPT OAuth tokens. The integration is unofficial, may break, and may conflict with OpenAI's terms.
- **Codex login (Phase 0, working):** uses the device-code flow, the same one Hermes Agent uses (`backend/app/providers/codex_auth.py`): `auth.openai.com/api/accounts/deviceauth/*` with the Codex client id. Tokens are refreshed 120 s before expiry.
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

- All 7 node types, with registry-driven typed ports (spec §11.2, §25).
- Connection validation: type compatibility, single-input Palette, input/output collection roles, duplicate edges, cycle prevention. Each rejection explains its reason in a toast.
- Sidebar drag-and-drop and click-to-add, plus an add-node menu on double-click or right-click.
- Inspector for every node type (prompt text, theme roles, palette editor, Generate mode/settings, Primary Original picker).
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
- Group: select image nodes, then "Group into collection" in the inspector or Ctrl+G. Items follow reading order, and edges into a Generate node's Original port move to the collection. Locked and empty nodes are left out.
- Ungroup (Input Collection only): one Image node per item, reconnecting to the same Generate nodes. The enabled flag is not kept.
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
  - Prompt compilation: the selected Generate preset template → enabled Prompt texts in connection order (user request and pasted art direction) → `ADDITIONAL INPUTS` (image numbering, secondary originals, Theme roles/notes, Reference notes, palette, per-image override and explicit aspect ratio). Old prompt roles/order, asset categories, constraints, preservation and background settings are ignored.
  - Placeholders `{asset_name}`, `{asset_index}`, `{collection_name}`, `{variant_index}`. Unknown names, or names without a value (e.g. `{asset_name}` in text-to-image), are validation errors.
  - Limits: 200 tasks, 5 variants, and an app limit of 16 images per request (`NODECANVAS_MAX_INPUT_IMAGES`; the Codex limit is unverified). A capability only blocks when it is known `unsupported`.
- **Modes:** Manual count (Original required; 1 → variations; several → Primary original required) and Match inputs (originals × variants).
- **Queue** (`backend/app/generation/engine.py`): one in-process scheduler, sequential by default; each Generate node can request 1–4 concurrent requests. The value is captured in the batch snapshot. There are at most 4 requests in flight across all batches. Every state change is written to SQLite, then pushed over SSE (`GET /api/generations/events?project_id=`).
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

- **One Image node.** Reference / Original / Theme nodes are merged into `image`. Its role comes from the Generate port it feeds; Original, Theme and Reference all accept any image (an Output result too). The node shows its role(s) from its connections, and the inspector shows Theme roles when connected to a Theme port.
  - Old projects: `original` / `theme` nodes load as `image` with their settings and edges (`upgradeLegacyNode` in `graphStore.ts`); the change is written on the next save. The backend still accepts the old types in snapshots.
  - "Use this image as" conversion and "Use as Original/Theme" on outputs were removed (an output gets "Copy to a new Image node").
- **Tools** (bottom-left, own box above the zoom box): Select (V), Hand (H, left-drag pans), Eraser (E, click or drag over nodes/connections; one stroke = one undo; locked nodes are kept). Escape returns to Select. Middle-drag and Space+drag still pan in every tool.
- Cursors: system arrow (Select), system grab/grabbing hand (Hand), and a custom eraser icon (Eraser, SVG data-URI in `index.css`). Node-type icons (`components/NodeIcon.tsx`) replace the coloured dots in the sidebar, add menu, node and inspector headers.
- **Delete project:** trash button on each row in the Projects tab (no confirmation). Files move to `backups/deleted-projects`; refused while a batch in that project is queued/running. Deleting the open project opens the most recent other one, or a new one.
- **Delete from library:** select images → Delete (no confirmation). Migration v4 adds `assets.deleted_at`: the row stays (generation history and snapshots point at it) and reads as missing; files move to `backups/deleted-assets/{project}`. Nodes and collection items using those images are emptied as one undo step (undo restores the canvas, not the files). No restore UI yet.
- **Handles:** 14 px with an invisible 30 px hit ring, grow on hover; `connectionRadius` 36 so a drop near a handle connects.
- **Inspector layout:** the header shows the node title (click to rename, Esc cancels), the node type in small text underneath, and icons for collapse and lock (replacing the checkboxes). Duplicate / Delete moved to the bottom, for every node type.
- **Only two presets, on Generate:** `Game screen restyle` (`screen`) and `Asset sheet` (`assets`). Prompt has text and enabled only; the old Asset type dropdown and art-style/preservation/framing/constraints options are removed. Paste art direction into the prompt text. Templates live in `backend/app/generation/presets.py`; both require an Original and always use image edit. Asset sheet has optional `assetSelection`; empty means the AI identifies distinct reusable assets. Selecting Game screen restyle sets aspect to Match original; output aspect and quality remain editable. Preview Request uses the same compilation as Generate.
- **Frozen while generating:** a Generate node with a queued/running batch is frozen: not movable, deletable or connectable, its connections can't be erased, and its inspector is read-only (fieldset) with a "Generating" banner and node badge. It unfreezes when the batch leaves queued/running (done, failed, paused, interrupted). Implementation: `frozenIds` in `graphStore.ts` (`setFrozen`, `isNodeLocked`, `isNodeFrozen`), driven by a `generationStore` subscription. Other nodes (prompts, images) stay editable; a run uses the graph snapshot taken at Generate time.
- **No cancel in the UI (by request):** the Cancel buttons were removed from the node, the status bar and the inspector. The backend `POST /api/generations/{id}/cancel` and `generationStore.cancel` still exist but nothing calls them. A stuck request ends at the provider timeout (300 s) or, after an app restart, as "interrupted".
- **Generation timer:** `useBatchTime` adds up each attempt's own duration (`started_at` → `finished_at`; a running task counts up live each second), so queue waiting, pauses and time with the app closed are not counted. Shown on the Generate node (`⏱ 0:12` while running, `took 1:05` when done), on an Output Collection's "Latest run" line, in the status bar job panel, and as "Took" per image in an Output Image's Generation facts. Interrupted tasks (no end time) count as 0.
- **Palette image input:** the Color Palette node has an `Image` input port (one connection; any Image node or Output result). Connecting an image fills the palette from it, and replacing that image re-reads it (`extractPalette` in `graphStore.ts`, also called from `updateNodeData` when an `assetId` changes). The colours stay editable; "Re-read connected image" refreshes them. Without a connection the inspector offers the library picker below. `PaletteData.extractCount` (2–8, default 5). The backend port table has `palette.image`.
- **Palette extraction:** the Color Palette inspector has "Colors from an image" (library image, 2–8 colours, replace or add). `GET /api/assets/{id}/palette?count=N` works on a 128 px copy: transparent pixels and a plain backdrop touching the border (>= 90% of border pixels one colour; flood-filled, so white parts of the subject stay) are ignored. It quantises to 32 colours, then picks greedily by area with a bonus for saturated colours, skipping any colour within 46 RGB distance of one already chosen, so five picks are five distinct colours. Ratio = area of everything closest to that pick; roles go primary/secondary/accent. (First version used plain median-cut and returned mostly white for assets on an opaque white background.) No AI, no quota. Generating a palette from text with AI is not built.
- **One-connection ports replace:** connecting a new edge to a port that takes one connection (Generate › Palette, Palette › Image, Output and Output Collection inputs) removes the old edge in the same undo step and says so in a toast (`checkConnection` returns `replaces`). Refused while a running generation is on the old connection. The backend still rejects two connections on such a port when generating, but the UI never produces that.
- **LAN access (opt-in):** `npm run dev:lan` (launch config `frontend-lan`) serves the app on `0.0.0.0:5173`; the backend stays on `127.0.0.1`. The Vite proxy rewrites `Origin` to the local frontend origin only when it equals the address the browser is using, so cross-site requests keep their Origin and are rejected. There is no authentication: anyone on the network can use the app and the account quota. If this is kept, add an access code (or serve the built frontend from the backend behind one).
- **Wires by port + primary original:** wires into a Generate node take their port's colour (Prompt blue, Original orange, Theme purple, Palette pink). In Manual count with several originals **every original is sent** to the AI: the Primary original is image 1 and the rest follow it (prompt line "Additional originals: attached images 2-N"), collection items included; they count toward the 16-image limit. The Primary wire is thick and the others are lighter (no labels); **clicking another Original wire makes it primary** (`chooseAsPrimary` in `Canvas.tsx`; a collection cannot be primary). Until one is chosen the wires are dashed, and Generate is refused. Match inputs sends one original per task. Roles are computed by `originalEdgeRoles` (`graph/generation.ts`). Backend: `TaskPlan.extra_original_asset_ids`, sent in order original, extra originals, themes, references.
- **Required ports:** Generate always requires Prompt and Original for both presets; Extract requires Image. A red `*` becomes green once connected. Manual count with multiple originals still requires a Primary original.
- **Plain-http / LAN gotcha:** browsers hide `crypto.randomUUID` on pages that are not https or localhost, so opened over `http://<lan-ip>:5173` the app could not add nodes, paste, group, or press Generate (the button stuck on "Starting..."). All ids now come from `lib/uuid.ts` (falls back to `getRandomValues`), and `generationStore.start` resets its "starting" flag even on an unexpected error. Don't call `crypto.randomUUID` directly; other secure-context-only APIs (clipboard write, etc.) can fail the same way on LAN.
- **Extract Assets:** required `Image` input, `Assets` output accepted by Input Collection's `extract` port. Find assets uses the small vision model (`gpt-6-luna`, fallback `gpt-5.6-luna`) to return names and approximate boxes.
  - Detection uses the original prompt: each visible asset instance separately, without deduplicating types or requiring reusable pot/flower components. Each crop has a per-image target name/description so background removal also excludes other components inside its box. This depends on the vision model; users review its list.
  - Review/tick/rename detections. Detections become stale when the source image changes.
  - **Build asset sheet** now cuts the selected boxes into actual PNG files (`POST /api/assets/{id}/crop`, no AI), creates/reuses a "Cropped assets" Input Collection and wires Extract → Collection → Generate Original. Repeated names remain separate crops.
  - Adds a "Remove background" Prompt: remove only the backdrop, preserve the asset's art, colors, shape and integral text. Generate uses Asset sheet preset, selection "the single main asset in this cropped image", Match inputs ×1 and Match original aspect: one task/output per crop. Background removal starts only when Generate is pressed.
  - Reuses `collectionNodeId` / `generateNodeId`, upgrades the previous whole-image workflow on the next Build, preserves user-edited prompt text. Locked/frozen targets are refused. Delayed results cannot overwrite a changed source/project. Cropped files remain in Library after undo; the canvas change is one undo step.
  - Crop boxes are approximate; inspect crops before spending quota. Background removal is an image-model request, not guaranteed pixel-perfect alpha. No real provider run was used to test this change.
- **Right-click** a node (Duplicate, Delete node) or a connection (Delete connection). Right-click on empty canvas still opens Add node.

## Not yet implemented

- Phase 0: the real provider is connected and returns results successfully (confirmed by the user). Persisting verified capabilities and per-provider capability checks in the UI are still missing.
- Collections: no virtualisation in the viewer (fine for the 200-file import limit). Asset deletion moves files to backups; garbage collection is not implemented.
- Phase 3: the remaining output actions, selected downloads, per-item retry, concurrency and format conversion are implemented (see the completion notes below). Browser verification and a real-provider concurrency run remain unverified.
- Phase 4: export/import ZIP (batch retry/resume already landed with Phase 3).
- Project save (`PUT /api/projects`) still checks only node types, duplicate ids and dangling edges; the full port/cycle rules run when generating.

## Known notes

- Lint shows `react(only-export-components)` warnings in `nodes/nodeTypes.tsx` (fast-refresh only).
- A 204-node perf check on the dev build gave about 12 ms median and 41 ms p95 per frame while dragging. This hasn't been measured on a production build.
- `onlyRenderVisibleElements` is deliberately off: with it on, edges pasted together with their nodes didn't render until the viewport moved.

## Crop review correction (2026-10-12)

- AI localization can select the wrong region despite the right name; confirmed against actual source/crop pixels. Automatic detection accuracy remains unresolved.
- Extract inspector offers Crop per detection: draw or edit percentages, preview, save. Rebuild asset sheet to replace collected crops. Supports Cancel, Escape, native modal focus and undo. Uses original image.
- Collection thumbnails respect contain and show full crops.
- Verified frontend typecheck/build, 75 tests, lint (existing warnings only), UI draw/save/reopen/undo. No real AI usage. Screenshot .cache/crop-editor-check.png.

## Phase 3 completion (2026-10-13)

- Output Image inspector and Output Collection cards: **Regenerate**, **Add to Collection**, and Download in a compact icon toolbar above the preview. Regenerate retries the selected slot using its saved request, retains old attempts and images, and saves a new result receiver before submitting. The receiver waits for the exact slot/attempt so reload cannot attach an older image. Create Variation creates an editable Image → Prompt → Generate branch as one undo step; it starts only when Generate is pressed. Add to Collection supports a new Input Collection or an existing unlocked collection.
- Output collections: **Expand to nodes** copies all images from the inspector; the viewer expands only selected images. Both retain the collection and undo in one step. Selection is separate from generation's enabled flag. **Download Selected** downloads one ZIP, preserving file bytes and ordered, unique names. `GET /api/projects/{id}/assets/download?ids=...` checks project membership, missing files and the 200-image limit; ZIP buffering spills to a temporary file after 8 MB. Failed/interrupted items have individual Retry buttons in the viewer.
- **Concurrent requests** in the Generate inspector: 1–4, default 1; validated by Preview and Generate, persisted in the immutable batch settings. The scheduler caps all in-flight requests at 4. A rate-limit/auth/quota error pauses queued work while already-running requests finish; their completion does not clear the paused state. Requests cancelled before dispatch are not sent.
- **File format**: PNG, lossless WebP, JPG. Provider bytes are validated before conversion. PNG/WebP preserve returned transparency; JPG composites onto white. Task facts describe the stored file, with the provider's original MIME type retained separately. No resizing is done (Phase 4).
- Verification: backend **103 tests**, frontend **83 tests**, TypeScript/production build pass; lint has no errors and existing warnings. Mechanical UI detector returned no findings. Browser interaction/visual QA could not run: no browser was available to the UI tool. All provider checks used local fakes; no real quota was spent. Real-provider concurrent behavior remains unverified. Restart the backend to load the new scheduler/routes.


## Output inspector simplification (2026-10-13)

- Moved output actions above the image preview; Download, Regenerate and Add to Collection use line icons with tooltips and accessible labels. Collection destination opens only on demand. Collection cards use the same toolbar above their image.
- Removed Create Variation and Copy to a new Image from the inspector: connect the Output directly to a Generate input. Removed the unused workflow builder and its test; existing graphs are unchanged.
- Output file facts show a compact resolution/format/size line. File details and Generation details are collapsed by default. Clicking the preview still opens full size.
- Verified 82 frontend tests, TypeScript/production build, lint (existing warnings only), UI detector (no findings). No browser was available for visual verification. Vite serves the changes through hot reload; no backend change or AI request.


## Regenerate edits the current result (2026-10-13)

- Regenerate now opens an inline change-request textarea below the toolbar. Nothing is submitted until Generate edit (or Ctrl/Cmd+Enter); empty requests are disabled. This edits the displayed result, rather than retrying the old task against its first Original.
- Submitting creates a connected Output ? Generate ? new Output branch with a Prompt feeding the new Generate. The displayed Output is used directly, with no duplicate Image node. A collection card uses only that selected item's image. The new request inherits the provider and available quality/format/model settings; concurrency defaults to 1 and aspect to Match original.
- Result edits use a dedicated instruction to change only what the user requested and preserve unspecified details, without imposing the screen/asset-sheet template. Preview and the actual run share the compiler. Existing normal Generate presets remain unchanged. Failed submission retains the editable connected Prompt/Generate branch and removes its empty result receiver.
- Legacy pendingSlot/pendingAttempt fields remain readable for outputs from the former retry flow. Existing saved nodes are not deleted or rewired automatically.
- Verification: 86 frontend tests pass; the backend suite passed 104 tests plus the new generated-result integration test passed separately. TypeScript/production build pass; lint has existing warnings only; UI detector has no findings. No browser was available for visual QA. No real AI request was made for verification.
- The live backend was restarted automatically after all active generation batches finished. Health now advertises result_edit=true; frontend checks this before spending quota on an edit. App/proxy health verified after restart.


## Inline Generate control (2026-10-13)

- Supersedes the proposed round Prompt/Generate nodes: result editing is now one small circular Generate button beside the Output Image port, with the user-requested blue-to-green gradient. Click to open the inline prompt and run details inside that Output. Clicking a collapsed Output opens it. Running shows a ring and progress/status details. The inspector keeps Download/Add to Collection; editing starts at the port. Collection cards use the same inline control.
- An edit adds only a new Output and a direct source ? result wire (the new Output's Source input). No Prompt, Generate or duplicate Image nodes are placed on the canvas. The source stores its inline request/settings/history; the backend snapshot expands these into validation/compiler inputs while the saved project graph stays compact. Each collection edit sends only its selected asset.
- Existing standalone workflows and earlier generated nodes are kept. Copies of inline controls get a new identity and independent batch history. Retry/resume use the saved batch request; a source is frozen while its inline batch runs. Failed submission removes the empty result and keeps the inline prompt for correction.
- Verified 87 frontend tests and 105 backend tests; the generated-image edit integration test additionally checks the direct Source wire. TypeScript/build pass; lint has existing warnings only. UI detector flagged the existing NodeShell border style, which belongs to the pinned Mun design and was retained. No browser was available for visual QA. No real AI quota was used for verification.
- Backend updated after idle; health exposes inline_result_edit so an older backend cannot silently interpret this request as a restyle.


## Regenerate stays in the inspector (2026-10-13)

- The user clarified that the canvas control is a symbol for the combined Prompt/Generate workflow, not a separate button opening an on-canvas form. Output nodes with inline generation now replace their existing gray output handle with the Generate symbol inside that same handle. No second circle appears beside it. It remains the real wire handle and supports dragging connections.
- The symbolic handle is 24 px (ordinary handles stay 14 px), using the current theme's accent fill and ink stroke. Removed the blue/green gradient. React Flow updates handle geometry when inline generation is first added.
- Regenerate and its editable prompt/details are back in the inspector toolbar. No edit form is rendered inside a canvas node. Saved graph/workflow behavior is unchanged.
- Verified 87 frontend tests, TypeScript/build and lint (existing warnings only). Existing Mun border styling retained. No real AI request or backend restart needed; Vite hot reload serves the changes. Visual browser QA remains unavailable.


## Retry edits the old prompt and original request (2026-10-13)

- Supersedes editing the displayed result as a new input: opening Retry now loads the exact prompt sent for that image. Edit it and run to regenerate from the original saved images/settings. A blank prompt retries the source image's old prompt unchanged. The old attempt remains immutable and old result images are kept.
- `POST /api/generations/{id}/retry` accepts optional `prompt` (200k limit); each new attempt retains the previous provider request/settings and uses the edited prompt. Frontend saves a directly connected result receiver for the exact slot/attempt before retrying. No helper Prompt/Generate nodes are added.
- Sidebar action uses a Retry arrow. Its prompt is optional and loads from task history, with loading/error states. Source handles keep the combined workflow symbol.
- Removed secondary notes/hints across inspectors, fields, sidebar, library, collection viewer, crop/extract tools, preview, provider dialog and empty canvas. Labels, metadata, actionable errors and editable user Notes remain.
- Verified 89 frontend tests, 108 backend tests, TypeScript/production build and lint (existing warnings only). UI detector returned no findings. No real AI request used for verification; visual browser QA unavailable. Backend advertises retry_prompt to prevent older servers silently ignoring prompt edits.


## Short request and full prompt (2026-10-13)

- Retry uses a neutral line icon with the same hover treatment as the other inspector actions; removed its orange circular fill.
- Opening Retry defaults to the original short user input. Full prompt expands a read-only preview underneath. Editing the short input updates that preview while preserving the template and additional input instructions; clearing it still retries the source request unchanged.
- Task responses include prompt_parts (prefix, user_prompt, suffix), recovered from the exact stored compiled template, including old tasks. Unknown/custom full prompts safely remain whole. No saved prompt/request is changed by opening or expanding the panel.
- Verified 90 frontend tests and 111 backend tests, TypeScript/production build and lint (existing warnings only); UI detector returned no findings. No real AI requests and no browser visual QA. Backend restarts after idle to expose prompt_parts.


## Inspector cleanup and concurrency removed (2026-10-13)

- Removed Concurrent requests entirely: no node field/default, preview setting or per-batch scheduling option. The worker runs one request at a time across all batches, ignoring legacy saved concurrency values. Project load strips the legacy field from Generate nodes; no project data migration is required.
- Generate inspector order: Preset ? Image (aspect, quality, format) ? Outputs (mode/count/primary) ? Run. Generate is available in the inspector; Preview uses an eye icon. Provider and run history move into collapsed Advanced.
- Result actions stay first. Rename moves inside File; Full/File/Generation labels are shorter and duplicate section headings are removed. Collection actions come before Advanced settings, palette colors before image extraction, and Extract review before Build.
- Secondary actions use consistent line icons with tooltips/accessible labels: copy prompt/HEX, add color/image, collection preview/expand/ungroup, image replace/download, duplicate/delete. Removed the inactive Import/Export toolbar entry. Primary Generate/Find/Build actions keep labels.
- Verified 90 frontend tests, 110 backend tests, TypeScript/production build and lint (existing warnings only). Sequential-worker tests also cover old projects requesting 2/4 concurrent requests. UI detector returned no findings. No real AI requests or browser visual QA. Backend restarts after idle to activate the sequential worker.


## Create Variation restored (2026-10-13)

- Added a shuffle-style Create Variation icon beside Retry in result actions (inspector and output collection cards). Creates the Image + Variation request Prompt + Create variation Generate workflow from the reference screenshot. The image references the current result asset and the Generate inherits its provider; users edit the branch and press Generate themselves. One undo step; no automatic AI request.
- Verified 91 frontend tests, TypeScript/build and lint (existing warnings only); UI detector no findings. Existing regenerate handle gradient now mixes the web's blue/green tokens with 35% white at the user's request. No backend change or real quota used.

## Variation follows Retry (2026-10-13)

- Supersedes the restored three-node variation branch: Variation opens the same sidebar prompt editor as Retry, with a short editable variation request and expandable Full prompt. Opening it previews the request without adding canvas nodes or generating an image.
- Generate variation uses the current result image and creates one directly connected output named Varied result. Prompt/Generate helpers exist only in the provider snapshot. The source uses the existing light blue-to-green combined handle. Failed submission removes the empty receiver.
- Verified 94 frontend tests, TypeScript/production build and lint (existing warnings only); UI detector no findings. No backend change or real AI request. Visual browser QA unavailable.

## Concurrent Generate nodes (2026-10-13)

- Generate nodes now run concurrently, within a project and across projects. Each Generate node still runs one request at a time across its batches; no concurrency option is exposed. Legacy concurrency values remain ignored. Supersedes the global sequential worker above.
- Scheduler skips busy nodes instead of blocking every other node behind the oldest batch. It also protects requests still finishing after cancellation/pause, and in-flight tasks not yet marked running in SQLite. Health exposes concurrent_generate_nodes; sequential_generation now describes requests within each node.
- Verified 112 backend tests, including gated-provider checks proving overlapping nodes across the same/different projects and sequential requests within each node. No real AI requests used. Backend restarts after idle to activate this change.

## Project WebSocket collaboration (2026-10-13)

- Replaced whole-canvas autosave with optimistic property edits in per-project WebSocket rooms. Local rendering is immediate; edits coalesce around 10 batches/second, and SQLite updates only changed objects. Same-field changes follow server order; different fields merge. Zoom/selection remain local.
- Added revision guards for HTTP graph replacement, ordered acknowledgements and persistent sequence deduplication, reconnect/reload rebase, bounded receiver queues, origin/host checks, heartbeat and generation locks enforced on the server. Undo/Redo preserve unrelated remote edits. Generate/project switching await sync acknowledgement; the existing concurrent-node worker remains unchanged.
- Verified a real two-client connection through Vite's proxy and a short isolated 100-client/100-project check (1,000 edits; localhost p95 acknowledgement 148.7 ms). This excludes Generate/browser rendering and is not a production capacity claim. See COLLABORATION.md for protocol, recovery and single-worker deployment limits.
- Final verification: 110 frontend tests and 122 backend tests pass. TypeScript/production build pass; lint has existing warnings only. Backend activates sync protocol version 1 after idle. No real AI quota used and no browser visual QA performed.

## Retry and Variation video placeholders (2026-10-13)

- Pending Retried results use the supplied Mun erasing clip; Varied results use Mun placing the paper triangle. The same placeholder appears on canvas and in the output inspector. Saved resultAction preserves the mapping through rename/reload/sync; older retry slots and Varied result titles have a fallback.
- Clips loop silently while starting/queued/running and show posters when inactive or reduced motion is enabled. Actual result images replace the placeholder. Encoded 640x360 H.264 without audio and with fast-start metadata: erasing 106 KB, placing 96 KB; original downloads untouched.
- Verified 110 frontend tests, TypeScript/build and lint (existing warnings only). Both posters inspected; UI detector no findings. No real generation or backend restart required.

## Move nodes during generation (2026-10-13)

- Running Generate/result nodes can now be dragged. Generation still freezes content, deletion, resize and connections; explicitly user-locked nodes remain immovable. Removed the not-allowed cursor from the running node shell.
- WebSocket property edits and revision-checked HTTP replacements both allow position changes while preserving the other server-side generation locks. Tests cover movement through both paths, blocked content edits/deletion, and frontend drag flags.
- Verified 111 frontend tests, 10 collaboration backend tests, TypeScript/build and lint (existing warnings only). Backend restarted after confirming no active tasks; health exposes moving_generating_nodes. LAN frontend remains on port 5173.

## Basic canvas annotations (2026-10-13)

- Added Text (T) and Draw (P) icons to the existing canvas toolbar. Click to place editable text; double-click existing text to edit. Freehand drawing uses a pointer-captured overlay and stores one movable node per stroke, in canvas coordinates. Existing Eraser (E), selection, duplicate, Delete and Undo/Redo work for both annotations.
- Annotation settings sit vertically immediately above the tools, using the same controls container and button style. Color is available for text/drawing; brush width uses a vertical slider. The controls no longer stretch when drawing settings appear. Text size/color and stroke color/width can also be changed in the inspector.
- Text/drawing have no generation ports and are not prompt inputs. They persist as graph objects and synchronize over the existing project WebSocket. New backend node types support saving/reloading them; no database migration or AI call is needed.
- Verified 114 frontend tests and 123 backend tests, TypeScript/build and lint (existing warnings only). Tests cover coordinate normalization, annotation erasing/Undo/Redo, WebSocket broadcast and reload. Backend restarted with no active jobs; LAN frontend remains live. Browser visual QA unavailable; toolbar placement follows the user's supplied screenshots.

## Text and comment refinements (2026-10-13)

- Plain text uses the same transparent appearance while creating, editing and viewing. Comment is available beside the color picker in the inspector and in the same toolbar settings box when placing text.
- Final comment shape has three fully rounded corners and one square bottom-left corner, a 2 px outline and no protruding tail. This supersedes the initial speech-bubble tail.
- Text resizes horizontally by hovering/dragging its left/right borders, without visible square handles or requiring selection. Width is saved/synchronized; height follows wrapped content automatically. Old fixed text heights are ignored. Editing uses an invisible text mirror so entering edit mode does not add height. Comment corners use a 40 px radius with a square bottom-left corner; padding is now 12 px like other node content, with a font-based minimum height. Explicit node locks disable resizing; resize participates in Undo/Redo.
- New Text defaults to 13 px like the app's node text; existing custom font sizes are preserved. A vertical font-size slider shares the color/comment settings box, available when placing Text or selecting existing Text. The inspector also uses a size slider. Brush size keeps its existing slider.
- Verified TypeScript/build, 115 frontend tests and lint (existing warnings only). No backend restart needed.

## Comment visual refresh (2026-10-13)

- Rebalanced comment cards: three 24 px rounded corners, square bottom-left, a 2 px ink outline and a subtle Mun blush fill. Padding is 14 px vertical / 18 px horizontal, line-height 1.5, minimum height 64 px and minimum resize width 144 px. This replaces the overly pill-shaped 40 px treatment above. Selected comments use the existing orange outline color.
- Retains custom font sizes, invisible border resize zones, automatic height, wrapping and identical edit/view geometry. No new controls or decorative labels.
- TypeScript/build and 117 frontend tests pass; lint has existing warnings only. Detector no findings. Browser inventory was empty, so no live browser visual check was possible. Changes are served by the running LAN frontend.

## Eraser hits drawing strokes (2026-10-13)

- Drawing nodes no longer erase on bounding-box click/entry. In Eraser mode their wrappers/SVG backgrounds are transparent to pointer hits; only the painted path or dot receives contact. Pointer down/drag over the actual stroke deletes that stroke, using the existing grouped eraser Undo and lock checks. Blank space inside its bounds is ignored, including with overlapping drawings. Stroke hover uses the existing danger color.
- TypeScript/build, lint (existing warnings only) and 117 frontend tests pass. No backend change or AI request.

- Eraser drag correction: React Flow's explicit node.draggable flags override the global nodesDraggable switch. Canvas now passes temporary non-draggable/non-connectable/non-selectable node flags in Eraser/Text/Draw modes. The store also ignores position changes in these modes, so blank bounding-box drags cannot move drawings; Select/Hand still permit movement. Added a regression test for eraser versus select drags.
