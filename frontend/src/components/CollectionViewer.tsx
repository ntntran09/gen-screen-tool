import { useEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { collectionItems, makeItems, moveItem } from '../graph/collections';
import type { CollectionData, CollectionItem } from '../graph/types';
import { isSupportedImage, useImageImport } from '../hooks/useImageImport';
import { pickImageFiles } from '../lib/filePicker';
import { useAssetStore } from '../store/assetStore';
import { useGraphStore } from '../store/graphStore';
import { ASSET_DRAG_MIME } from './Canvas';
import { MiniThumb } from './AssetThumb';
import { assetUrls } from '../lib/api';
import { isRunning, latestAttempts, useGenerationStore } from '../store/generationStore';
import { OutputActions } from './OutputActions';

const ITEM_DRAG_MIME = 'application/x-nodecanvas-collection-item';

const smallBtn =
  'rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-panel-2 hover:text-ink disabled:pointer-events-none disabled:opacity-30';
const headerBtn =
  'rounded-md border-2 border-outline bg-node px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-accent-soft disabled:pointer-events-none disabled:opacity-40';

function ItemCard({
  item,
  index,
  count,
  readOnly,
  showOverride,
  onChange,
  onMove,
  onRemove,
  dropHint,
  onDragOverCard,
  onDropCard,
  selected,
  onSelect,
  outputActions,
}: {
  item: CollectionItem;
  index: number;
  count: number;
  readOnly: boolean;
  showOverride: boolean;
  onChange: (patch: Partial<CollectionItem>, coalesceKey?: string) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  dropHint: boolean;
  onDragOverCard: (e: DragEvent) => void;
  onDropCard: (e: DragEvent) => void;
  selected: boolean;
  onSelect: () => void;
  outputActions?: React.ReactNode;
}) {
  const asset = useAssetStore((s) => s.assets[item.assetId]);
  return (
    <li
      className={`flex flex-col rounded-xl border-2 bg-node p-2 ${dropHint ? 'border-accent' : 'border-outline'} ${
        item.enabled ? '' : 'bg-panel-2'
      }`}
      draggable={!readOnly}
      onDragStart={(e) => {
        e.dataTransfer.setData(ITEM_DRAG_MIME, String(index));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={onDragOverCard}
      onDrop={onDropCard}
    >
      {outputActions}
      <div className="mb-1.5 flex items-center gap-1.5">
        <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select image ${index + 1}`} />
        <span className="rounded bg-panel-2 px-1.5 font-mono text-[10px] text-ink-2">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink" title={asset?.name}>
          {asset?.name ?? 'Unknown image'}
        </span>
        <label className="flex items-center gap-1 text-[11px] text-ink-2" title="Disabled images are skipped by generation">
          <input
            type="checkbox"
            checked={item.enabled}
            disabled={readOnly}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            className="accent-[var(--color-accent)]"
          />
          On
        </label>
      </div>
      <button
        type="button"
        className={`checkerboard block aspect-square overflow-hidden rounded-lg border-2 border-outline ${item.enabled ? '' : 'opacity-40'}`}
        onClick={() => useAssetStore.getState().setPreview(item.assetId)}
        aria-label={`View ${asset?.name ?? 'image'} full size`}
      >
        <MiniThumb assetId={item.assetId} className="object-contain" />
      </button>
      {asset && (
        <p className="mt-1 text-[10px] text-ink-3">
          {asset.width}×{asset.height} · {asset.format}
        </p>
      )}
      {showOverride && (
        <textarea
          aria-label={`Prompt override for image ${index + 1}`}
          placeholder="Extra prompt for this image only"
          rows={2}
          readOnly={readOnly}
          value={item.promptOverride}
          onChange={(e) => onChange({ promptOverride: e.target.value }, `override:${item.id}`)}
          className="mt-1.5 w-full resize-y rounded-md border border-line bg-panel-2 px-1.5 py-1 text-[11px] leading-snug text-ink outline-none placeholder:text-ink-3 focus:border-focus"
        />
      )}
      {!readOnly && (
        <div className="mt-1.5 flex gap-1">
          <button type="button" className={smallBtn} disabled={index === 0} onClick={() => onMove(index - 1)} aria-label="Move earlier">
            ←
          </button>
          <button type="button" className={smallBtn} disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label="Move later">
            →
          </button>
          <button type="button" className={`${smallBtn} ml-auto hover:text-danger`} onClick={onRemove}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

/** Full-screen grid for one collection: order, enable, per-image prompt, add and remove (spec Phase 2b). */
export function CollectionViewer() {
  const nodeId = useAssetStore((s) => s.viewerNodeId);
  const node = useGraphStore((s) => (nodeId ? s.nodes.find((n) => n.id === nodeId) : undefined));
  const setItems = useGraphStore((s) => s.setCollectionItems);
  const importImages = useImageImport();
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ nodeId: string; ids: string[] }>({ nodeId: '', ids: [] });
  const generationTasks = useGenerationStore((s) => s.tasks);
  const projectId = useGraphStore((s) => s.projectId);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => useAssetStore.getState().openViewer(null);

  const open = Boolean(nodeId && node?.type === 'collection');

  // Close if the node disappears (deleted, undone, project switched).
  useEffect(() => {
    if (nodeId && !open) useAssetStore.getState().openViewer(null);
  }, [nodeId, open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    // Bubble phase: the Lightbox listens in capture phase and stops Escape when it is on top.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useAssetStore.getState().openViewer(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open]);

  if (!open || !node) return null;
  const data = node.data as CollectionData;
  const items = collectionItems(node);
  const readOnly = data.locked;
  const canAdd = !readOnly && data.role === 'input';
  const enabled = items.filter((i) => i.enabled).length;
  const selectedIds = selection.nodeId === node.id ? selection.ids : [];
  const selectedItems = items.filter((i) => selectedIds.includes(i.id));
  const select = (ids: string[]) => setSelection({ nodeId: node.id, ids });
  const outputTasks = (data.batchIds ?? []).flatMap((id) => generationTasks[id] ?? []);

  const update = (next: CollectionItem[], key?: string) => setItems(node.id, next, key);
  const patchItem = (id: string, patch: Partial<CollectionItem>, key?: string) =>
    update(items.map((i) => (i.id === id ? { ...i, ...patch } : i)), key);
  const addFiles = async (files: File[]) => {
    if (files.length) await importImages(files, { collectionNodeId: node.id });
  };

  const onDragOver = (e: DragEvent, index: number | null) => {
    const types = e.dataTransfer.types;
    const internal = types.includes(ITEM_DRAG_MIME);
    if (readOnly || (!internal && !(canAdd && (types.includes('Files') || types.includes(ASSET_DRAG_MIME))))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    setDropIndex(index);
  };

  const onDrop = (e: DragEvent, index: number | null) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setDropIndex(null);
    const from = e.dataTransfer.getData(ITEM_DRAG_MIME);
    if (from !== '') {
      const to = index ?? items.length - 1;
      update(moveItem(items, Number(from), to));
      return;
    }
    if (!canAdd) return;
    const library = e.dataTransfer.getData(ASSET_DRAG_MIME);
    if (library) {
      try {
        const assets = JSON.parse(library) as { id: string }[];
        update([...items, ...makeItems(assets.map((a) => a.id))]);
      } catch {
        /* ignore malformed payloads */
      }
      return;
    }
    void addFiles(Array.from(e.dataTransfer.files).filter(isSupportedImage));
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Collection: ${data.title}`}
      className="fixed inset-0 z-40 flex items-stretch justify-center bg-overlay p-6"
      onMouseDown={close}
    >
      <div
        className="flex w-full max-w-6xl flex-col overflow-hidden rounded-2xl border-2 border-outline bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
        onDragOver={(e) => onDragOver(e, null)}
        onDragLeave={() => setDropIndex(null)}
        onDrop={(e) => onDrop(e, null)}
      >
        <header className="flex flex-wrap items-center gap-2 border-b-2 border-outline px-4 py-3">
          <div className="mr-auto min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ink">{data.title}</h2>
            <p className="text-[12px] text-ink-3">
              {data.role === 'input' ? 'Input' : 'Output'} collection · {items.length} {items.length === 1 ? 'image' : 'images'}
              {enabled !== items.length && ` · ${enabled} enabled`}
              {readOnly && ' · Locked (read-only)'}
            </p>
          </div>
          {canAdd && (
            <button type="button" className={headerBtn} onClick={() => void pickImageFiles(true).then(addFiles)}>
              Add images
            </button>
          )}
          <button
            type="button"
            className={headerBtn}
            disabled={readOnly || enabled === items.length}
            onClick={() => update(items.map((i) => ({ ...i, enabled: true })))}
          >
            Enable all
          </button>
          <button
            type="button"
            className={headerBtn}
            disabled={readOnly || enabled === 0}
            onClick={() => update(items.map((i) => ({ ...i, enabled: false })))}
          >
            Disable all
          </button>
          <button ref={closeRef} type="button" className={headerBtn} onClick={close}>
            Close
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
          <button type="button" className={headerBtn} onClick={() => select(items.map((i) => i.id))} disabled={!items.length}>Select all</button>
          <button type="button" className={headerBtn} onClick={() => select([])} disabled={!selectedItems.length}>Clear selection</button>
          <span className="text-[12px] text-ink-2">{selectedItems.length} selected</span>
          {projectId && selectedItems.length > 0 && <a className={headerBtn}
            href={assetUrls.selected(projectId, selectedItems.map((i) => i.assetId))}>Download Selected</a>}
          {data.role === 'output' && <button type="button" className={headerBtn} disabled={readOnly || !selectedItems.length}
            onClick={() => useGraphStore.getState().expandCollection(node.id, selectedIds)}>Expand selected to nodes</button>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line-strong text-center text-[13px] text-ink-3">
              {canAdd ? 'Drop or paste images here, or use “Add images”.' : 'This collection is empty.'}
            </div>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
              {items.map((item, i) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  index={i}
                  count={items.length}
                  readOnly={readOnly}
                  showOverride={data.role === 'input'}
                  onChange={(patch, key) => patchItem(item.id, patch, key)}
                  onMove={(to) => update(moveItem(items, i, to))}
                  onRemove={() => update(items.filter((x) => x.id !== item.id))}
                  dropHint={dropIndex === i}
                  onDragOverCard={(e) => onDragOver(e, i)}
                  onDropCard={(e) => onDrop(e, i)}
                  selected={selectedIds.includes(item.id)}
                  onSelect={() => select(selectedIds.includes(item.id) ? selectedIds.filter((id) => id !== item.id) : [...selectedIds, item.id])}
                  outputActions={data.role === 'output' && !readOnly ? (() => {
                    const task = outputTasks.find((t) => t.output_asset_id === item.assetId);
                    return <OutputActions key={item.assetId} nodeId={node.id} assetId={item.assetId} batchId={task?.batch_id} taskId={task?.id} />;
                  })() : undefined}
                />
              ))}
            </ul>
          )}
          {data.role === 'output' && (data.batchIds ?? []).map((id) => <FailedItems key={id} batchId={id} readOnly={readOnly} />)}
        </div>


      </div>
    </div>,
    document.body,
  );
}

