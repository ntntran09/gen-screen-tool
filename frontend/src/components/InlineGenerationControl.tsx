import { useId, useRef } from 'react';
import { isRunning, latestBatchFor, useGenerationStore } from '../store/generationStore';
import { isNodeLocked, useGraphStore } from '../store/graphStore';
import { ActionGlyph } from './IconAction';
import { resultActionFor } from '../graph/generation';

export function GenerateSymbol({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pointer-events-none">
    <path d="m9 3 2.5 6.5L18 12l-6.5 2.5L9 21l-2.5-6.5L0 12l6.5-2.5L9 3ZM19 2v6m-3-3h6" />
  </svg>;
}

function RetrySymbol() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
  </svg>;
}

export function GenerateEditButton({ nodeId, assetId, mode = 'retry', batchId, taskId }: {
  nodeId: string; assetId: string; mode?: 'retry' | 'variation'; batchId?: string | null; taskId?: string | null;
}) {
  const target = useGenerationStore((s) => s.editTarget);
  const generationId = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.inlineGeneration?.id);
  const history = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.inlineGeneration?.batchIds);
  const batch = useGenerationStore((s) => history?.length ? s.batches[history[history.length - 1]] : generationId ? latestBatchFor(s.batches, generationId) : null);
  const starting = useGenerationStore((s) => !!s.starting[nodeId]);
  const action = useGraphStore((s) => {
    const source = s.nodes.find((n) => n.id === nodeId);
    if (starting && target?.nodeId === nodeId && target.assetId === assetId) return target.mode ?? 'retry';
    return source?.data.inlineGeneration?.assetId === assetId && batch ? resultActionFor(s.nodes, nodeId, batch.id) : null;
  });
  const locked = useGraphStore((s) => {
    const source = s.nodes.find((n) => n.id === nodeId);
    return !source || isNodeLocked(source);
  });
  const open = target?.nodeId === nodeId && target.assetId === assetId && (target.mode ?? 'retry') === mode;
  const running = (starting || isRunning(batch)) && action === mode;
  const label = mode === 'variation' ? 'Create Variation' : 'Retry';
  const status = batch ? `${batch.status.replace('_', ' ')} · ${batch.completed_count}/${batch.expected_count}` : 'Open prompt';
  return <button type="button" disabled={locked || starting} aria-busy={running}
    className={`nodrag relative flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed ${running ? '' : 'disabled:opacity-40'}`}
    aria-label={`${label}: ${running ? status : 'Open prompt'}`} title={`${label} — ${running ? status : 'Open prompt'}`} aria-expanded={open}
    onClick={() => mode === 'variation' ? useGenerationStore.getState().openVariation(nodeId, assetId, batchId, taskId) : useGenerationStore.getState().openEdit(nodeId, assetId)}>
    {mode === 'variation' ? <ActionGlyph icon="variation" /> : <RetrySymbol />}
    {running && <span className="pointer-events-none absolute -inset-1 rounded-full border-2 border-accent border-t-transparent motion-safe:animate-spin" aria-hidden="true" />}
  </button>;
}

export function ResultEditPanel({ nodeId, assetId, batchId, taskId }: {
  nodeId: string; assetId: string; batchId?: string | null; taskId?: string | null;
}) {
  const target = useGenerationStore((s) => s.editTarget);
  const starting = useGenerationStore((s) => !!s.starting[nodeId]);
  const locked = useGraphStore((s) => {
    const node = s.nodes.find((n) => n.id === nodeId);
    return !node || isNodeLocked(node);
  });
  const inline = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.inlineGeneration);
  const batch = useGenerationStore((s) => inline?.batchIds.length ? s.batches[inline.batchIds[inline.batchIds.length - 1]] : inline ? latestBatchFor(s.batches, inline.id) : null);
  const inputId = useId();
  const sending = useRef(false);
  if (target?.nodeId !== nodeId || target.assetId !== assetId) return null;
  const run = async () => {
    if (sending.current || starting || locked || target.loading || target.error) return;
    sending.current = true;
    try {
      const generation = useGenerationStore.getState();
      const done = target.mode === 'variation'
        ? await generation.vary(nodeId, assetId, target.shortPrompt ?? '', target.batchId ?? batchId, target.taskId ?? taskId)
        : await generation.regenerate(nodeId, assetId, target.prompt, target.batchId ?? batchId, target.taskId ?? taskId);
      if (done) {
        const current = useGenerationStore.getState().editTarget;
        if (current?.nodeId === nodeId && current.assetId === assetId && current.mode === target.mode) useGenerationStore.getState().closeEdit();
      }
    } finally { sending.current = false; }
  };
  return <div className="nodrag nowheel mb-3 space-y-2 border-b border-line pb-3">
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={inputId} className="text-[11px] font-medium text-ink">{target.mode === 'variation' ? 'Variation' : 'Prompt (optional)'}</label>
      <button type="button" aria-label="Close prompt" title="Close prompt" onClick={() => useGenerationStore.getState().closeEdit()}
        className="flex size-6 items-center justify-center rounded text-ink-2 hover:bg-panel-2">
        <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
      </button>
    </div>
    {target.error && <p role="alert" className="text-[11px] text-danger">{target.error}</p>}
    <textarea id={inputId} autoFocus rows={3} value={target.shortPrompt ?? target.prompt} disabled={starting || locked || target.loading}
      placeholder={target.loading ? 'Loading...' : ''}
      className="w-full resize-y rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-focus"
      onChange={(e) => useGenerationStore.getState().setEditPrompt(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); useGenerationStore.getState().closeEdit(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(); }
      }} />
    <button type="button" disabled={target.loading} aria-expanded={!!target.expanded}
      onClick={() => useGenerationStore.getState().toggleFullPrompt()}
      className="flex items-center gap-1 text-[11px] text-ink-2 hover:text-ink disabled:opacity-40">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"
        className={target.expanded ? 'rotate-90' : ''}><path d="m9 5 7 7-7 7" /></svg>
      Full
    </button>
    {target.expanded && <textarea aria-label="Full prompt" readOnly rows={12} value={target.prompt || target.originalPrompt || ''}
      className="max-h-80 w-full resize-y rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[11px] text-ink outline-none focus:border-focus" />}
    {batch && <p role="status" className="text-[11px] text-ink-2">{batch.status.replace('_', ' ')} · {batch.completed_count}/{batch.expected_count}</p>}
    <button type="button" disabled={locked || starting || target.loading || !!target.error} onClick={() => void run()}
      className="w-full rounded-md border border-outline bg-accent px-2 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-accent-hover disabled:opacity-40">
      {starting ? 'Starting...' : target.mode === 'variation' ? 'Generate variation' : target.prompt.trim() ? 'Generate' : 'Retry'}
    </button>
  </div>;
}
