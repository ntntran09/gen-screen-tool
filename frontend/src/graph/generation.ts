import { collectionItems } from './collections';
import type { CanvasEdge, CanvasNode, CollectionData, CollectionItem, GenerateData, OutputData } from './types';

/** The subset of a backend task needed to place its result on the canvas. */
export interface TaskResult {
  id: string;
  batch_id: string;
  slot_index: number;
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
  if (data.mode === 'manual') return data.outputCount;
  let originals = 0;
  for (const e of edges) {
    if (e.target !== generateId || e.targetHandle !== 'original') continue;
    const src = nodes.find((n) => n.id === e.source);
    if (src?.type === 'image' || src?.type === 'output') originals += 1;
    else if (src?.type === 'collection') originals += collectionItems(src).filter((i) => i.enabled).length;
  }
  return originals * data.variantsPerInput;
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
      const task = done.find((t) => t.batch_id === data.generationId);
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
    if (n.type === 'output' && (n.data as OutputData).generationId) ids.add((n.data as OutputData).generationId!);
    if (n.type === 'collection') for (const id of (n.data as CollectionData).batchIds ?? []) ids.add(id);
  }
  return ids;
}
