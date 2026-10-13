import type { Connection, Edge } from '@xyflow/react';
import { getDefinition, inputPort, isNodeKind, outputType } from './registry';
import type { CanvasEdge, CanvasNode, CollectionData } from './types';

export interface ConnectionCheck {
  ok: boolean;
  reason?: string;
  /**
   * A port that takes one connection already has these edges. Connecting replaces them: the
   * caller removes them together with adding the new edge.
   */
  replaces?: string[];
}

/** Would adding source→target create a dependency cycle? (spec §25.3) */
export function createsCycle(edges: Pick<CanvasEdge, 'source' | 'target'>[], source: string, target: string): boolean {
  if (source === target) return true;
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    const list = outgoing.get(e.source);
    if (list) list.push(e.target);
    else outgoing.set(e.source, [e.target]);
  }
  // A cycle appears iff `source` is already reachable from `target`.
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(outgoing.get(id) ?? []));
  }
  return false;
}

/** Typed-port, cardinality and cycle checks for a prospective edge (spec §25). */
export function checkConnection(
  conn: Connection | Edge,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): ConnectionCheck {
  const source = nodes.find((n) => n.id === conn.source);
  const target = nodes.find((n) => n.id === conn.target);
  if (!source || !target || !isNodeKind(source.type) || !isNodeKind(target.type)) {
    return { ok: false, reason: 'Unknown node.' };
  }
  if (source.id === target.id) return { ok: false, reason: 'A node cannot connect to itself.' };

  const type = outputType(source.type, conn.sourceHandle);
  const port = inputPort(target.type, conn.targetHandle);
  if (!type || !port) return { ok: false, reason: 'Invalid port.' };

  const targetLabel = `${getDefinition(target.type).label} › ${port.label}`;
  if (!port.accepts.includes(type)) {
    return { ok: false, reason: `${getDefinition(source.type).label} cannot connect to ${targetLabel}.` };
  }

  // Only input collections feed Original; only output collections receive generated results.
  if (source.type === 'collection' && (source.data as CollectionData).role !== 'input') {
    return { ok: false, reason: 'Only an Input Collection can feed a Generate node.' };
  }
  if (target.type === 'collection') {
    const role = conn.targetHandle === 'extract' ? 'input' : 'output';
    if ((target.data as CollectionData).role !== role) return { ok: false, reason: `This connection needs an ${role} collection.` };
  }

  const existing = edges.filter(
    (e) => !('id' in conn && e.id === conn.id) && e.target === target.id && e.targetHandle === conn.targetHandle,
  );
  if (existing.some((e) => e.source === source.id && e.sourceHandle === conn.sourceHandle)) {
    return { ok: false, reason: 'These nodes are already connected.' };
  }
  const replaces = !port.multiple ? existing.map((e) => e.id) : [];
  if (createsCycle(edges, source.id, target.id)) {
    return { ok: false, reason: 'This connection would create a loop.' };
  }
  return replaces.length ? { ok: true, replaces } : { ok: true };
}
