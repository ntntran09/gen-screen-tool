import { expect, it } from 'vitest';
import { applyGraphOps, graphDiff, GraphSyncModel, type GraphOp } from './graphSync';
import type { GraphPayload } from './api';

const graph = (): GraphPayload => ({ nodes: [
  { id: 'a', type: 'prompt', position: { x: 0, y: 0 }, data: { text: 'old', enabled: true } },
  { id: 'b', type: 'generate', position: { x: 300, y: 0 }, data: {} },
], edges: [{ id: 'ab', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'prompt' }], viewport: { x: 0, y: 0, zoom: 1 } });
const patch = (data: Record<string, unknown>): GraphOp => ({ kind: 'node_patch', id: 'a', patch: { data } });
const model = () => {
  const m = new GraphSyncModel(graph(), 'self');
  m.receive({ type: 'snapshot', graph: graph(), revision: 0, ack_seq: 0, name: 'Test' });
  return m;
};

it('sends only changed fields and excludes viewport', () => {
  const before = graph();
  const after = applyGraphOps(before, [patch({ text: 'new' })]);
  after.viewport = { x: 100, y: 200, zoom: 2 };
  expect(graphDiff(before, after)).toEqual([patch({ text: 'new' })]);
});

it('merges unrelated remote fields without flickering pending local values', () => {
  const m = model();
  m.draft = applyGraphOps(m.draft, [patch({ text: 'mine' })]);
  expect(m.prepare()?.seq).toBe(1);
  m.receive({ type: 'edit', client_id: 'other', seq: 1, revision: 1, ops: [patch({ text: 'theirs', enabled: false })] });
  expect(m.draft.nodes[0].data).toEqual({ text: 'mine', enabled: false });
  m.receive({ type: 'edit', client_id: 'self', seq: 1, revision: 2, ops: [patch({ text: 'mine' })] });
  expect(m.dirty).toBe(false);
  expect(m.base.nodes[0].data).toEqual({ text: 'mine', enabled: false });
});

it('coalesces typing/movement while awaiting acknowledgement into the latest values', () => {
  const m = model();
  m.draft = applyGraphOps(m.draft, [patch({ text: 'first' })]);
  m.prepare();
  for (let i = 0; i < 100; i++) m.draft = applyGraphOps(m.draft, [patch({ text: `value${i}` })]);
  expect(m.prepare()).toBeNull();
  m.receive({ type: 'edit', client_id: 'self', seq: 1, revision: 1, ops: [patch({ text: 'first' })] });
  expect(m.prepare()).toEqual({ seq: 2, ops: [patch({ text: 'value99' })] });
});

it('reconnects after a lost acknowledgement without replaying committed edits over newer remote values', () => {
  const m = model();
  m.draft = applyGraphOps(m.draft, [patch({ text: 'mine' })]);
  m.prepare();
  m.receive({ type: 'snapshot', name: 'Test', revision: 2, ack_seq: 1,
    graph: applyGraphOps(graph(), [patch({ text: 'newer remote' })]) });
  expect(m.pending).toBeNull();
  expect(m.draft.nodes[0].data.text).toBe('newer remote');
  expect(m.dirty).toBe(false);
});

it('replays uncommitted pending and unsent edits onto the fresh reconnect snapshot', () => {
  const m = model();
  m.draft = applyGraphOps(m.draft, [patch({ text: 'first' })]); m.prepare();
  m.draft = applyGraphOps(m.draft, [patch({ text: 'latest' })]);
  m.receive({ type: 'snapshot', name: 'Test', revision: 1, ack_seq: 0,
    graph: applyGraphOps(graph(), [patch({ enabled: false })]) });
  expect(m.pending?.seq).toBe(1);
  expect(m.draft.nodes[0].data).toEqual({ text: 'latest', enabled: false });
});

it('does not resurrect a remotely deleted node or its edges', () => {
  const m = model();
  m.draft = applyGraphOps(m.draft, [patch({ text: 'mine' })]); m.prepare();
  m.receive({ type: 'edit', revision: 1, client_id: 'other', seq: 1, ops: [{ kind: 'node_remove', id: 'a' }] });
  expect(m.draft.nodes.map((n) => n.id)).toEqual(['b']);
  expect(m.draft.edges).toEqual([]);
});

it('rolls back a rejected frozen-node edit, preserving later unrelated edits', () => {
  const m = model();
  m.draft = applyGraphOps(m.draft, [{ kind: 'node_remove', id: 'b' }]); m.prepare();
  m.draft = applyGraphOps(m.draft, [patch({ text: 'unsent' })]);
  m.receive({ type: 'rejected', name: 'Test', graph: graph(), revision: 0, ack_seq: 0 });
  expect(m.draft.nodes.map((n) => n.id)).toEqual(['a', 'b']);
  expect(m.draft.nodes[0].data.text).toBe('unsent');
  expect(m.prepare()?.seq).toBe(1);
});

it('requires a snapshot when an event is missing', () => {
  const m = model();
  expect(() => m.receive({ type: 'edit', revision: 2, client_id: 'other', seq: 1, ops: [] })).toThrow('SYNC_GAP');
});
