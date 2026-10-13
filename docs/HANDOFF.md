# NodeCanvas AI — Handoff

Ngày: 2026-10-12. Branch `master`. Chưa commit; chỉ commit khi user yêu cầu.

## Quyết định đã chốt

Chỉ 2 preset: Game screen restyle / Asset sheet, đặt trên Generate. User xác nhận bỏ Asset type và option cũ trên Prompt. Art direction dán vào Prompt. Backend thêm Palette/Theme/Reference trong ADDITIONAL INPUTS.

## Đã hoàn thiện

- Backend template/plan: Original bắt buộc cho cả 2 preset; operation edit.
- Frontend bỏ prompt option cũ, Generate hiện preset/aspect/quality và cảnh báo thiếu Original.
- Extract chỉ có input Image; Build asset sheet tạo Prompt + Generate (assets, manual, 1:1), nối ảnh nguồn trực tiếp; tên được chọn đi vào assetSelection. Bấm lại cập nhật Generate cũ; chặn locked/frozen, tạo lại khi Generate bị xoá.
- Tests và docs/STATUS.md cập nhật.
- Typecheck/build pass; frontend 71 tests pass; backend 79 tests pass. Lint 0 errors, còn React warnings; build warning bundle >500KB.

## Lưu ý

- Dùng lib/uuid.ts và lib/clipboard.ts cho LAN http; không dùng window.confirm.
- Backend validate toàn graph; edge Extract → collection cũ không còn hợp lệ, cần xoá trước Generate.
- Field cũ lưu trong project được bỏ qua; default preset screen.
- Không gọi provider thật khi smoke test; dùng fake provider và workspace riêng.
- Reply tiếng Việt ngắn gọn.

## Kiểm tra runtime

Backend thật chạy http://127.0.0.1:8787, health ok; không có batch queued/running trước khi khởi động. Frontend http://127.0.0.1:5173. Smoke test workspace riêng: Extract → Build asset sheet → Preview request → fake Generate → completed 1/1, output 512×512. Không gọi provider thật. Ảnh: .cache/preset-smoke.png.

## Thay đổi mới nhất: Build cắt ảnh, 2026-10-12

User yêu cầu khi bấm Build asset sheet: crop từng box → Asset Collection → Prompt xóa bg từng ảnh → Generate Match inputs. Đã thay luồng sheet toàn ảnh. Endpoint crop mới trong routers/detect.py lưu PNG origin=crop; Extract xuất extracted → collection.extract (chỉ input). Prompt mới Remove background, preset vẫn assets, selection single main asset, ratio match, mỗi crop 1 task. Build nâng cấp Generate cũ và tái dùng collection/gen. Copy remap cả 2 id. Cần restart backend sau thay endpoint. Xem STATUS.md.

Verification crop: frontend 72 tests pass, backend 85 tests pass; typecheck/build pass, lint 0 errors (React warnings). UI smoke on old workflow: Build upgrades to cropped Input Collection (2 PNGs, 78x103), Prompt Remove background; fake Generate completes 2/2. Backend restarted, no active batches before restart. Screenshot .cache/crop-workflow-smoke.png. Temporary smoke servers stopped.

## Distinct components, 2026-10-12

User wants one pot, one flower of each type, not each repeated flower-pot composite. analysis.PROMPT now requests one best visible representative per distinct type and separates reusable components; distinct colors/designs/states remain. Build stores target name + description in each collection item's promptOverride. Removal prompt isolates that target and excludes other objects, rather than relying on main-subject guessing. Existing detections require Find again, then Build to refresh crops and target instructions. Vision accuracy still needs user review; no real AI call made during verification.

Distinct-components verification: frontend 73 tests pass, backend 85 tests pass, typecheck/build pass; lint 0 errors with existing React warnings. Backend restarted after checking no active batches. Old generated removal prompt upgraded on Build; custom user prompts preserved.

## Crop localization correction, 2026-10-12

Inspected actual source PNG, persisted detections and saved crop. Plain pot box x=.32,y=.169,w=.126,h=.155 covers ice pot/shelf/next-row flowers. Pixel conversion is correct; automatic localization remains unreliable. No real AI call made.
Added Crop button per detection in Extract inspector: draw on original, preview exact region with correct proportions, edit percentages, Save/Cancel, native modal keyboard focus. Build again applies revised boxes; existing crop files are not rewritten automatically. Fixed MiniThumb conflicting object-cover/object-contain classes. UI checked draw/save/reopen/undo and restored original box after testing. Screenshot .cache/crop-editor-check.png shows manually corrected pot preview. Frontend typecheck/build and 75 tests pass; lint existing warnings only; Impeccable detector no findings.

## Detection reverted to original behavior, 2026-10-12

User explicitly dropped reusable/component extraction. Restored analysis.PROMPT verbatim from HEAD: find every separate visual asset, list each occurrence with its own box, no forced pot/flower split. Updated Extract explanatory copy/hint and prompt assertions. Crop editor and Build → collection → background-removal workflow retained. Existing detections require Find again and Build to refresh; no real AI calls. Frontend 75 tests, backend 85 tests, typecheck/build pass; lint existing warnings only.

## New workflow placement, 2026-10-12

User wants the generated Prompt directly above Cropped assets, as in their screenshot. New Prompt position now uses collection.x and collection.y - 260 instead of above Generate. Rebuilding keeps existing manually arranged nodes in place.
