import { describe, expect, it } from 'vitest';
import { makeItems, moveItem, usedAssetIds } from './collections';
import type { CanvasNode } from './types';

describe('collections', () => {
  it('moves items', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b'], 1, 9)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
  });

  it('makes enabled items with unique ids', () => {
    const items = makeItems(['x', 'x']);
    expect(items[0].id).not.toBe(items[1].id);
    expect(items.every((i) => i.enabled && i.promptOverride === '')).toBe(true);
  });

  it('counts asset usage across nodes and collections', () => {
    const nodes = [
      { id: '1', type: 'image', position: { x: 0, y: 0 }, data: { assetId: 'a' } },
      { id: '2', type: 'collection', position: { x: 0, y: 0 }, data: { items: makeItems(['a', 'b']) } },
      { id: '3', type: 'prompt', position: { x: 0, y: 0 }, data: {} },
    ] as unknown as CanvasNode[];
    const used = usedAssetIds(nodes);
    expect(used.get('a')).toBe(2);
    expect(used.get('b')).toBe(1);
    expect(used.size).toBe(2);
  });
});
