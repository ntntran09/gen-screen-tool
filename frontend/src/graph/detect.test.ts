import { describe, expect, it } from 'vitest';
import { currentDetections, selectionFromDetections, sourceAssetFor } from './detect';
import type { CanvasEdge, CanvasNode, ExtractData } from './types';

describe('asset sheet selection', () => {
  it('skips unticked and empty names, strips braces, and lists each name once ignoring case', () => {
    const names = [' blue  pot ', 'Blue Pot', '{cat}', 'button', ' ', 'cat'];
    expect(selectionFromDetections(names.map((name) => ({ name })), [3])).toBe('blue pot, cat');
    expect(selectionFromDetections([{ name: 'cat' }], [0])).toBe('');
  });
});

describe('the image behind an Extract node', () => {
  const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as CanvasNode;
  const wire = (source: string, target: string, handle: string) => ({ id: `${source}-${target}`, source, target, targetHandle: handle }) as CanvasEdge;

  it("is the connected Image or Output node picture, and detections only count for that picture", () => {
    const nodes = [node('i', 'image', { assetId: 'a1' }), node('o', 'output', { assetId: 'a2' }), node('x', 'extract')];
    expect(sourceAssetFor(nodes, [wire('i', 'x', 'image')], 'x')).toBe('a1');
    expect(sourceAssetFor(nodes, [wire('o', 'x', 'image')], 'x')).toBe('a2');
    expect(sourceAssetFor(nodes, [], 'x')).toBeNull();
    const data = { detections: { assetId: 'a1', model: null, seconds: 1, items: [] } } as unknown as ExtractData;
    expect(currentDetections(data, 'a1')).not.toBeNull();
    expect(currentDetections(data, 'a2')).toBeNull();
    expect(currentDetections(data, null)).toBeNull();
  });
});
