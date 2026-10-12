import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, toGraphPayload, type GenerationPreview } from '../lib/api';
import { useGenerationStore } from '../store/generationStore';
import { useGraphStore } from '../store/graphStore';
import { MiniThumb } from './AssetThumb';

const headerBtn =
  'rounded-md border-2 border-outline bg-node px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-accent-soft disabled:pointer-events-none disabled:opacity-40';

const SETTING_LABELS: Record<string, string> = {
  aspect_ratio: 'Aspect ratio',
  quality: 'Quality',
  output_format: 'Format',
  background: 'Background',
  background_value: 'Background value',
  asset_category: 'Asset type',
  model: 'Model',
};

function Thumbs({ label, ids }: { label: string; ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-ink-2">
        {label} ({ids.length})
      </p>
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id, i) => (
          <span key={`${id}-${i}`} className="checkerboard block size-14 overflow-hidden rounded border-2 border-outline">
            <MiniThumb assetId={id} className="object-contain" />
          </span>
        ))}
      </div>
    </div>
  );
}

/** Preview Request (spec §14.4): exactly what each task will send, compiled by the backend. */
export function PreviewRequestDialog() {
  const nodeId = useGenerationStore((s) => s.previewNodeId);
  // Keyed so each opened node starts from fresh state.
  return nodeId ? <PreviewBody key={nodeId} nodeId={nodeId} /> : null;
}

async function fetchPreview(nodeId: string): Promise<GenerationPreview> {
  const g = useGraphStore.getState();
  if (!g.projectId) throw new Error('No project is open.');
  return api.previewGeneration({
    project_id: g.projectId,
    generate_node_id: nodeId,
    graph: toGraphPayload(g.nodes, g.edges, g.viewport),
  });
}

function PreviewBody({ nodeId }: { nodeId: string }) {
  const close = () => useGenerationStore.getState().openPreview(null);
  const [preview, setPreview] = useState<GenerationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [slot, setSlot] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  const refresh = () => {
    setLoading(true);
    fetchPreview(nodeId)
      .then((p) => {
        setPreview(p);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let alive = true;
    void fetchPreview(nodeId)
      .then((p) => alive && setPreview(p))
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useGenerationStore.getState().openPreview(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [nodeId]);

  const task = preview?.tasks[Math.min(slot, (preview?.tasks.length ?? 1) - 1)];
  const provider = preview?.provider;
  const errors = error ? [error] : (preview?.errors ?? []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Preview request"
      className="fixed inset-0 z-40 flex items-stretch justify-center bg-overlay p-6"
      onMouseDown={close}
    >
      <div
        className="flex w-full max-w-4xl flex-col overflow-hidden rounded-2xl border-2 border-outline bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b-2 border-outline px-4 py-3">
          <div className="mr-auto min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">Preview request</h2>
            <p className="text-[12px] text-ink-3">
              {preview && preview.total_tasks > 0
                ? `${preview.total_tasks} task${preview.total_tasks === 1 ? '' : 's'} · ${preview.mode === 'match' ? 'Match inputs' : 'Manual count'}`
                : 'Compiled from the current graph. Nothing is sent.'}
            </p>
          </div>
          <button type="button" className={headerBtn} disabled={loading} onClick={refresh}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button ref={closeRef} type="button" className={headerBtn} onClick={close}>
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[12px]">
          {errors.length > 0 && (
            <div role="alert" className="rounded-xl border-2 border-danger bg-danger-soft p-3 text-danger">
              <p className="mb-1 font-semibold">Fix these before generating:</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {provider && (
            <p className="text-ink-2">
              Provider: <span className="font-medium text-ink">{provider.name}</span>
              {provider.experimental && <span className="text-warning"> · experimental</span>}
              {' · '}
              <span className={provider.auth_state === 'connected' ? 'text-success' : 'text-danger'}>
                {provider.auth_state === 'connected' ? 'connected' : 'not connected'}
              </span>
            </p>
          )}

          {task && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="preview-task" className="text-[11px] font-medium text-ink-2">
                  Task
                </label>
                <select
                  id="preview-task"
                  className="min-w-0 max-w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-[12px]"
                  value={task.slot_index}
                  onChange={(e) => setSlot(Number(e.target.value))}
                >
                  {preview!.tasks.map((t) => (
                    <option key={t.slot_index} value={t.slot_index}>
                      {t.slot_index + 1}. {t.source_name ?? 'Text to image'} · variant {t.variant_index}
                    </option>
                  ))}
                </select>
                <span className="text-ink-3">
                  {task.operation === 'edit' ? 'Sent with input images' : 'Text only'}
                </span>
              </div>
              <pre className="whitespace-pre-wrap rounded-xl border-2 border-outline bg-node p-3 font-mono text-[12px] leading-relaxed text-ink">
                {task.prompt}
              </pre>
            </section>
          )}

          {preview && preview.total_tasks > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-3">
                <Thumbs label="Original (this task)" ids={task?.source_asset_id ? [task.source_asset_id] : []} />
                <Thumbs label="More originals (sent with it)" ids={task?.extra_original_asset_ids ?? []} />
                <Thumbs label="Theme images" ids={preview.theme_asset_ids ?? []} />
                <Thumbs label="Reference images" ids={preview.reference_asset_ids ?? []} />
                {(preview.palette?.length ?? 0) > 0 && (
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-ink-2">Palette</p>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.palette!.map((c, i) => (
                        <span key={i} className="flex items-center gap-1 text-[11px] text-ink-2">
                          <span className="size-5 rounded border border-outline" style={{ background: c.hex }} />
                          {c.role}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <p className="mb-1 text-[11px] font-medium text-ink-2">Requested settings</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {Object.entries(preview.settings ?? {})
                    .filter(([, v]) => v !== '')
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-ink-3">{SETTING_LABELS[k] ?? k}</dt>
                        <dd className="text-ink">{v}</dd>
                      </div>
                    ))}
                </dl>
                <p className="mt-2 text-[11px] text-ink-3">
                  The provider's support for these settings is not verified, so they are also written into the prompt.
                  The actual image size and format are recorded after each result arrives.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
