import { useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usedAssetIds } from '../graph/collections';
import { useAssetPlacement, useImageImport } from '../hooks/useImageImport';
import type { AssetInfo } from '../lib/api';
import { pickImageFiles } from '../lib/filePicker';
import { useAssetStore } from '../store/assetStore';
import { useGraphStore } from '../store/graphStore';
import { MiniThumb } from './AssetThumb';
import { ASSET_DRAG_MIME } from './Canvas';

type Filter = 'all' | 'upload' | 'generated' | 'unused';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'upload', label: 'Uploaded' },
  { id: 'generated', label: 'Generated' },
  { id: 'unused', label: 'Unused' },
];

const smallBtn = 'rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-panel-2 hover:text-ink';
const dangerBtn = 'rounded-md border border-danger/50 px-2 py-1 text-[11px] text-danger hover:bg-danger-soft';

/** Every image stored in the project; drag onto the canvas, a node or a collection (spec Phase 2b). */
export function AssetLibrary() {
  const assets = useAssetStore(useShallow((s) => Object.values(s.assets)));
  const nodes = useGraphStore((s) => s.nodes);
  const importImages = useImageImport();
  const placeAssets = useAssetPlacement();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);

  const used = useMemo(() => usedAssetIds(nodes), [nodes]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .filter((a) =>
        filter === 'all'
          ? true
          : filter === 'unused'
            ? !used.has(a.id)
            : filter === 'upload'
              ? a.origin === 'upload'
              : a.origin !== 'upload',
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [assets, query, filter, used]);

  const selectedSet = new Set(selected.filter((id) => visible.some((a) => a.id === id)));
  const selectedAssets = visible.filter((a) => selectedSet.has(a.id));

  const onClick = (e: MouseEvent, asset: AssetInfo) => {
    if (e.shiftKey && anchor) {
      const ids = visible.map((a) => a.id);
      const [from, to] = [ids.indexOf(anchor), ids.indexOf(asset.id)].sort((x, y) => x - y);
      if (from >= 0) {
        setSelected(ids.slice(from, to + 1));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((cur) => (cur.includes(asset.id) ? cur.filter((id) => id !== asset.id) : [...cur, asset.id]));
    } else {
      setSelected(selectedSet.has(asset.id) && selectedSet.size === 1 ? [] : [asset.id]);
    }
    setAnchor(asset.id);
  };

  const onDragStart = (e: DragEvent, asset: AssetInfo) => {
    // Dragging a selected tile drags the whole selection; otherwise just that tile.
    const payload = selectedSet.has(asset.id) ? selectedAssets : [asset];
    e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(payload.map((a) => ({ id: a.id, name: a.name }))));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const remove = async () => {
    const ids = selectedAssets.map((a) => a.id);
    const inUse = ids.reduce((n, id) => n + (used.get(id) ?? 0), 0);
    const what = ids.length === 1 ? `"${selectedAssets[0].name}"` : `${ids.length} images`;
    const note = inUse
      ? `\n\n${inUse} place(s) on the canvas use them; those nodes and collection items will be emptied (Ctrl+Z restores the canvas, not the files).`
      : '';
    if (!window.confirm(`Delete ${what} from the library?${note}\n\nFiles are moved to the workspace backups folder, not erased.`)) return;
    const graph = useGraphStore.getState();
    try {
      const deleted = await useAssetStore.getState().remove(ids);
      graph.clearAssetRefs(ids);
      graph.showToast(`Deleted ${deleted.length} image${deleted.length === 1 ? '' : 's'}.`);
      setSelected([]);
    } catch (err) {
      graph.showToast((err as Error).message, 'error');
    }
  };

  const place = (group: boolean) => {
    const message = placeAssets(selectedAssets, { group });
    if (message) useGraphStore.getState().showToast(`${message}.`);
    setSelected([]);
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        <input
          type="search"
          aria-label="Search assets"
          placeholder="Search by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1 text-[12px] outline-none placeholder:text-ink-3 focus:border-focus"
        />
        <button
          type="button"
          className={smallBtn}
          title="Store images in the project without placing them on the canvas"
          onClick={() => void pickImageFiles(true).then((files) => importImages(files, { place: false }))}
        >
          Import
        </button>
      </div>
      <div role="radiogroup" aria-label="Filter assets" className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              filter === f.id ? 'border-outline bg-accent-soft font-semibold text-ink' : 'border-line text-ink-2 hover:bg-panel-2'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {selectedAssets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-panel-2 p-1.5 text-[11px]">
          <span className="text-ink-2">{selectedAssets.length} selected</span>
          <button type="button" className={smallBtn} onClick={() => place(false)}>
            Add as nodes
          </button>
          {selectedAssets.length > 1 && (
            <button type="button" className={smallBtn} onClick={() => place(true)}>
              New collection
            </button>
          )}
          <button type="button" className={dangerBtn} onClick={() => void remove()}>
            Delete
          </button>
          <button type="button" className="ml-auto px-1 text-ink-3 hover:text-ink" onClick={() => setSelected([])} aria-label="Clear selection">
            ×
          </button>
        </div>
      ) : (
        <p className="px-0.5 text-[11px] leading-snug text-ink-3">
          {assets.length === 0
            ? 'No images yet. Import some, or drop them on the canvas.'
            : 'Drag onto the canvas, a node or a collection. Ctrl/Shift+click to select several; double-click to preview.'}
        </p>
      )}

      {visible.length === 0 && assets.length > 0 && <p className="px-0.5 text-[12px] text-ink-3">No matching images.</p>}

      <ul className="grid grid-cols-2 gap-1.5">
        {visible.map((a) => {
          const isSelected = selectedSet.has(a.id);
          const uses = used.get(a.id) ?? 0;
          return (
            <li key={a.id}>
              <button
                type="button"
                draggable
                onDragStart={(e) => onDragStart(e, a)}
                onClick={(e) => onClick(e, a)}
                onDoubleClick={() => useAssetStore.getState().setPreview(a.id)}
                aria-pressed={isSelected}
                title={`${a.name}\n${a.width}×${a.height} · ${a.format}${uses ? `\nUsed ${uses}×` : '\nNot used on the canvas'}`}
                className={`block w-full cursor-grab rounded-lg border-2 p-1 text-left active:cursor-grabbing ${
                  isSelected ? 'border-accent bg-accent-soft' : 'border-transparent hover:border-line'
                }`}
              >
                <span className="checkerboard block aspect-square overflow-hidden rounded-md border border-outline">
                  <MiniThumb assetId={a.id} className="object-contain" />
                </span>
                <span className="mt-1 flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{a.name}</span>
                  {uses === 0 && <span className="text-[9px] uppercase tracking-wide text-ink-3">unused</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
