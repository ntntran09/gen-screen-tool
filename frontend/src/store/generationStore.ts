import { create } from 'zustand';
import { uuid } from '../lib/uuid';
import { estimateTasks, referencedBatchIds } from '../graph/generation';
import {
  api,
  ApiError,
  generationEventsUrl,
  toGraphPayload,
  toInlineGenerationPayload,
  type BatchStatus,
  type GenerationBatch,
  type GenerationTask,
} from '../lib/api';
import { useAssetStore } from './assetStore';
import { useGraphStore } from './graphStore';
import type { GenerateData } from '../graph/types';

const VARIATION_PROMPT = 'Create a subtle variation of this image. Preserve its art style, main subject and composition.';

function variationSettings(batch?: GenerationBatch, task?: GenerationTask): Partial<GenerateData> {
  const saved = task?.request.settings;
  return { providerId: batch?.provider_id ?? 'codex', title: 'Variation',
    ...(typeof saved?.model === 'string' ? { model: saved.model } : {}),
    ...(['auto', 'low', 'medium', 'high'].includes(String(saved?.quality)) ? { quality: saved!.quality as GenerateData['quality'] } : {}),
    ...(['png', 'webp', 'jpg'].includes(String(saved?.output_format)) ? { outputFormat: saved!.output_format as GenerateData['outputFormat'] } : {}),
  };
}

/** The original image(s) a result was made from, sent with a variation so the model keeps the context. */
export function variationContext(task: GenerationTask | undefined, assetId: string): string[] {
  const request = task?.request;
  const ids = [request?.original_asset_id, ...(request?.extra_original_asset_ids ?? [])];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== '' && id !== assetId))];
}

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
  editTarget: { nodeId: string; assetId: string; prompt: string; mode?: 'variation'; shortPrompt?: string; prefix?: string; suffix?: string; expanded?: boolean; originalPrompt?: string; loading?: boolean; error?: string; batchId?: string; taskId?: string } | null;
  openEdit: (nodeId: string, assetId: string) => Promise<void>;
  openVariation: (nodeId: string, assetId: string, batchId?: string | null, taskId?: string | null) => Promise<void>;
  closeEdit: () => void;
  setEditPrompt: (prompt: string) => void;
  toggleFullPrompt: () => void;
  openPreview: (generateId: string | null) => void;
  load: (projectId: string) => Promise<void>;
  loadTasks: (batchId: string) => Promise<GenerationTask[]>;
  start: (generateId: string) => Promise<boolean>;
  regenerate: (nodeId: string, assetId: string, prompt: string, batchId?: string | null, taskId?: string | null) => Promise<boolean>;
  vary: (nodeId: string, assetId: string, prompt: string, batchId?: string | null, taskId?: string | null) => Promise<boolean>;
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

export interface FailureReason {
  message: string;
  count: number;
}

