import { useState } from 'react';
import { assetUrls } from '../lib/api';
import { useAssetStore } from '../store/assetStore';

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Thumbnail for an asset id, with empty and missing-file states (spec §29.8). */
export function AssetThumb({
  assetId,
  emptyLabel,
  onChoose,
}: {
  assetId: string | null;
  emptyLabel: string;
  onChoose?: () => void;
}) {
  const asset = useAssetStore((s) => (assetId ? s.assets[assetId] : undefined));
  const [failed, setFailed] = useState(false);

  if (!assetId) {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line-strong bg-panel text-center text-[11px] text-ink-3">
        <span>{emptyLabel}</span>
        {onChoose && (
          <button
            type="button"
            className="nodrag rounded-md border-2 border-outline bg-node px-2 py-1 text-[11px] font-medium text-ink hover:bg-accent-soft"
            onClick={onChoose}
          >
            Choose image
          </button>
        )}
      </div>
    );
  }

  if (asset?.missing || failed) {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-danger/60 bg-danger-soft text-center text-[11px] text-danger">
        <span className="font-semibold">Image file missing</span>
        <span className="px-2 text-danger/80">{asset?.name ?? 'Unknown asset'}</span>
      </div>
    );
  }

  return (
    <div className="checkerboard overflow-hidden rounded-lg border-2 border-outline">
      <img
        src={assetUrls.thumbnail(assetId)}
        alt={asset?.name ?? ''}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className="block aspect-square w-full object-contain"
      />
    </div>
  );
}

export function AssetCaption({ assetId }: { assetId: string | null }) {
  const asset = useAssetStore((s) => (assetId ? s.assets[assetId] : undefined));
  if (!asset) return null;
  return (
    <p className="mt-1.5 truncate text-[11px] text-ink-3" title={asset.name}>
      {asset.width}×{asset.height} · {asset.format}
    </p>
  );
}

/** Small square thumbnail for grids; a missing file shows a red tile instead of a broken image. */
export function MiniThumb({ assetId, className = '' }: { assetId: string; className?: string }) {
  const missing = useAssetStore((s) => s.assets[assetId]?.missing);
  const [failed, setFailed] = useState(false);
  if (missing || failed) {
    return (
      <span
        className={`flex size-full items-center justify-center bg-danger-soft text-[10px] font-semibold text-danger ${className}`}
        title="Image file missing"
      >
        !
      </span>
    );
  }
  return (
    <img
      src={assetUrls.thumbnail(assetId)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className={`size-full object-cover ${className}`}
    />
  );
}
