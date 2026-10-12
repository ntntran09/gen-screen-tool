import { nanoid } from 'nanoid';
import type { CanvasNode, CollectionData, CollectionItem, NodeKind } from './types';

/** Node kinds that hold exactly one image and can be grouped into a collection. */
export const SINGLE_IMAGE_KINDS: readonly NodeKind[] = ['image', 'output'];

export function nodeAssetId(node: CanvasNode): string | null {
  if (!SINGLE_IMAGE_KINDS.includes(node.type!)) return null;
  const id = (node.data as { assetId?: unknown }).assetId;
  return typeof id === 'string' ? id : null;
}

export function makeItems(assetIds: string[]): CollectionItem[] {
  return assetIds.map((assetId) => ({ id: nanoid(10), assetId, enabled: true, promptOverride: '' }));
}

/** Move the item at `from` so it ends up at index `to` (indexes in the original list). */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

export function collectionItems(node: CanvasNode | undefined): CollectionItem[] {
  if (node?.type !== 'collection') return [];
  const items = (node.data as CollectionData).items;
  return Array.isArray(items) ? items : [];
}

/** Reading order on the canvas: rows top to bottom (within ~half a node height), then left to right. */
export function readingOrder(nodes: CanvasNode[]): CanvasNode[] {
  const ROW = 120;
  return [...nodes].sort(
    (a, b) => Math.round(a.position.y / ROW) - Math.round(b.position.y / ROW) || a.position.x - b.position.x,
  );
}

/** Every asset id the graph points at (single-image nodes and collection items). */
export function usedAssetIds(nodes: CanvasNode[]): Map<string, number> {
  const used = new Map<string, number>();
  const add = (id: string) => used.set(id, (used.get(id) ?? 0) + 1);
  for (const n of nodes) {
    const id = nodeAssetId(n);
    if (id) add(id);
    for (const item of collectionItems(n)) add(item.assetId);
  }
  return used;
}