function FailedItems({ batchId, readOnly }: { batchId: string; readOnly: boolean }) {
  const tasks = useGenerationStore((s) => s.tasks[batchId]);
  const batch = useGenerationStore((s) => s.batches[batchId]);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!tasks) void useGenerationStore.getState().loadTasks(batchId).catch((err: Error) =>
      useGraphStore.getState().showToast(err.message, 'error'));
  }, [batchId, tasks]);
  const failed = latestAttempts(tasks).filter((t) => t.status === 'failed' || t.status === 'interrupted');
  if (!failed.length) return null;
  return <section aria-label="Failed images" className="mt-4 border-t border-line pt-3">
    <h3 className="mb-2 text-[13px] font-semibold">Failed images</h3>
    <ul className="space-y-2">{failed.map((task) => <li key={task.id} className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="font-medium">{task.source_name ?? `Image ${task.slot_index + 1}`} v{task.variant_index}</span>
      <span className="text-danger">{task.error_message ?? task.error_code}</span>
      <button type="button" className={headerBtn} disabled={readOnly || pending || isRunning(batch)} onClick={async () => {
        setPending(true);
        try { await useGenerationStore.getState().retry(batchId, [task.id]); } finally { setPending(false); }
      }}>Retry image</button>
    </li>)}</ul>
  </section>;
}
