import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { drawnCrop, type CropBox } from '../graph/cropBox';
import type { DetectedAsset } from '../graph/types';
import { assetUrls } from '../lib/api';

const button = 'rounded-md border-2 border-outline px-3 py-1.5 text-[12px] hover:bg-accent-soft disabled:opacity-40';

export function CropEditor({ assetId, item, onSave, onClose }: {
  assetId: string;
  item: DetectedAsset;
  onSave: (box: CropBox) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const clipId = useId();
  const start = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<CropBox>(item);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = dialog.current;
    el?.showModal();
    return () => { el?.close(); previous?.focus(); };
  }, []);
  const point = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };
  const draw = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const next = drawnCrop(start.current, point(e));
    if (next) setBox(next);
  };
  const change = (key: keyof CropBox, value: number) => {
    if (!Number.isFinite(value)) return;
    setBox((old) => {
      const next = { ...old, [key]: Math.max(key === 'w' || key === 'h' ? 0.001 : 0, Math.min(key === 'x' || key === 'y' ? 0.999 : 1, value / 100)) };
      next.w = Math.min(next.w, 1 - next.x);
      next.h = Math.min(next.h, 1 - next.y);
      return next;
    });
  };
  return createPortal(
    <dialog ref={dialog} aria-labelledby="crop-title" onCancel={onClose}
      className="fixed inset-0 m-auto max-h-[94vh] w-[min(94vw,900px)] overflow-auto rounded-2xl border-2 border-outline bg-panel p-4 text-ink backdrop:bg-overlay"
      onKeyDown={(e) => e.stopPropagation()}>
      <header className="mb-3 flex items-center gap-3">
        <h2 id="crop-title" className="min-w-0 flex-1 break-words text-[16px] font-semibold">Adjust crop · {item.name}</h2>
        <button type="button" className={button} onClick={onClose}>Cancel</button>
      </header>
      
      <div className="flex flex-wrap items-start justify-center gap-4">
        <div className="relative max-w-full touch-none select-none overflow-hidden border-2 border-outline bg-panel-2"
          onPointerDown={(e) => { if (e.button !== 0 || failed) return; start.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={draw}
          onPointerUp={(e) => { draw(e); start.current = null; }}
          onPointerCancel={() => { start.current = null; }}>
          <img src={assetUrls.file(assetId)} alt="Source image. Drag to draw a crop." draggable={false}
            onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)} className="block max-h-[58vh] max-w-full cursor-crosshair" />
          {!failed && <div className="pointer-events-none absolute border-2 border-accent bg-accent/10"
            style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} />}
        </div>
        <div className="w-56 max-w-full space-y-3">
          <p className="text-[12px] font-medium">Crop preview</p>
          <div className="checkerboard relative aspect-square overflow-hidden rounded-lg border-2 border-outline">
            <svg role="img" aria-label={`Crop of ${item.name}`} className="size-full"
              viewBox={`${box.x * size.width} ${box.y * size.height} ${box.w * size.width} ${box.h * size.height}`}>
              <defs><clipPath id={clipId}><rect x={box.x * size.width} y={box.y * size.height} width={box.w * size.width} height={box.h * size.height} /></clipPath></defs>
              <image href={assetUrls.file(assetId)} width={size.width} height={size.height} clipPath={`url(#${clipId})`} />
            </svg>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(['x', 'y', 'w', 'h'] as const).map((key) => <label key={key} className="text-[12px] text-ink-2">
              {{ x: 'Left', y: 'Top', w: 'Width', h: 'Height' }[key]} (%)
              <input type="number" min={key === 'x' || key === 'y' ? 0 : 0.1} max={100} step={0.1}
                value={Number((box[key] * 100).toFixed(2))} onChange={(e) => change(key, e.target.valueAsNumber)}
                className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-ink" />
            </label>)}
          </div>
          {failed && <p role="alert" className="text-[12px] text-danger">Source image could not load. Close and reopen to retry.</p>}
          <button type="button" disabled={failed} className={`${button} w-full bg-accent font-medium text-accent-ink`} onClick={() => onSave(box)}>Save crop</button>
        </div>
      </div>
    </dialog>, document.body,
  );
}
