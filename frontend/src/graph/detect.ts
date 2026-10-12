import { nodeAssetId } from './collections';
import type { CanvasEdge, CanvasNode, DetectedAsset, ExtractData } from './types';

/** Make names unique by numbering repeats ("blue pot", "blue pot 2", ...). Case-insensitive. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = raw.trim() || 'asset';
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? name : `${name} ${n}`;
  });
}

/** Top-left positions for `count` nodes in a grid of `columns`, starting at `origin`. */
export function gridPositions(origin: { x: number; y: number }, count: number, columns = 4, dx = 230, dy = 290) {
  return Array.from({ length: count }, (_, i) => ({ x: origin.x + (i % columns) * dx, y: origin.y + Math.floor(i / columns) * dy }));
}

const pct = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100);

/** Where a box is, in words and rough percentages: "top left (about 8-28% across, 8-23% down)". */
export function locationPhrase(box: Pick<DetectedAsset, 'x' | 'y' | 'w' | 'h'>): string {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const col = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'center' : 'right';
  const row = cy < 1 / 3 ? 'top' : cy < 2 / 3 ? 'middle' : 'bottom';
  const area = row === 'middle' && col === 'center' ? 'center' : `${row} ${col}`;
  return `${area} (about ${pct(box.x)}-${pct(box.x + box.w)}% across, ${pct(box.y)}-${pct(box.y + box.h)}% down)`;
}

/**
 * The instruction that points one redraw at one asset in the full image. The boxes are only a guide to
 * where the asset is (they are approximate), so the words and the location do the work.
 */
export function assetPrompt(asset: DetectedAsset): string {
  const clean = (v: string) => v.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  const about = clean(asset.description);
  return (
    `Take ONLY this one asset from the original image: "${clean(asset.name)}"${about ? ` (${about})` : ''}. ` +
    `It is in the ${locationPhrase(asset)} of the image. Ignore everything else in the image.`
  );
}

/** The asset of the image connected to an Extract node's Image port, if any. */
export function sourceAssetFor(nodes: CanvasNode[], edges: CanvasEdge[], nodeId: string): string | null {
  const edge = edges.find((e) => e.target === nodeId && e.targetHandle === 'image');
  const source = edge && nodes.find((n) => n.id === edge.source);
  return source ? nodeAssetId(source) : null;
}

/** The node's detections if they are for the image that is connected right now. */
export function currentDetections(data: ExtractData, assetId: string | null) {
  return data.detections && data.detections.assetId === assetId ? data.detections : null;
}
