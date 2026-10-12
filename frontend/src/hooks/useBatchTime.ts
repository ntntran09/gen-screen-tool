import { useEffect, useState } from 'react';
import type { GenerationTask } from '../lib/api';
import { useGenerationStore } from '../store/generationStore';

const LIVE = new Set(['preparing', 'running', 'cancel_requested']);

/** "0:07", "1:05", "1:02:09". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Time a task spent generating (queue waiting is not counted); a live task counts up to `now`. */
export function taskMs(task: GenerationTask, now: number): number {
  if (!task.started_at) return 0;
  const start = Date.parse(task.started_at);
  const end = task.finished_at ? Date.parse(task.finished_at) : LIVE.has(task.status) ? now : start;
  return Math.max(0, end - start);
}

/**
 * Total generating time of a batch: every attempt's own duration added up, so pauses, waiting
 * and time with the app closed are not included. Ticks each second while something is running.
 */
export function useBatchTime(batchId: string | null | undefined): { ms: number; live: boolean } | null {
  const tasks = useGenerationStore((s) => (batchId ? s.tasks[batchId] : undefined));
  const live = tasks?.some((t) => LIVE.has(t.status)) ?? false;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    // Refresh right away (the stored time may be old), then every second.
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [live]);

  if (!tasks || !tasks.some((t) => t.started_at)) return null;
  // A stale `now` only makes a live task look shorter for a moment, never longer.
  return { ms: tasks.reduce((sum, t) => sum + taskMs(t, now), 0), live };
}
