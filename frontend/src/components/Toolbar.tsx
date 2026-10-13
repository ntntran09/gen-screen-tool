import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useState } from 'react';
import { api, type ProviderInfo } from '../lib/api';
import { useGraphStore, type SaveStatus } from '../store/graphStore';
import { ProviderDialog } from './ProviderDialog';

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Save failed',
};

const AUTH_LABEL: Record<string, string> = {
  not_connected: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  expired: 'Expired',
  permission_error: 'Permission error',
  provider_unavailable: 'Unavailable',
};

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[13px] text-ink-2 hover:bg-panel-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export function Toolbar({ onSave, onRename }: { onSave: () => void; onRename: (name: string) => void }) {
  const projectName = useGraphStore((s) => s.projectName);
  const saveStatus = useGraphStore((s) => s.saveStatus);
  const saveError = useGraphStore((s) => s.saveError);
  const canUndo = useGraphStore((s) => s.past.length > 0);
  const canRedo = useGraphStore((s) => s.future.length > 0);
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const [draft, setDraft] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [providerError, setProviderError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadProviders = useCallback(() => {
    api
      .listProviders()
      .then((list) => {
        setProvider(list[0] ?? null);
        setProviderError(false);
      })
      .catch(() => setProviderError(true));
  }, []);

  useEffect(loadProviders, [loadProviders]);

  const commitName = () => {
    const name = draft?.trim();
    if (name && name !== projectName) onRename(name);
    setDraft(null);
  };

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-b border-line bg-panel px-3">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md border-2 border-outline bg-accent text-[11px] font-black text-accent-ink">
          N
        </span>
        <span className="hidden text-[13px] font-semibold md:inline">NodeCanvas</span>
      </div>
      <span className="h-5 w-px bg-line" />

      {draft === null ? (
        <button
          type="button"
          className="max-w-64 truncate rounded px-1.5 py-0.5 text-[13px] text-ink hover:bg-panel-2"
          onClick={() => setDraft(projectName)}
          title="Rename project"
        >
          {projectName || 'Untitled'}
        </button>
      ) : (
        <input
          autoFocus
          aria-label="Project name"
          className="w-56 rounded border border-focus bg-panel-2 px-1.5 py-0.5 text-[13px] outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
            if (e.key === 'Escape') setDraft(null);
          }}
        />
      )}
      <button
        type="button"
        onClick={onSave}
        className={`text-[11px] ${saveStatus === 'error' ? 'text-danger' : 'text-ink-3 hover:text-ink-2'}`}
        title={saveError ?? 'Save now (Ctrl+S)'}
      >
        {SAVE_LABEL[saveStatus]}
      </button>

      <div className="ml-2 flex items-center gap-0.5">
        <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>↶</IconButton>
        <IconButton label="Redo (Ctrl+Y)" onClick={redo} disabled={!canRedo}>↷</IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Zoom out" onClick={() => void zoomOut({ duration: 150 })}>−</IconButton>
        <IconButton label="Zoom in" onClick={() => void zoomIn({ duration: 150 })}>+</IconButton>
        <IconButton label="Fit view (Shift+1)" onClick={() => void fitView({ padding: 0.2, duration: 200 })}>⤢</IconButton>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-[12px] hover:border-line-strong hover:bg-panel-2"
          title="AI provider connection"
        >
          <span
            className={`size-2 rounded-full ${provider?.auth_state === 'connected' ? 'bg-success' : 'bg-ink-3'}`}
            aria-hidden
          />
          {providerError ? (
            <span className="text-danger">Backend offline</span>
          ) : provider ? (
            <>
              <span className="hidden text-ink-2 lg:inline">{provider.name}</span>
              <span className="text-ink-2 lg:hidden">Codex</span>
              {provider.experimental && <span className="text-[10px] font-semibold uppercase text-warning">exp</span>}
              <span className="text-ink-3">· {AUTH_LABEL[provider.auth_state] ?? provider.auth_state}</span>
            </>
          ) : (
            <span className="text-ink-3">Loading…</span>
          )}
        </button>
      </div>
      {dialogOpen && <ProviderDialog onClose={() => setDialogOpen(false)} onChanged={loadProviders} />}
    </header>
  );
}
