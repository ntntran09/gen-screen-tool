import { collectionItems } from './collections';
import type { CanvasEdge, CanvasNode, CollectionData, CollectionItem, GenerateData, OutputData, PromptData } from './types';

/** Match the receiver's saved action, rather than treating every inline run as Retry. */
export function resultActionFor(nodes: CanvasNode[], sourceId: string, batchId: string): OutputData['resultAction'] | null {
  const result = nodes.find((n) => n.type === 'output' && n.data.sourceNodeId === sourceId && n.data.generationId === batchId);
  if (!result) return null;
  const data = result.data as OutputData;
  return data.resultAction ?? (data.pendingSlot !== undefined ? 'retry' : data.title === 'Varied result' ? 'variation' : null);
}

/** The subset of a backend task needed to place its result on the canvas. */
export interface TaskResult {
  id: string;
  batch_id: string;
  slot_index: number;
  attempt_number?: number;
  status: string;
  output_asset_id: string | null;
}

/**
 * Expected task count for the Generate button label. The backend recomputes this (and
 * validates everything) when the batch is created; this is only a quick hint.
 */
export function estimateTasks(nodes: CanvasNode[], edges: CanvasEdge[], generateId: string): number {
  const gen = nodes.find((n) => n.id === generateId);
  if (gen?.type !== 'generate') return 0;
  const data = gen.data as GenerateData;
  // Each enabled Prompt node with text gets its own full set of results.
  let prompts = 0;
  for (const e of edges) {
    if (e.target !== generateId || e.targetHandle !== 'prompt') continue;
    const src = nodes.find((n) => n.id === e.source);
    if (src?.type === 'prompt' && (src.data as PromptData).enabled !== false && (src.data as PromptData).text.trim()) prompts += 1;
  }
  prompts = Math.max(1, prompts);
  if (data.mode === 'manual') return data.outputCount * prompts;
  let originals = 0;
  for (const e of edges) {
    if (e.target !== generateId || e.targetHandle !== 'original') continue;
    const src = nodes.find((n) => n.id === e.source);
    if (src?.type === 'image' || src?.type === 'output') originals += 1;
    else if (src?.type === 'collection') originals += collectionItems(src).filter((i) => i.enabled).length;
  }
  return originals * data.variantsPerInput * prompts;
}

export type OriginalRole =
  /** Used for every result (Match inputs, or the only original). */
  | 'used'
  /** The chosen Primary original (Manual count with several originals). */
  | 'primary'
  /** Also sent, as an additional original: another original is the primary. */
  | 'secondary'
  /** Several originals and none chosen yet: the user must pick one. */
  | 'candidate';

/**
 * What each wire into a Generate node's Original port does. In Manual count with several originals
 * every one is sent; the Primary original is the main one (image 1) and the rest go with it.
 * Collections cannot be primary.
 */
export function originalEdgeRoles(nodes: CanvasNode[], edges: CanvasEdge[], generateId: string): Map<string, OriginalRole> {
  const roles = new Map<string, OriginalRole>();
  const gen = nodes.find((n) => n.id === generateId);
  if (gen?.type !== 'generate') return roles;
  const incoming = edges.filter((e) => e.target === generateId && e.targetHandle === 'original');
  const manualMany = (gen.data as GenerateData).mode === 'manual' && incoming.length > 1;
  const primary = (gen.data as GenerateData).primaryOriginalNodeId;
  const primaryEdge = manualMany
    ? incoming.find((e) => e.source === primary && nodes.find((n) => n.id === e.source)?.type !== 'collection')
    : undefined;
  for (const e of incoming) {
    if (!manualMany) roles.set(e.id, 'used');
    else if (!primaryEdge) roles.set(e.id, 'candidate');
    else roles.set(e.id, e.id === primaryEdge.id ? 'primary' : 'secondary');
  }
  return roles;
}

/** An Output Collection already fed by this Generate node, reused for new batches. */
export function connectedOutputCollection(nodes: CanvasNode[], edges: CanvasEdge[], generateId: string): CanvasNode | null {
  for (const e of edges) {
    if (e.source !== generateId) continue;
    const target = nodes.find((n) => n.id === e.target);
    if (target?.type === 'collection' && (target.data as CollectionData).role === 'output') return target;
  }
  return null;
}

/**
 * Put completed results into the nodes that wait for their batch. Idempotent: a task is
 * placed once (tracked in `syncedTaskIds` / `taskId`), so a result the user removed is not
 * added back. Returns the same array when nothing changed.
 */
export function attachResults(nodes: CanvasNode[], tasks: TaskResult[]): CanvasNode[] {
  const done = tasks
    .filter((t) => t.status === 'completed' && t.output_asset_id)
    .sort((a, b) => a.slot_index - b.slot_index);
  if (done.length === 0) return nodes;
  let changed = false;
  const next = nodes.map((node) => {
    if (node.type === 'output') {
      const data = node.data as OutputData;
      if (data.assetId || !data.generationId) return node;
      const task = done.find((t) => t.batch_id === data.generationId &&
        (data.pendingSlot === undefined || t.slot_index === data.pendingSlot) &&
        (data.pendingAttempt === undefined || t.attempt_number === data.pendingAttempt));
      if (!task) return node;
      changed = true;
      return { ...node, data: { ...data, assetId: task.output_asset_id, taskId: task.id } };
    }
    if (node.type === 'collection') {
      const data = node.data as CollectionData;
      const batchIds = data.batchIds ?? [];
      if (data.role !== 'output' || batchIds.length === 0) return node;
      const synced = new Set(data.syncedTaskIds ?? []);
      const fresh = done.filter((t) => batchIds.includes(t.batch_id) && !synced.has(t.id));
      if (fresh.length === 0) return node;
      changed = true;
      const added: CollectionItem[] = fresh.map((t) => ({
        id: t.id,
        assetId: t.output_asset_id!,
        enabled: true,
        promptOverride: '',
      }));
      return {
        ...node,
        data: {
          ...data,
          items: [...collectionItems(node), ...added],
          syncedTaskIds: [...(data.syncedTaskIds ?? []), ...fresh.map((t) => t.id)],
        },
      };
    }
    return node;
  });
  return changed ? next : nodes;
}

/** Batch ids that result nodes in the graph are waiting on or were filled from. */
export function referencedBatchIds(nodes: CanvasNode[]): Set<string> {
  const ids = new Set<string>();
  for (const n of nodes) {
    for (const id of n.data.inlineGeneration?.batchIds ?? []) ids.add(id);
    if (n.type === 'output' && (n.data as OutputData).generationId) ids.add((n.data as OutputData).generationId!);
    if (n.type === 'collection') for (const id of (n.data as CollectionData).batchIds ?? []) ids.add(id);
  }
  return ids;
}
