import { describe, expect, it } from 'vitest';
import { getDefinition, OUT } from './registry';
import type { CanvasEdge, CanvasNode, NodeKind } from './types';
import { checkConnection, createsCycle } from './validation';

function node(id: string, kind: NodeKind, patch: Record<string, unknown> = {}): CanvasNode {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { ...getDefinition(kind).defaultData(), ...patch } };
}

const edge = (source: string, target: string, targetHandle: string | null, sourceHandle = OUT): CanvasEdge => ({
  id: `${source}-${target}-${targetHandle}`,
  source,
  sourceHandle,
  target,
  targetHandle,
});

const conn = (source: string, target: string, targetHandle: string) => ({
  source,
  sourceHandle: OUT,
  target,
  targetHandle,
});

describe('checkConnection', () => {
  const nodes = [
    node('p', 'prompt'),
    node('o', 'original'),
    node('t', 'theme'),
    node('pal1', 'palette'),
    node('pal2', 'palette'),
    node('img', 'image'),
    node('cin', 'collection', { role: 'input' }),
    node('cout', 'collection', { role: 'output' }),
    node('g', 'generate'),
    node('g2', 'generate'),
    node('out', 'output'),
  ];

  it.each([
    ['p', 'prompt'],
    ['o', 'original'],
    ['cin', 'original'],
    ['img', 'reference'],
    ['t', 'theme'],
    ['pal1', 'palette'],
  ])('accepts %s → generate.%s', (source, handle) => {
    expect(checkConnection(conn(source, 'g', handle), nodes, []).ok).toBe(true);
  });

  it('accepts generate → output image and output collection', () => {
    expect(checkConnection(conn('g', 'out', 'in'), nodes, []).ok).toBe(true);
    expect(checkConnection(conn('g', 'cout', 'in'), nodes, []).ok).toBe(true);
  });

  it.each([
    ['p', 'original'],
    ['t', 'reference'],
    ['img', 'theme'],
    ['o', 'palette'],
  ])('rejects mismatched type %s → generate.%s', (source, handle) => {
    const res = checkConnection(conn(source, 'g', handle), nodes, []);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/cannot connect/);
  });

  it('rejects an output collection as a Generate input', () => {
    expect(checkConnection(conn('cout', 'g', 'original'), nodes, []).ok).toBe(false);
  });

  it('rejects generated results into an input collection', () => {
    expect(checkConnection(conn('g', 'cin', 'in'), nodes, []).ok).toBe(false);
  });

  it('allows only one palette per generate node', () => {
    const edges = [edge('pal1', 'g', 'palette')];
    const res = checkConnection(conn('pal2', 'g', 'palette'), nodes, edges);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/only one/);
  });

  it('allows multiple prompts and originals', () => {
    const edges = [edge('o', 'g', 'original')];
    expect(checkConnection(conn('cin', 'g', 'original'), nodes, edges).ok).toBe(true);
  });

  it('rejects duplicate edges', () => {
    const edges = [edge('p', 'g', 'prompt')];
    expect(checkConnection(conn('p', 'g', 'prompt'), nodes, edges).ok).toBe(false);
  });

  it('rejects generate output feeding back into the same generate', () => {
    // g → out, and out (image) → g.reference would close a loop.
    const edges = [edge('g', 'out', 'in')];
    const res = checkConnection(conn('out', 'g', 'reference'), nodes, edges);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/loop/);
  });

  it('allows chaining an output into a different generate', () => {
    const edges = [edge('g', 'out', 'in')];
    expect(checkConnection(conn('out', 'g2', 'reference'), nodes, edges).ok).toBe(true);
  });
});

describe('createsCycle', () => {
  it('detects indirect cycles', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    expect(createsCycle(edges, 'c', 'a')).toBe(true);
    expect(createsCycle(edges, 'a', 'c')).toBe(false);
  });
});
