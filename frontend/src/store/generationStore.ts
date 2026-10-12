import { create } from 'zustand';
import { estimateTasks, referencedBatchIds } from '../graph/generation';
import {
  api,
  ApiError,
  generationEventsUrl,
  toGraphPayload,
  type BatchStatus,
  type GenerationBatch,
  type GenerationTask,
} from '../lib/api';
import { useAssetStore } from './assetStore';
import { useGraphStore } from './graphStore';

/** Batch states that still have (or wait for) work. */
export const OPEN_STATUSES: readonly BatchStatus[] = ['queued', 'running', 'paused', 'interrupted'];
const RUNNING_STATUSES: readonly BatchStatus[] = ['queued', 'running'];

interface GenerationState {
  projectId: string | null;
  batches: Record<string, GenerationBatch>;
  /** Every attempt of every task, per batch, loaded on demand and kept fresh by events. */
  tasks: Record<string, GenerationTask[]>;
  /** Generate nodes whose start request is in flight (prevents double submits). */
  starting: Record<string, true>;
  /** Generate node whose Preview Request dialog is open. */
  previewNodeId: string | null;
  openPreview: (generateId: string | null) => void;
  load: (projectId: string) => Promise<void>;
  loadTasks: (batchId: string) => Promise<GenerationTask[]>;
  start: (generateId: string) => Promise<void>;
  cancel: (batchId: string) => Promise<void>;
  retry: (batchId: string, taskIds?: string[]) => Promise<void>;
  resume: (batchId: string) => Promise<void>;
}

let events: EventSource | null = null;


const toast = (message: string, tone: 'info' | 'error' = 'info') => useGraphStore.getState().showToast(message, tone);
const fail = (err: unknown) => toast((err as Error).message, 'error');

/** The latest attempt of each slot, in slot order. */
export function latestAttempts(tasks: GenerationTask[] | undefined): GenerationTask[] {
  const bySlot = new Map<number, GenerationTask>();
  for (const t of tasks ?? []) {
    const cur = bySlot.get(t.slot_index);
    if (!cur || t.attempt_number > cur.attempt_number) bySlot.set(t.slot_index, t);
  }
  return [...bySlot.values()].sort((a, b) => a.slot_index - b.slot_index);
}

/** Most recent batch of a Generate node, if any. */
export function latestBatchFor(batches: Record<string, GenerationBatch>, generateId: string): GenerationBatch | null {
  let best: GenerationBatch | null = null;
  for (const b of Object.values(batches)) {
    if (b.generate_node_id === generateId && (!best || b.created_at > best.created_at)) best = b;
  }
  return best;
}

export const isRunning = (b: GenerationBatch | null | undefined) => !!b && RUNNING_STATUSES.includes(b.status);

function describeFinish(b: GenerationBatch): string {
  const name = b.name || 'Generate';
  if (b.status === 'completed') return `${name}: ${b.completed_count} of ${b.expected_count} images done.`;
  if (b.status === 'cancelled') return `${name} cancelled. ${b.completed_count} finished image(s) kept.`;
  if (b.status === 'paused' || b.status === 'interrupted') return b.status_reason ?? `${name} paused.`;
  return `${name}: ${b.completed_count} of ${b.expected_count} done, ${b.failed_count} failed.`;
}

