import type { GraphPayload } from './api';

type GraphNode = GraphPayload['nodes'][number];
type GraphEdge = GraphPayload['edges'][number];
export type GraphOp =
  | { kind: 'node_add'; id: string; node: GraphNode }
  | { kind: 'node_remove'; id: string }
  | { kind: 'node_patch'; id: string; patch: { position?: GraphNode['position']; width?: number | null; height?: number | null; data?: Record<string, unknown>; unset?: string[] } }
  | { kind: 'edge_add'; id: string; edge: GraphEdge }
  | { kind: 'edge_remove'; id: string };

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only changed properties travel over the wire; viewport and selection stay local. */
export function graphDiff(before: GraphPayload, after: GraphPayload): GraphOp[] {
  const ops: GraphOp[] = [];
  const oldNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const newNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const oldEdges = new Map(before.edges.map((e) => [e.id, e]));
  const newEdges = new Map(after.edges.map((e) => [e.id, e]));
  for (const e of before.edges) if (!newEdges.has(e.id) || !equal(e, newEdges.get(e.id))) ops.push({ kind: 'edge_remove', id: e.id });
  for (const n of before.nodes) if (!newNodes.has(n.id)) ops.push({ kind: 'node_remove', id: n.id });
  for (const n of after.nodes) {
    const old = oldNodes.get(n.id);
    if (!old) { ops.push({ kind: 'node_add', id: n.id, node: n }); continue; }
    const patch: Extract<GraphOp, { kind: 'node_patch' }>['patch'] = {};
    if (!equal(old.position, n.position)) patch.position = n.position;
    if ((old.width ?? null) !== (n.width ?? null)) patch.width = n.width ?? null;
    if ((old.height ?? null) !== (n.height ?? null)) patch.height = n.height ?? null;
    const data = Object.fromEntries(Object.entries(n.data).filter(([key, value]) => !equal(old.data[key], value)));
    const unset = Object.keys(old.data).filter((key) => !(key in n.data));
    if (Object.keys(data).length) patch.data = data;
    if (unset.length) patch.unset = unset;
    if (Object.keys(patch).length) ops.push({ kind: 'node_patch', id: n.id, patch });
  }
  for (const e of after.edges) if (!oldEdges.has(e.id) || !equal(e, oldEdges.get(e.id))) ops.push({ kind: 'edge_add', id: e.id, edge: e });
  return ops;
}

export function applyGraphOps(graph: GraphPayload, ops: GraphOp[]): GraphPayload {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  for (const op of ops) {
    if (op.kind === 'node_add') {
      if (!nodes.has(op.id)) nodes.set(op.id, op.node);
    } else if (op.kind === 'node_remove') {
      nodes.delete(op.id);
      for (const [id, e] of edges) if (e.source === op.id || e.target === op.id) edges.delete(id);
    } else if (op.kind === 'node_patch') {
      const n = nodes.get(op.id);
      if (!n) continue;
      const { data: changed, unset, ...properties } = op.patch;
      const data = { ...n.data, ...changed };
      for (const key of unset ?? []) delete data[key];
      nodes.set(op.id, { ...n, ...properties, data });
    } else if (op.kind === 'edge_remove') edges.delete(op.id);
    else if (nodes.has(op.edge.source) && nodes.has(op.edge.target) && !edges.has(op.id)) edges.set(op.id, op.edge);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], viewport: graph.viewport };
}

export interface PendingEdit { seq: number; ops: GraphOp[] }
export type SyncEvent =
  | { type: 'snapshot' | 'rejected'; graph: GraphPayload; revision: number; ack_seq?: number; name: string; message?: string }
  | { type: 'edit'; ops: GraphOp[]; revision: number; client_id: string; seq: number };

/** Optimistic state, one acknowledged batch at a time. Pending local values never flicker. */
export class GraphSyncModel {
  base: GraphPayload;
  draft: GraphPayload;
  revision = -1;
  ackSeq = 0;
  pending: PendingEdit | null = null;
  readonly clientId: string;
  constructor(graph: GraphPayload, clientId: string) { this.base = graph; this.draft = graph; this.clientId = clientId; }

  receive(event: SyncEvent) {
    if (event.type === 'edit' && event.revision <= this.revision) return;
    if (event.type === 'edit' && event.revision !== this.revision + 1) throw new Error('SYNC_GAP');
    const projected = applyGraphOps(this.base, this.pending?.ops ?? []);
    const unsent = graphDiff(projected, this.draft);
    if (event.type === 'edit') {
      this.base = applyGraphOps(this.base, event.ops);
      if (event.client_id === this.clientId) {
        this.ackSeq = Math.max(this.ackSeq, event.seq);
        if (this.pending?.seq === event.seq) this.pending = null;
      }
    } else {
      this.base = event.graph;
      if (event.ack_seq !== undefined) this.ackSeq = event.ack_seq;
      if (event.type === 'rejected' || (this.pending && this.pending.seq <= this.ackSeq)) this.pending = null;
    }
    this.revision = event.revision;
    this.draft = applyGraphOps(applyGraphOps(this.base, this.pending?.ops ?? []), unsent);
  }

  prepare(): PendingEdit | null {
    if (this.pending) return null;
    const ops = graphDiff(this.base, this.draft).slice(0, 1000);
    if (!ops.length) return null;
    this.pending = { seq: this.ackSeq + 1, ops };
    return this.pending;
  }
  get dirty() { return !!this.pending || graphDiff(this.base, this.draft).length > 0; }
}
