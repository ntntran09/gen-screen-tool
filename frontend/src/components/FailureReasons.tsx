import { useEffect, useMemo } from 'react';
import { failureReasons, useGenerationStore } from '../store/generationStore';

/** The reasons a batch's images failed (safety rejection, network, timeout...), not just how many. */
export function FailureReasons({ batchId, max = 2 }: { batchId: string | null | undefined; max?: number }) {
  const tasks = useGenerationStore((s) => (batchId ? s.tasks[batchId] : undefined));
  const failed = useGenerationStore((s) => (batchId ? s.batches[batchId]?.failed_count ?? 0 : 0));
  const reasons = useMemo(() => failureReasons(tasks), [tasks]);
  // The tasks are fetched lazily: load them when the batch reports failures but their reasons are not here yet.
  useEffect(() => {
    if (batchId && failed > 0 && !tasks) void useGenerationStore.getState().loadTasks(batchId);
  }, [batchId, failed, tasks]);
  if (reasons.length === 0) return null;
  return (
    <ul role="alert" className="nodrag space-y-0.5 text-[11px] leading-snug text-danger">
      {reasons.slice(0, max).map((r) => (
        <li key={r.message} title={r.message} className="line-clamp-3 break-words">
          {r.count > 1 && <span className="font-semibold">{r.count}× </span>}
          {r.message}
        </li>
      ))}
      {reasons.length > max && <li className="text-ink-3">+{reasons.length - max} other reason{reasons.length - max === 1 ? '' : 's'} in the Inspector</li>}
    </ul>
  );
}