export const useGenerationStore = create<GenerationState>()((set, get) => {
  const upsertBatch = (batch: GenerationBatch) => {
    const prev = get().batches[batch.id];
    set((s) => ({ batches: { ...s.batches, [batch.id]: batch } }));
    // Announce transitions out of active work (finished, paused) once.
    if (prev && RUNNING_STATUSES.includes(prev.status) && !RUNNING_STATUSES.includes(batch.status)) {
      toast(describeFinish(batch), batch.status === 'completed' ? 'info' : 'error');
    }
  };

  const upsertTask = (task: GenerationTask) => {
    set((s) => {
      const list = s.tasks[task.batch_id] ?? [];
      const i = list.findIndex((t) => t.id === task.id);
      const next = i >= 0 ? list.map((t) => (t.id === task.id ? task : t)) : [...list, task];
      return { tasks: { ...s.tasks, [task.batch_id]: next } };
    });
    if (task.status === 'completed' && task.output_asset_id) {
      // The new image becomes known to the library before a node shows it.
      void useAssetStore.getState().refresh(task.output_asset_id);
      useGraphStore.getState().applyResults([task]);
    }
  };

  const connect = (projectId: string) => {
    events?.close();
    let dropped = false;
    events = new EventSource(generationEventsUrl(projectId));
    events.addEventListener('batch', (e) => {
      const { batch } = JSON.parse((e as MessageEvent).data) as { batch: GenerationBatch };
      if (get().projectId === projectId) upsertBatch(batch);
    });
    events.addEventListener('task', (e) => {
      const { task } = JSON.parse((e as MessageEvent).data) as { task: GenerationTask };
      if (get().projectId === projectId) upsertTask(task);
    });
    events.onerror = () => {
      dropped = true; // EventSource reconnects by itself
    };
    events.onopen = () => {
      // Events sent while disconnected are lost: re-read state from the database.
      if (dropped && get().projectId === projectId) void get().load(projectId);
      dropped = false;
    };
  };

  return {
    projectId: null,
    batches: {},
    tasks: {},
    starting: {},
    previewNodeId: null,
    openPreview: (previewNodeId) => set({ previewNodeId }),

    load: async (projectId) => {
      const switching = get().projectId !== projectId;
      if (switching) {
        set({ projectId, batches: {}, tasks: {}, previewNodeId: null });
        connect(projectId);
      }
      try {
        const list = await api.listGenerations(projectId);
        if (get().projectId !== projectId) return;
        set({ batches: Object.fromEntries(list.map((b) => [b.id, b])) });
        // Results that finished while the app was closed (spec §29.7).
        const wanted = referencedBatchIds(useGraphStore.getState().nodes);
        for (const b of list) {
          if (!wanted.has(b.id) && !OPEN_STATUSES.includes(b.status)) continue;
          const tasks = await get().loadTasks(b.id);
          if (get().projectId !== projectId) return;
          useGraphStore.getState().applyResults(tasks);
        }
      } catch (err) {
        fail(err);
      }
    },

    loadTasks: async (batchId) => {
      const tasks = await api.generationTasks(batchId);
      set((s) => ({ tasks: { ...s.tasks, [batchId]: tasks } }));
      return tasks;
    },

    start: async (generateId) => {
      const g = useGraphStore.getState();
      const projectId = g.projectId;
      if (!projectId || get().starting[generateId]) return;
      set((s) => ({ starting: { ...s.starting, [generateId]: true } }));
      // The node that receives the results is placed and saved before the batch exists, so a
      // reload or crash right after pressing Generate cannot orphan the results.
      const batchId = crypto.randomUUID();
      g.placeResultNode(generateId, batchId, estimateTasks(g.nodes, g.edges, generateId));
      try {
        const placed = useGraphStore.getState();
        // The graph exactly as shown becomes the batch's immutable snapshot (spec §13.1).
        const graph = toGraphPayload(placed.nodes, placed.edges, placed.viewport);
        await api.updateProject(projectId, { graph });
        const { batch, tasks } = await api.startGeneration({
          project_id: projectId,
          generate_node_id: generateId,
          graph,
          batch_id: batchId,
        });
        // Events for this batch may already have arrived; they are newer than the response.
        set((s) => {
          const seen = new Map((s.tasks[batch.id] ?? []).map((t) => [t.id, t]));
          return {
            batches: { ...s.batches, [batch.id]: s.batches[batch.id] ?? batch },
            tasks: {
              ...s.tasks,
              [batch.id]: [
                ...tasks.map((t) => seen.get(t.id) ?? t),
                ...[...seen.values()].filter((t) => !tasks.some((r) => r.id === t.id)),
              ],
            },
          };
        });
        useGraphStore.getState().applyResults(get().tasks[batch.id] ?? []);
      } catch (err) {
        if (useGraphStore.getState().projectId === projectId) useGraphStore.getState().discardResultNode(batchId);
        if (err instanceof ApiError && err.errors.length > 1) {
          toast(`${err.errors[0]} (+${err.errors.length - 1} more — open Preview request for the full list)`, 'error');
        } else fail(err);
      } finally {
        set((s) => {
          const next = { ...s.starting };
          delete next[generateId];
          return { starting: next };
        });
      }
    },

    cancel: async (batchId) => {
      try {
        const { batch, note } = await api.cancelGeneration(batchId);
        upsertBatch(batch);
        if (note) toast(note);
      } catch (err) {
        fail(err);
      }
    },

    retry: async (batchId, taskIds) => {
      try {
        const { batch, retried } = await api.retryGeneration(batchId, taskIds);
        upsertBatch(batch);
        toast(`Retrying ${retried} task${retried === 1 ? '' : 's'}.`);
        await get().loadTasks(batchId);
      } catch (err) {
        fail(err);
      }
    },

    resume: async (batchId) => {
      try {
        upsertBatch((await api.resumeGeneration(batchId)).batch);
        await get().loadTasks(batchId);
      } catch (err) {
        fail(err);
      }
    },
  };
});

// A Generate node is frozen exactly while a batch on it is queued or running.
useGenerationStore.subscribe((state, prev) => {
  if (state.batches === prev.batches) return;
  useGraphStore
    .getState()
    .setFrozen([...new Set(Object.values(state.batches).filter(isRunning).map((b) => b.generate_node_id))]);
});
