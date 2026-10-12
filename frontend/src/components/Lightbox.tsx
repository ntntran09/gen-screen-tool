import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { assetUrls } from '../lib/api';
import { useAssetStore } from '../store/assetStore';
import { formatBytes } from './AssetThumb';

/** Full-resolution image viewer (spec §6.4 "Full-screen preview"). */
export function Lightbox() {
  const previewId = useAssetStore((s) => s.previewId);
  const asset = useAssetStore((s) => (s.previewId ? s.assets[s.previewId] : undefined));
  const close = () => useAssetStore.getState().setPreview(null);

  useEffect(() => {
    if (!previewId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useAssetStore.getState().setPreview(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [previewId]);

  if (!previewId) return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={asset?.name ?? 'Image preview'}
      className="fixed inset-0 z-50 flex flex-col bg-overlay p-6"
      onMouseDown={close}
    >
      <div className="mb-3 flex items-center gap-3 text-[13px] text-white" onMouseDown={(e) => e.stopPropagation()}>
        <span className="font-semibold">{asset?.name}</span>
        {asset && (
          <span className="text-white/75">
            {asset.width}×{asset.height} · {asset.format} · {formatBytes(asset.file_size)}
          </span>
        )}
        <a
          href={assetUrls.download(previewId)}
          className="ml-auto rounded-md border-2 border-outline bg-node px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-accent-soft"
        >
          Download
        </a>
        <button
          type="button"
          aria-label="Close preview"
          onClick={close}
          className="rounded-md border-2 border-outline bg-node px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-accent-soft"
        >
          Close
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <img
          src={assetUrls.file(previewId)}
          alt={asset?.name ?? ''}
          className="checkerboard max-h-full max-w-full rounded-lg border-2 border-outline object-contain"
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    </div>,
    document.body,
  );
}
