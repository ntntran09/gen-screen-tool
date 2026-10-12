import { useEffect } from 'react';
import { useGraphStore } from '../store/graphStore';

export function StatusPanel() {
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const edgeCount = useGraphStore((s) => s.edges.length);
  const selectedCount = useGraphStore((s) => s.nodes.filter((n) => n.selected).length);

  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-ink-3">
      <span>No generation jobs</span>
      <span className="ml-auto">
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
