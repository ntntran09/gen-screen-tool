# Project collaboration

The canvas uses optimistic property updates over `/api/projects/{id}/sync`. Each tab has its own client identity and joins only its open project. Local edits render immediately; the transport coalesces edits at roughly 10 batches/second, with one batch awaiting acknowledgement per client. Save and Generate flush the queue and wait for acknowledgement.

## Conflict rules

- Nodes and edges have stable IDs. Changes send only edited properties, not a complete canvas.
- Different nodes or different data fields merge. For the same field, the last update accepted by the server wins. Text and array-valued fields are atomic values, not character/item CRDTs.
- Deleting an object removes its edges. Delayed patches to a deleted object are ignored.
- The server serializes changes within each project and increments its graph revision. SQLite writes only changed objects in one transaction per batch.
- Undo/Redo history is rebased when remote changes arrive, so undoing a local change preserves unrelated remote edits.
- Viewport and selection stay local. Asset bytes travel through the asset endpoints; canvas edits carry asset IDs. New referenced asset metadata is fetched on receipt.

## Reconnect and persistence

The server sends a snapshot when connecting. Clients retain pending and unsent edits and rebase them onto that snapshot. Persistent per-client sequence receipts prevent replaying a committed batch after its acknowledgement was lost. Reload recovery uses a fresh client ID and checks the previous identity's receipt, so duplicated tabs do not share an editing identity.

Pending edits are cached in the tab's session storage after 800 ms and when the page is hidden/closed. This is best effort: browser storage exhaustion, a process crash before the cache is written, or closing the tab while offline can still lose uncommitted work. The UI marks disconnected edits as unsaved. Switching projects and starting generation wait for sync; they fail visibly if acknowledgement times out.

A missing event triggers reconnection rather than applying changes out of order. Heartbeats detect dead connections; reconnection backs off up to 5 seconds. A slow receiver has a bounded event queue and reconnects to a snapshot if it falls behind. Messages are limited to 1 MB and 1,000 operations; large batches are split by operation count.

Full-graph HTTP saves must include the current `graph_revision`; stale replacement returns `409 GRAPH_CONFLICT`. Renames and full replacements are broadcast to open tabs. Project deletion notifies peers. Server-side generation locks prevent deleting, editing or disconnecting active Generate/result nodes; position changes and completion metadata remain allowed. Nodes explicitly locked by the user remain immovable.

## Deployment and scope

Run **one backend process / one Uvicorn worker**. Project rooms, caches and ordering locks are in memory. Multiple workers/instances require shared pub/sub plus a document owner or distributed ordering mechanism; adding workers alone is not supported.

Vite proxies WebSocket upgrades under `/api` and rewrites Origin only for requests from its own origin. Backend Host/Origin checks apply before accepting the socket. This retains the app's existing local/LAN access model; it does not add accounts, project permissions, collaborator cursors or presence. Production reverse proxies must forward WebSocket upgrades, use HTTPS/WSS and configure trusted frontend origins.

Generate nodes run concurrently across nodes/projects; requests within each node stay sequential.

## Verification

Tests cover ordered room broadcasts, project isolation, same-field conflicts, duplicate receipts, reconnect/reload recovery, stale HTTP saves, atomic rejection, deleted objects/projects, generation locks, optimistic rendering, throttled edits and Undo preserving remote changes. A real two-client smoke check through the running Vite proxy verified broadcast and database persistence.

A short isolated localhost check used 100 sockets across 100 projects with 50 nodes each and acknowledged 1,000 edits in 1.45 seconds (median acknowledgement 112.3 ms, p95 148.7 ms). This checks the sync path only; it is not a production capacity guarantee and excludes image generation, WAN latency and browser rendering. The reusable check is `.cache/check-project-sync.py` (local helper, not committed).