/** Why the latest attempts failed, grouped by message, most common first. */
export function failureReasons(tasks: GenerationTask[] | undefined): FailureReason[] {
  const byMessage = new Map<string, FailureReason>();
  for (const t of latestAttempts(tasks)) {
    if (t.status !== 'failed' && t.status !== 'interrupted') continue;
    const message = (t.error_message ?? t.error_code ?? 'Failed').trim();
    const seen = byMessage.get(message);
    if (seen) seen.count += 1;
    else byMessage.set(message, { message, count: 1 });
  }
  return [...byMessage.values()].sort((a, b) => b.count - a.count);
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
    editTarget: null,
    openEdit: async (nodeId, assetId) => {
      if (get().editTarget?.nodeId === nodeId && get().editTarget?.assetId === assetId && !get().editTarget?.mode) {
        set({ editTarget: null });
        return;
      }
      const target = { nodeId, assetId, prompt: '', loading: true };
      set({ editTarget: target });
      try {
        const source = useGraphStore.getState().nodes.find((n) => n.id === nodeId);
        let task = Object.values(get().tasks).flat().find((t) => t.output_asset_id === assetId);
        const batchId = source?.type === 'output' ? String(source.data.generationId ?? '') : '';
        if (!task?.prompt_parts && (batchId || task?.batch_id)) {
          task = (await get().loadTasks(batchId || task!.batch_id)).find((t) => t.output_asset_id === assetId);
        }
        if (!task) throw new Error('Generation history is unavailable for this image.');
        if (get().editTarget === target) set({ editTarget: { nodeId, assetId, prompt: task.prompt, originalPrompt: task.prompt,
          shortPrompt: task.prompt_parts?.user_prompt ?? task.prompt, prefix: task.prompt_parts?.prefix ?? '',
          suffix: task.prompt_parts?.suffix ?? '', expanded: false, batchId: task.batch_id, taskId: task.id } });
      } catch (err) {
        if (get().editTarget === target) set({ editTarget: { ...target, loading: false, error: (err as Error).message } });
      }
    },
    openVariation: async (nodeId, assetId, batchId, taskId) => {
      if (get().editTarget?.nodeId === nodeId && get().editTarget?.assetId === assetId && get().editTarget?.mode === 'variation') {
        set({ editTarget: null });
        return;
      }
      const target = { nodeId, assetId, mode: 'variation' as const, prompt: VARIATION_PROMPT, shortPrompt: VARIATION_PROMPT, loading: true };
      set({ editTarget: target });
      try {
        const g = useGraphStore.getState();
        if (!g.projectId) throw new Error('No project is open.');
        const sourceTask = batchId ? get().tasks[batchId]?.find((t) => t.id === taskId) : undefined;
        const settings = variationSettings(batchId ? get().batches[batchId] : undefined, sourceTask);
        const id = uuid();
        const nodes = g.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data,
          inlineGeneration: { id, assetId, prompt: VARIATION_PROMPT, settings, batchIds: [], contextAssetIds: variationContext(sourceTask, assetId) },
        } } : n);
        const preview = await api.previewGeneration({ project_id: g.projectId, generate_node_id: id,
          graph: toInlineGenerationPayload(toGraphPayload(nodes, g.edges, g.viewport), nodeId) });
        if (!preview.ok || !preview.tasks[0]) throw new Error(preview.errors[0] ?? 'Cannot preview this variation.');
        const full = preview.tasks[0].prompt;
        const start = full.indexOf(VARIATION_PROMPT);
        if (get().editTarget === target) set({ editTarget: { ...target, loading: false, batchId: batchId ?? undefined, taskId: taskId ?? undefined,
          prompt: full, originalPrompt: full, prefix: start >= 0 ? full.slice(0, start) : '',
          suffix: start >= 0 ? full.slice(start + VARIATION_PROMPT.length) : '',
        } });
      } catch (err) {
        if (get().editTarget === target) set({ editTarget: { ...target, loading: false, error: (err as Error).message } });
      }
    },
    closeEdit: () => set({ editTarget: null }),
    setEditPrompt: (shortPrompt) => set((s) => ({ editTarget: s.editTarget ? { ...s.editTarget, shortPrompt,
      prompt: shortPrompt.trim() ? `${s.editTarget.prefix ?? ''}${shortPrompt}${s.editTarget.suffix ?? ''}` : '',
    } : null })),
    toggleFullPrompt: () => set((s) => ({ editTarget: s.editTarget ? { ...s.editTarget, expanded: !s.editTarget.expanded } : null })),
    openPreview: (previewNodeId) => set({ previewNodeId }),

    load: async (projectId) => {
      const switching = get().projectId !== projectId;
      if (switching) {
        set({ projectId, batches: {}, tasks: {}, previewNodeId: null, editTarget: null });
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
      const projectId = get().projectId;
      const tasks = await api.generationTasks(batchId);
      if (get().projectId === projectId) set((s) => ({ tasks: { ...s.tasks, [batchId]: tasks } }));
      return tasks;
    },

    start: async (generateId) => {
      const g = useGraphStore.getState();
      const projectId = g.projectId;
      if (!projectId || get().starting[generateId]) return false;
      set((s) => ({ starting: { ...s.starting, [generateId]: true } }));
      // The node that receives the results is placed and saved before the batch exists, so a
      // reload or crash right after pressing Generate cannot orphan the results.
      const batchId = uuid();
      try {
        g.placeResultNode(generateId, batchId, estimateTasks(g.nodes, g.edges, generateId));
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
        if (useGraphStore.getState().projectId !== projectId) return true;
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
        return true;
      } catch (err) {
        if (useGraphStore.getState().projectId === projectId) useGraphStore.getState().discardResultNode(batchId);
        if (err instanceof ApiError && err.errors.length > 1) {
          toast(`${err.errors[0]} (+${err.errors.length - 1} more — open Preview request for the full list)`, 'error');
        } else fail(err);
        return false;
      } finally {
        set((s) => {
          const next = { ...s.starting };
          delete next[generateId];
          return { starting: next };
        });
      }
    },

    regenerate: async (nodeId, assetId, prompt, batchId, taskId) => {
      if (get().starting[nodeId]) return false;
      const projectId = useGraphStore.getState().projectId;
      set((s) => ({ starting: { ...s.starting, [nodeId]: true } }));
      try {
        if (!(await api.health()).retry_prompt) {
          throw new Error('The backend is updating after the current jobs finish. Try again once they are done.');
        }
        if (useGraphStore.getState().projectId !== projectId) return false;
        if (!batchId || !taskId) throw new Error('Generation history is unavailable for this image.');
        const tasks = await get().loadTasks(batchId);
        if (useGraphStore.getState().projectId !== projectId) return false;
        const original = tasks.find((t) => t.id === taskId);
        const latest = original && latestAttempts(tasks).find((t) => t.slot_index === original.slot_index);
        if (!latest || ['queued', 'preparing', 'running', 'cancel_requested'].includes(latest.status)) {
          throw new Error('This result already has an active attempt or its history is unavailable.');
        }
        const id = useGraphStore.getState().placeInlineResult(nodeId, assetId, prompt, batchId, {},
          { slot_index: latest.slot_index, attempt_number: latest.attempt_number + 1 });
        if (!id) return false;
        let accepted = false;
        try {
          const placed = useGraphStore.getState();
          await api.updateProject(projectId!, { graph: toGraphPayload(placed.nodes, placed.edges, placed.viewport) });
          const beforeRetry = get().batches[batchId];
          const response = await api.retryGeneration(batchId, [latest.id], prompt.trim() || original!.prompt);
          accepted = true;
          if (useGraphStore.getState().projectId !== projectId) return true;
          if (get().batches[batchId] === beforeRetry) upsertBatch(response.batch);
          const retried = await get().loadTasks(batchId);
          if (useGraphStore.getState().projectId === projectId) useGraphStore.getState().applyResults(retried);
          return true;
        } catch (err) {
          if (!accepted && useGraphStore.getState().projectId === projectId) {
            // Other results can share this batch; remove only this retry's empty receiver.
            const state = useGraphStore.getState();
            const dropped = new Set(state.nodes.filter((n) => n.type === 'output' && !n.data.assetId &&
              n.data.generationId === batchId && n.data.pendingSlot === latest.slot_index &&
              n.data.pendingAttempt === latest.attempt_number + 1).map((n) => n.id));
            useGraphStore.setState({ nodes: state.nodes.filter((n) => !dropped.has(n.id)),
              edges: state.edges.filter((e) => !dropped.has(e.target)), revision: state.revision + 1, saveStatus: 'dirty' });
          }
          throw err;
        }
      } catch (err) {
        fail(err);
        return false;
      } finally {
        set((s) => {
          const starting = { ...s.starting };
          delete starting[nodeId];
          return { starting };
        });
      }
    },

    vary: async (nodeId, assetId, prompt, batchId, taskId) => {
      if (get().starting[nodeId]) return false;
      const projectId = useGraphStore.getState().projectId;
      if (!projectId) return false;
      set((s) => ({ starting: { ...s.starting, [nodeId]: true } }));
      const newBatchId = uuid();
      let accepted = false;
      try {
        const settings = variationSettings(batchId ? get().batches[batchId] : undefined, batchId ? get().tasks[batchId]?.find((t) => t.id === taskId) : undefined);
        const sourceTask = batchId ? get().tasks[batchId]?.find((t) => t.id === taskId) : undefined;
        const id = useGraphStore.getState().placeInlineResult(nodeId, assetId, prompt.trim() || VARIATION_PROMPT, newBatchId, settings, undefined, 'Varied result', 'variation', variationContext(sourceTask, assetId));
        if (!id) return false;
        const g = useGraphStore.getState();
        const graph = toGraphPayload(g.nodes, g.edges, g.viewport);
        await api.updateProject(projectId, { graph });
        const { batch, tasks } = await api.startGeneration({ project_id: projectId, generate_node_id: id,
          graph: toInlineGenerationPayload(graph, nodeId), batch_id: newBatchId });
        accepted = true;
        if (useGraphStore.getState().projectId !== projectId) return true;
        set((s) => ({ batches: { ...s.batches, [batch.id]: s.batches[batch.id] ?? batch },
          tasks: { ...s.tasks, [batch.id]: tasks.map((t) => s.tasks[batch.id]?.find((seen) => seen.id === t.id) ?? t) } }));
        useGraphStore.getState().applyResults(get().tasks[batch.id] ?? []);
        return true;
      } catch (err) {
        if (!accepted && useGraphStore.getState().projectId === projectId) useGraphStore.getState().discardResultNode(newBatchId);
        fail(err);
        return false;
      } finally {
        set((s) => { const starting = { ...s.starting }; delete starting[nodeId]; return { starting }; });
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

// Protect the running workflow and its result receivers, including newly loaded nodes.
function syncFrozenNodes() {
  const state = useGenerationStore.getState();
  const nodes = useGraphStore.getState().nodes;
  useGraphStore
    .getState()
    .setFrozen([...new Set(Object.values(state.batches).filter(isRunning).flatMap((b) =>
      [b.generate_node_id, ...nodes.filter((n) => n.data.inlineGeneration?.id === b.generate_node_id ||
        n.data.inlineGeneration?.batchIds.includes(b.id) ||
        (n.type === 'output' && n.data.generationId === b.id) ||
        (n.type === 'collection' && Array.isArray(n.data.batchIds) && n.data.batchIds.includes(b.id))).map((n) => n.id)]))]);
}
useGenerationStore.subscribe((state, prev) => {
  if (state.batches !== prev.batches) syncFrozenNodes();
});
useGraphStore.subscribe((state, prev) => {
  if (state.nodes !== prev.nodes) syncFrozenNodes();
});
