import { describe, expect, it } from 'vitest';
import { attachResults, estimateTasks, originalEdgeRoles, resultActionFor } from './generation';
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

it('multiplies the expected images by the enabled prompts that have text', () => {
  const nodes = [
    node('g', 'generate', { mode: 'manual', outputCount: 3 }),
    node('p1', 'prompt', { text: 'a' }),
    node('p2', 'prompt', { text: 'b' }),
    node('p3', 'prompt', { text: '  ' }),
    node('p4', 'prompt', { text: 'd', enabled: false }),
  ];
  const edges = ['p1', 'p2', 'p3', 'p4'].map((id) => wire(id, 'prompt'));
  expect(estimateTasks(nodes, edges, 'g')).toBe(6);
  expect(estimateTasks(nodes, [], 'g')).toBe(3);
});

it('identifies the active action by source and batch after the prompt panel closes or results are renamed', () => {
  const nodes = [
    node('retry', 'output', { sourceNodeId: 'source', generationId: 'old-batch', resultAction: 'retry' }),
    node('variation', 'output', { sourceNodeId: 'source', generationId: 'new-batch', resultAction: 'variation', title: 'Renamed' }),
    node('other', 'output', { sourceNodeId: 'other-source', generationId: 'new-batch', resultAction: 'retry' }),
  ];
  expect(resultActionFor(nodes, 'source', 'new-batch')).toBe('variation');
  expect(resultActionFor(nodes, 'source', 'old-batch')).toBe('retry');
  expect(resultActionFor(nodes, 'other-source', 'new-batch')).toBe('retry');
  expect(resultActionFor(nodes, 'missing', 'new-batch')).toBeNull();
});

it('regenerated outputs ignore older attempts and other slots after reload', () => {
  const nodes = [node('old', 'output', { assetId: 'old-image', generationId: 'b', taskId: 't1' }),
    node('new', 'output', { generationId: 'b', pendingSlot: 1, pendingAttempt: 2 })];
  const tasks = [
    { id: 't1', batch_id: 'b', slot_index: 1, attempt_number: 1, status: 'completed', output_asset_id: 'old-image' },
    { id: 't2', batch_id: 'b', slot_index: 0, attempt_number: 2, status: 'completed', output_asset_id: 'other-slot' },
    { id: 't3', batch_id: 'b', slot_index: 1, attempt_number: 2, status: 'completed', output_asset_id: 'new-image' },
  ];
  const result = attachResults(nodes, tasks);
  expect(result[0].data.assetId).toBe('old-image');
  expect(result[1].data.assetId).toBe('new-image');
  expect(result[1].data.taskId).toBe('t3');
  expect(attachResults(result, tasks)).toBe(result);
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
