import { nodeAssetId } from './collections';
import type { CanvasEdge, CanvasNode, DetectedAsset, ExtractData } from './types';

/**
 * The Asset sheet "asset selection" for the ticked detections: their names, each once (the model lists every
 * pot separately, but the preset shows each distinct asset a single time).
 */
export function selectionFromDetections(items: Pick<DetectedAsset, 'name'>[], off: number[]): string {
  const skip = new Set(off);
  const seen = new Set<string>();
  const names: string[] = [];
  items.forEach((it, i) => {
    const name = it.name.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    if (skip.has(i) || !name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    names.push(name);
  });
  return names.join(', ');
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
