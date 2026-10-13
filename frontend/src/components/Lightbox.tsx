import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { assetUrls } from '../lib/api';
import { useAssetStore } from '../store/assetStore';
import { formatBytes } from './AssetThumb';

const MIN_ZOOM = 1;
const MAX_ZOOM = 16;
const btn = 'rounded-md border-2 border-outline bg-node px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-accent-soft';

/** Full-resolution image viewer (spec §6.4 "Full-screen preview"). Scroll, +/- keys or the buttons zoom; drag pans. */
export function Lightbox() {
  const previewId = useAssetStore((s) => s.previewId);
  const asset = useAssetStore((s) => (s.previewId ? s.assets[s.previewId] : undefined));
  const close = () => useAssetStore.getState().setPreview(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // Zoom about a point (relative to the stage centre) so the pixel under it stays put.
  const zoomBy = (factor: number, cx = 0, cy = 0) =>
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      if (zoom === MIN_ZOOM) return { zoom, x: 0, y: 0 };
      const k = zoom / v.zoom;
      return { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

  useEffect(() => setView({ zoom: 1, x: 0, y: 0 }), [previewId]);

  useEffect(() => {
    if (!previewId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useAssetStore.getState().setPreview(null);
      } else if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-') zoomBy(0.8);
      else if (e.key === '0') setView({ zoom: 1, x: 0, y: 0 });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [previewId]);

  // A non-passive wheel listener is needed to stop the page behind from scrolling.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [previewId]);

  if (!previewId) return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={asset?.name ?? 'Image preview'}
      className="fixed inset-0 z-50 flex flex-col bg-overlay-strong p-6"
      onMouseDown={close}
    >
      <div className="mb-3 flex items-center gap-3 text-[13px] text-white" onMouseDown={(e) => e.stopPropagation()}>
        <span className="font-semibold">{asset?.name}</span>
        {asset && (
          <span className="text-white/75">
            {asset.width}×{asset.height} · {asset.format} · {formatBytes(asset.file_size)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" aria-label="Zoom out" title="Zoom out (-)" className={btn} disabled={view.zoom <= MIN_ZOOM} onClick={() => zoomBy(0.8)}>
            −
          </button>
          <button type="button" aria-label="Reset zoom" title="Reset zoom (0)" className={`${btn} w-14 tabular-nums`} onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>
            {Math.round(view.zoom * 100)}%
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" className={btn} disabled={view.zoom >= MAX_ZOOM} onClick={() => zoomBy(1.25)}>
            +
          </button>
        </span>
        <a href={assetUrls.download(previewId)} className={btn}>
          Download
        </a>
        <button type="button" aria-label="Close preview" onClick={close} className={btn}>
          Close
        </button>
      </div>
      <div
        ref={stage}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setView((v) => (v.zoom > 1 ? { zoom: 1, x: 0, y: 0 } : v));
        }}
      >
        <img
          src={assetUrls.file(previewId)}
          alt={asset?.name ?? ''}
          draggable={false}
          className={`checkerboard max-h-full max-w-full rounded-lg border-2 border-outline object-contain ${view.zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => {
            if (view.zoom <= 1) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) setView((v) => ({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
        />
      </div>
    </div>,
    document.body,
  );
}
