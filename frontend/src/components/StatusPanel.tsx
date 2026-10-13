import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { GenerationBatch } from '../lib/api';
import { formatDuration, useBatchTime } from '../hooks/useBatchTime';
import { OPEN_STATUSES, useGenerationStore } from '../store/generationStore';
import { useGraphStore } from '../store/graphStore';

const STATUS_LABEL: Record<GenerationBatch['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  interrupted: 'Interrupted',
  completed: 'Completed',
  partially_completed: 'Partly completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const linkBtn = 'rounded px-1 font-medium text-ink-2 underline-offset-2 hover:text-ink hover:underline';

function JobTime({ batchId }: { batchId: string }) {
  const time = useBatchTime(batchId);
  if (!time) return null;
  return (
    <span className="font-mono tabular-nums" title="Time spent generating">
      ⏱ {formatDuration(time.ms)}
    </span>
  );
}

/** Bottom job panel (spec §3.1 E): open batches first, otherwise the most recent one. */
function Jobs() {
  const batches = useGenerationStore(
    useShallow((s) => Object.values(s.batches).sort((a, b) => b.created_at.localeCompare(a.created_at))),
  );
  const open = batches.filter((b) => OPEN_STATUSES.includes(b.status));
  const shown = open.length ? open.slice(0, 3) : batches.slice(0, 1);
  const { resume, retry, cancel } = useGenerationStore.getState();
  const focus = (b: GenerationBatch) => {
    const g = useGraphStore.getState();
    useGraphStore.setState({ nodes: g.nodes.map((n) => ({ ...n, selected: n.id === b.generate_node_id })) });
  };
  if (shown.length === 0) return <span>No generation jobs</span>;
  return (
    <div className="flex min-w-0 items-center gap-4" aria-live="polite">
      {shown.map((b) => (
        <span key={b.id} className="flex min-w-0 items-center gap-1.5">
          <button type="button" className={`${linkBtn} truncate`} onClick={() => focus(b)} title="Select the Generate node">
            {b.name || 'Generate'}
          </button>
          <span className={b.status === 'failed' || b.status === 'paused' ? 'text-danger' : ''}>{STATUS_LABEL[b.status]}</span>
          <span>
            {b.completed_count}/{b.expected_count}
            {b.failed_count > 0 && ` · ${b.failed_count} failed`}
            {b.cancelled_count > 0 && ` · ${b.cancelled_count} cancelled`}
          </span>
          <JobTime batchId={b.id} />
          {(b.status === 'paused' || b.status === 'interrupted') && b.active_count > 0 && (
            <button type="button" className={linkBtn} onClick={() => void resume(b.id)}>
              Resume
            </button>
          )}
          {OPEN_STATUSES.includes(b.status) && !b.cancel_requested && (
            <button type="button" className={linkBtn} onClick={() => void cancel(b.id)}
              title="Stops the images not sent yet. A request already sent cannot be stopped.">
              Cancel
            </button>
          )}
          {b.failed_count > 0 && b.status !== 'running' && b.status !== 'queued' && (
            <button type="button" className={linkBtn} onClick={() => void retry(b.id)}>
              Retry failed
            </button>
          )}
        </span>
      ))}
      {open.length > shown.length && <span>+{open.length - shown.length} more</span>}
    </div>
  );
}

export function StatusPanel() {
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const edgeCount = useGraphStore((s) => s.edges.length);
  const selectedCount = useGraphStore((s) => s.nodes.filter((n) => n.selected).length);

  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-ink-3">
      <Jobs />
      <span className="ml-auto shrink-0">
        {nodeCount} nodes · {edgeCount} connections{selectedCount > 0 && ` · ${selectedCount} selected`}
      </span>
    </footer>
  );
}

export function ToastHost() {
  const toast = useGraphStore((s) => s.toast);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => {
      if (useGraphStore.getState().toast?.id === toast.id) useGraphStore.setState({ toast: null });
    }, 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed bottom-12 left-1/2 z-50 -translate-x-1/2 rounded-xl border-2 px-3 py-2 text-[12px] ${
        toast.tone === 'error' ? 'border-danger bg-danger-soft text-danger' : 'border-outline bg-panel text-ink'
      }`}
    >
      {toast.message}
    </div>
  );
}
