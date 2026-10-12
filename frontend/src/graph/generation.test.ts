import { describe, expect, it } from 'vitest';
import { extractedCollection, generateNeedsOriginal, originalEdgeRoles } from './generation';
import { getDefinition } from './registry';
import type { CanvasEdge, CanvasNode, NodeKind } from './types';

const node = (id: string, type: NodeKind, data: Record<string, unknown> = {}): CanvasNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: { ...getDefinition(type).defaultData(), ...data } }) as CanvasNode;
const wire = (source: string, handle = 'original'): CanvasEdge => ({
  id: `${source}-${handle}`,
  source,
  sourceHandle: 'out',
  target: 'g',
  targetHandle: handle,
});

describe('originalEdgeRoles', () => {
  const images = [node('a', 'image'), node('b', 'image'), node('col', 'collection')];

  it('Match inputs uses every original', () => {
    const nodes = [...images, node('g', 'generate', { mode: 'match' })];
    const roles = originalEdgeRoles(nodes, [wire('a'), wire('b')], 'g');
    expect([...roles.values()]).toEqual(['used', 'used']);
  });

  it('a single original is simply used', () => {
    const nodes = [...images, node('g', 'generate', { mode: 'manual' })];
    expect([...originalEdgeRoles(nodes, [wire('a')], 'g').values()]).toEqual(['used']);
  });

  it('Manual count with several originals asks for a choice, then marks primary and secondary', () => {
    const edges = [wire('a'), wire('b'), wire('col'), wire('a', 'prompt')];
    const undecided = originalEdgeRoles([...images, node('g', 'generate', { mode: 'manual' })], edges, 'g');
    expect([...undecided.values()]).toEqual(['candidate', 'candidate', 'candidate']); // the prompt wire is not listed

    const chosen = originalEdgeRoles([...images, node('g', 'generate', { mode: 'manual', primaryOriginalNodeId: 'b' })], edges, 'g');
    expect(chosen.get('a-original')).toBe('secondary');
    expect(chosen.get('b-original')).toBe('primary');
    expect(chosen.get('col-original')).toBe('secondary');
  });

  it('a collection or a disconnected node can never be primary', () => {
    const edges = [wire('a'), wire('col')];
    for (const primary of ['col', 'gone']) {
      const roles = originalEdgeRoles([...images, node('g', 'generate', { mode: 'manual', primaryOriginalNodeId: primary })], edges, 'g');
      expect([...roles.values()]).toEqual(['candidate', 'candidate']);
    }
  });
});

describe('generateNeedsOriginal', () => {
  const promptWire = { id: 'pw', source: 'p', sourceHandle: 'out', target: 'g', targetHandle: 'prompt' } as CanvasEdge;

  it('is false for plain text-to-image in Manual count', () => {
    const nodes = [node('p', 'prompt'), node('g', 'generate', { mode: 'manual', aspectRatio: '1:1' })];
    expect(generateNeedsOriginal(nodes, [promptWire], 'g')).toBe(false);
  });

  it('is true for Match inputs, Match original aspect, or a Game Screen prompt', () => {
    expect(generateNeedsOriginal([node('g', 'generate', { mode: 'match' })], [], 'g')).toBe(true);
    expect(generateNeedsOriginal([node('g', 'generate', { mode: 'manual', aspectRatio: 'match' })], [], 'g')).toBe(true);
    const screen = [node('p', 'prompt', { assetCategory: 'Game Screen' }), node('g', 'generate', { mode: 'manual', aspectRatio: '1:1' })];
    expect(generateNeedsOriginal(screen, [promptWire], 'g')).toBe(true);
    expect(generateNeedsOriginal(screen, [], 'g')).toBe(false); // that prompt is not connected
  });
});

describe('extractedCollection', () => {
  const link = (source: string, target: string, handle: string) => ({ id: `${source}-${target}`, source, sourceHandle: 'out', target, targetHandle: handle }) as CanvasEdge;

  it('finds the collection on the Assets port, and nothing for a node without one', () => {
    const nodes = [node('x', 'extract'), node('c', 'collection', { role: 'input' }), node('other', 'collection')];
    expect(extractedCollection(nodes, [link('x', 'c', 'extract')], 'x')?.id).toBe('c');
    expect(extractedCollection(nodes, [link('x', 'c', 'in')], 'x')).toBeNull(); // wrong port
    expect(extractedCollection(nodes, [], 'x')).toBeNull();
  });
});
