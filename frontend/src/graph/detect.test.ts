import { describe, expect, it } from 'vitest';
import { assetPrompt, currentDetections, gridPositions, locationPhrase, sourceAssetFor, uniqueNames } from './detect';
import type { CanvasEdge, CanvasNode, ExtractData } from './types';

describe('detect helpers', () => {
  it('numbers repeated names, ignoring case, and never returns an empty name', () => {
    expect(uniqueNames(['blue pot', 'Blue Pot', 'button', 'blue pot', '  '])).toEqual(['blue pot', 'Blue Pot 2', 'button', 'blue pot 3', 'asset']);
  });

  it('lays nodes out in a grid from the origin', () => {
    expect(gridPositions({ x: 10, y: 20 }, 5, 2, 100, 50)).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 10, y: 70 },
      { x: 110, y: 70 },
      { x: 10, y: 120 },
    ]);
  });
});

describe('where an asset is', () => {
  const at = (x: number, y: number, w = 0.1, h = 0.1) => ({ x, y, w, h });

  it('names the third of the image its centre falls in, with rough percentages', () => {
    expect(locationPhrase(at(0.05, 0.05))).toBe('top left (about 5-15% across, 5-15% down)');
    expect(locationPhrase(at(0.45, 0.45))).toBe('center (about 45-55% across, 45-55% down)');
    expect(locationPhrase(at(0.85, 0.9))).toBe('bottom right (about 85-95% across, 90-100% down)');
    expect(locationPhrase(at(0.45, 0.05))).toContain('top center');
    expect(locationPhrase(at(0.9, 0.5, 0.5, 0.5))).toContain('100% across'); // never past the image edge
  });

  it('asks for exactly one asset, by name, description and place, without placeholder braces', () => {
    const text = assetPrompt({ name: 'blue {asset_name} pot', description: '  a  pot ', ...at(0.1, 0.1) });
    expect(text).toContain('"blue asset_name pot" (a pot)');
    expect(text).toContain('ONLY this one asset');
    expect(text).toContain('top left');
    expect(assetPrompt({ name: 'cat', description: '', ...at(0, 0.8) })).toContain('"cat". It is in');
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
