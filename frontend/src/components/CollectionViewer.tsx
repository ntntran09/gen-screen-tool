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
      <div className="mb-1.5 flex items-center gap-1.5">
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
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="border-t border-line px-4 py-2 text-[11px] text-ink-3">
          Drag cards to reorder. Disabled images stay in the collection but are skipped when generating. Removing an image
          never deletes its file.
        </footer>
      </div>
    </div>,
    document.body,
  );
}
