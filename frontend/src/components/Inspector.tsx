import { NodeIcon } from './NodeIcon';
import { IconAction, ActionGlyph } from './IconAction';
import { OutputActions } from './OutputActions';
import { OutputPlaceholder } from './OutputPlaceholder';
import { nanoid } from 'nanoid';
import { useEffect, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getDefinition, LIMITS } from '../graph/registry';
import {
  ASPECT_RATIOS,
  PRESETS,
  aspectLabel,
  COLOR_ROLES,
  THEME_ROLES,
  type AnyNodeData,
  type CanvasNode,
  type CollectionData,
  type ExtractData,
  type GenerateData,
  type ImageData,
  type OutputData,
  type PaletteData,
  type PromptData,
  type NodeDataByKind,
} from '../graph/types';
import { nodeAssetId } from '../graph/collections';
import { appendSnippet, availableSnippets, connectedPorts, hasSnippet } from '../graph/promptSnippets';
import { useImageImport } from '../hooks/useImageImport';
import { formatDuration, taskMs } from '../hooks/useBatchTime';
import { useImageRoles } from '../hooks/useImageRoles';
import { api, assetUrls, type ProviderInfo } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { pickImageFiles } from '../lib/filePicker';
import { useAssetStore } from '../store/assetStore';
import { isRunning, latestAttempts, latestBatchFor, OPEN_STATUSES, useGenerationStore } from '../store/generationStore';
import { isNodeFrozen, useGraphStore } from '../store/graphStore';
import { AssetThumb, formatBytes } from './AssetThumb';
import { ExtractFields } from './ExtractFields';
import { Button, NumberInput, Section, Select, TextArea, TextInput, Toggle } from './fields';

const THEME_LABELS: Record<(typeof THEME_ROLES)[number], string> = {
  artStyle: 'Art style',
  lighting: 'Lighting',
  shading: 'Shading',
  material: 'Material',
  mood: 'Mood',
  composition: 'Composition',
  texture: 'Texture',
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type Update = (patch: Partial<AnyNodeData>) => void;

function PromptFields({ nodeId, data, update }: { nodeId: string; data: PromptData; update: Update }) {
  // A joined string keeps the selector result stable between renders.
  const wiring = useGraphStore((s) => {
    const { feeds, ports } = connectedPorts(nodeId, s.nodes, s.edges);
    return `${feeds ? 1 : 0}:${[...ports].sort().join(',')}`;
  });
  const [feedsFlag, portList] = wiring.split(':');
  const snippets = availableSnippets(feedsFlag === '1', new Set(portList ? portList.split(',') : []));
  return (
    <Section
      title=""
      note="Fills the {{USER_PROMPT}} slot of the preset on the Generate node. Put any art direction notes here too."
    >
      <TextArea
        label="Prompt"
        action={<IconAction icon="copy" label="Copy prompt" onClick={() => void copyText(data.text)} disabled={!data.text} />}
        rows={8}
        value={data.text}
        onChange={(text) => update({ text })}
        placeholder="e.g. Change it to a wool crochet style."
        hint={
          <>
            Variables: <code>{'{asset_name}'}</code> <code>{'{asset_index}'}</code> <code>{'{collection_name}'}</code>{' '}
            <code>{'{variant_index}'}</code>
          </>
        }
      />
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-ink-2">Add to prompt</p>
        <p className="text-[11px] text-ink-3">Reference, palette and theme sentences show when that input is connected to the Generate node.</p>
        <div className="flex flex-wrap gap-1.5">
          {snippets.map((snippet) => {
            const added = hasSnippet(data.text, snippet.text);
            return (
              <button
                key={snippet.id}
                type="button"
                disabled={added || data.locked}
                title={added ? 'Already in the prompt' : snippet.text}
                onClick={() => update({ text: appendSnippet(data.text, snippet.text) })}
                className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-accent-soft hover:text-ink disabled:cursor-default disabled:bg-panel-2 disabled:opacity-60"
              >
                {added ? '✓ ' : '+ '}
                {snippet.label}
              </button>
            );
          })}
        </div>
      </div>
      <Toggle label="Enabled" checked={data.enabled} onChange={(enabled) => update({ enabled })} />
    </Section>
  );
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function AssetNameField({ assetId, name, compact = false }: { assetId: string; name: string; compact?: boolean }) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const next = draft.trim();
    if (!next || next === name) return setDraft(name);
    useAssetStore
      .getState()
      .rename(assetId, next)
      .catch((e: Error) => {
        setDraft(name);
        useGraphStore.getState().showToast(e.message, 'error');
      });
  };
  return (
    <TextInput
      label="File name"
      value={draft}
      onChange={setDraft}
      onBlur={commit}
      onEnter={commit}
      hint={compact ? undefined : 'Display name only. The stored file is never renamed or overwritten.'}
    />
  );
}

/** Preview, file facts and actions for the image a node points at (spec §6.3–6.4). */
function AssetPanel({ nodeId, assetId, canReplace, actions, compact = false }: { nodeId: string; assetId: string | null; canReplace: boolean; actions?: ReactNode; compact?: boolean }) {
  const asset = useAssetStore((s) => (assetId ? s.assets[assetId] : undefined));
  const importImages = useImageImport();
  const choose = async () => {
    const files = await pickImageFiles(false);
    if (files.length) await importImages(files, { replaceNodeId: nodeId });
  };
  const g = asset ? gcd(asset.width, asset.height) : 1;

  return (
    <div className="space-y-3">
      {actions}
      <button
        type="button"
        className="block w-full disabled:cursor-default"
        onClick={() => assetId && useAssetStore.getState().setPreview(assetId)}
        disabled={!assetId || asset?.missing}
        aria-label="View full size"
      >
        <AssetThumb assetId={assetId} emptyLabel="No image yet" />
      </button>
      {asset && (
        <>
          {compact && <p className="text-[11px] text-ink-2">{asset.width} × {asset.height} · {asset.format} · {formatBytes(asset.file_size)}</p>}
          <details open={compact ? undefined : true}>
            <summary className={compact ? 'cursor-pointer text-[12px] text-ink-2' : 'hidden'}>File</summary>
            <AssetNameField assetId={asset.id} name={asset.name} compact={compact} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-ink-3">Resolution</dt>
            <dd>
              {asset.width} × {asset.height} px
            </dd>
            <dt className="text-ink-3">Aspect</dt>
            <dd>
              {asset.width / g}:{asset.height / g}
            </dd>
            <dt className="text-ink-3">Format</dt>
            <dd>{asset.format}</dd>
            <dt className="text-ink-3">Size</dt>
            <dd>{formatBytes(asset.file_size)}</dd>
            <dt className="text-ink-3">Source</dt>
            <dd className="truncate" title={asset.original_filename}>
              {asset.origin === 'upload' ? asset.original_filename : asset.origin}
            </dd>
          </dl>
          </details>
        </>
      )}
      {!compact && <div className="flex flex-wrap gap-2">
        {canReplace && <IconAction icon="image" label={assetId ? 'Replace image' : 'Choose image'} onClick={() => void choose()} />}
        {asset && !asset.missing && (
          <>
                        <a
              href={assetUrls.download(asset.id)}
              className="inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink" title="Download" aria-label="Download"
            >
              <ActionGlyph icon="download" />
            </a>
          </>
        )}
      </div>}

    </div>
  );
}

function ImageFields({ nodeId, data, update }: { nodeId: string; data: ImageData; update: Update }) {
  const roles = useImageRoles(nodeId);
  return (
    <>
      <Section
        title="Image"
        note={
          roles.length
            ? `Used as: ${roles.join(', ')} (from the Generate ports it connects to).`
            : 'Connect it to a Generate node: the port decides whether it is the Original, a Theme or a Reference.'
        }
      >
        <AssetPanel nodeId={nodeId} assetId={data.assetId} canReplace={!data.locked} />
        <TextArea label="Notes" rows={2} value={data.notes} onChange={(notes) => update({ notes })} hint="Sent with Theme and Reference images." />
      </Section>
      {roles.includes('Theme') && <ThemeFields data={data} update={update} />}
    </>
  );
}

/** Loads a batch's tasks once so the inspector can show them. */
function useBatchTasks(batchId: string | null) {
  const tasks = useGenerationStore((s) => (batchId ? s.tasks[batchId] : undefined));
  useEffect(() => {
    if (batchId && !tasks) void useGenerationStore.getState().loadTasks(batchId).catch(() => undefined);
  }, [batchId, tasks]);
  return tasks;
}

/** Requested vs actual output and the prompt that was sent (spec §16.2, §19.7). */
function GenerationFacts({ batchId, taskId }: { batchId: string | null; taskId: string | null }) {
  const tasks = useBatchTasks(batchId);
  const batch = useGenerationStore((s) => (batchId ? s.batches[batchId] : undefined));
  const task = tasks?.find((t) => t.id === taskId);
  if (!task) return null;
  const r = task.result;
  return (
    <details className="border-b border-line px-4 py-3">
      <summary className="cursor-pointer text-[12px] text-ink-2">Generation</summary>
      <div className="mt-3 space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-ink-3">Batch</dt>
        <dd className="truncate">{batch?.name ?? '—'}</dd>
        <dt className="text-ink-3">Source</dt>
        <dd className="truncate">{task.source_name ?? 'Text to image'}</dd>
        <dt className="text-ink-3">Variant</dt>
        <dd>
          {task.variant_index}
          {task.attempt_number > 1 && <span className="text-ink-3"> · attempt {task.attempt_number}</span>}
        </dd>
        {task.started_at && task.finished_at && (
          <>
            <dt className="text-ink-3">Took</dt>
            <dd className="font-mono tabular-nums">{formatDuration(taskMs(task, 0))}</dd>
          </>
        )}
        <dt className="text-ink-3">Requested</dt>
        <dd>
          {task.request.settings.aspect_ratio} · {task.request.settings.quality}
        </dd>
        {r && (
          <>
            <dt className="text-ink-3">Actual</dt>
            <dd>
              {r.width}×{r.height} · {r.mime_type.split('/')[1].toUpperCase()}
              {r.has_alpha ? ' · alpha' : ' · no alpha'}
            </dd>
            <dt className="text-ink-3">Model</dt>
            <dd className="truncate">{r.reported_model ?? 'not reported'}</dd>
          </>
        )}
      </dl>
      <details className="text-[12px]">
        <summary className="cursor-pointer text-ink-2">Prompt sent</summary>
        <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-panel-2 p-2 font-mono text-[11px] leading-relaxed">
          {task.prompt}
        </pre>
      </details>
      </div>
    </details>
  );
}

function OutputFields({ node }: { node: CanvasNode }) {
  const data = node.data as OutputData;
  return (
    <>
      <Section title="" note={data.assetId ? undefined : 'Waiting for the generation to finish.'}>
        {data.assetId ? (
          <>
            <AssetPanel nodeId={node.id} assetId={data.assetId} canReplace={false} compact
              actions={<OutputActions key={`${node.id}:${data.assetId}`} nodeId={node.id} assetId={data.assetId} batchId={data.generationId} taskId={data.taskId} />} />
          </>
        ) : <OutputPlaceholder data={data} />}
      </Section>
      <GenerationFacts batchId={data.generationId} taskId={data.taskId} />
    </>
  );
}

/** Progress and failed results for an Output Collection's batches (spec §17.2, §29.6). */
function OutputBatches({ batchIds }: { batchIds: string[] }) {
  const recent = batchIds.slice(-3).reverse();
  return (
    <Section title="Generations">
      {recent.length === 0 && <p className="text-[12px] text-ink-3">No generation has sent results here yet.</p>}
      {recent.map((id) => (
        <OutputBatchRow key={id} batchId={id} />
      ))}
    </Section>
  );
}

function OutputBatchRow({ batchId }: { batchId: string }) {
  const batch = useGenerationStore((s) => s.batches[batchId]);
  const tasks = useBatchTasks(batchId);
  if (!batch) return <p className="text-[12px] text-ink-3">Generation details unavailable.</p>;
  const failed = latestAttempts(tasks).filter((t) => t.status === 'failed' || t.status === 'interrupted');
  const busy = batch.status === 'queued' || batch.status === 'running';
  return (
    <div className="space-y-1.5 text-[12px]">
      <p className="text-ink-2">
        <span className="font-medium text-ink">{new Date(batch.created_at).toLocaleString()}</span> ·{' '}
        {batch.completed_count}/{batch.expected_count} done
        {batch.failed_count > 0 && <span className="text-danger"> · {batch.failed_count} failed</span>}
        {OPEN_STATUSES.includes(batch.status) && <span> · {batch.status}</span>}
      </p>
      {failed.length > 0 && (
        <ul className="space-y-1">
          {failed.map((t) => (
            <li key={t.id} className="rounded-md border border-danger/40 bg-danger-soft px-2 py-1 text-[11px] text-danger">
              <span className="font-medium">
                {t.source_name ?? `Image ${t.slot_index + 1}`} v{t.variant_index}
              </span>
              : {t.error_message ?? t.error_code}
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && !busy && (
        <Button onClick={() => void useGenerationStore.getState().retry(batchId)}>Retry failed ({failed.length})</Button>
      )}
    </div>
  );
}

function ThemeFields({ data, update }: { data: ImageData; update: Update }) {
  return (
    <Section title="As theme">
      <div className="grid grid-cols-2 gap-2">
        {THEME_ROLES.map((role) => (
          <Toggle
            key={role}
            label={THEME_LABELS[role]}
            checked={data.roles.includes(role)}
            onChange={(on) => update({ roles: on ? [...data.roles, role] : data.roles.filter((r) => r !== role) })}
          />
        ))}
      </div>
    </Section>
  );
}

/** Pull dominant colours from the connected image. */
function ExtractPalette({ nodeId, data, update }: { nodeId: string; data: PaletteData; update: Update }) {
  const connectedAssetId = useGraphStore((s) => {
    const e = s.edges.find((x) => x.target === nodeId && x.targetHandle === 'image');
    const src = e && s.nodes.find((n) => n.id === e.source);
    return src ? nodeAssetId(src) : null;
  });
  const [busy, setBusy] = useState(false);
  const count = data.extractCount ?? 5;

  const fromConnection = async () => {
    setBusy(true);
    await useGraphStore.getState().extractPalette(nodeId, count);
    setBusy(false);
  };

  if (!connectedAssetId) return null;

  return (
    <Section title="Colors from an image">
      <NumberInput label="Number of colors" value={count} min={2} max={8} onChange={(extractCount) => update({ extractCount })} />
        <Button variant="primary" disabled={busy} onClick={() => void fromConnection()}>
          {busy ? 'Reading…' : 'Re-read connected image'}
        </Button>
    </Section>
  );
}

function PaletteFields({ nodeId, data, update }: { nodeId: string; data: PaletteData; update: Update }) {
  const setColor = (id: string, patch: Partial<PaletteData['colors'][number]>) =>
    update({ colors: data.colors.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const move = (index: number, delta: number) => {
    const next = [...data.colors];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    update({ colors: next });
  };
  return (
    <>
      <Section title="Colors" note="Converted to color instructions; exact pixel colors are not guaranteed.">
        <ul className="space-y-2">
          {data.colors.map((c, i) => (
            <li key={c.id} className="flex items-center gap-1.5">
              <input
                type="color"
                aria-label="Pick color"
                className="size-7 shrink-0 cursor-pointer rounded border border-line bg-transparent"
                value={HEX_RE.test(c.hex) ? c.hex : '#000000'}
                onChange={(e) => setColor(c.id, { hex: e.target.value.toUpperCase() })}
              />
              <input
                aria-label="HEX value"
                className={`w-20 rounded-md border bg-panel-2 px-1.5 py-1 font-mono text-[11px] outline-none ${
                  HEX_RE.test(c.hex) ? 'border-line' : 'border-danger'
                }`}
                value={c.hex}
                onChange={(e) => setColor(c.id, { hex: e.target.value.trim() })}
              />
              <select
                aria-label="Color role"
                className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-1 py-1 text-[11px]"
                value={c.role}
                onChange={(e) => setColor(c.id, { role: e.target.value as (typeof COLOR_ROLES)[number] })}
              >
                {COLOR_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button type="button" className="px-1 text-ink-3 hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                ↑
              </button>
              <button type="button" className="px-1 text-ink-3 hover:text-ink disabled:opacity-30" disabled={i === data.colors.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                ↓
              </button>
              <button type="button" className="px-1 text-ink-3 hover:text-danger" onClick={() => update({ colors: data.colors.filter((x) => x.id !== c.id) })} aria-label="Remove color">
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <IconAction icon="add" label="Add color" onClick={() => update({ colors: [...data.colors, { id: nanoid(8), hex: '#FFFFFF', role: 'accent', ratio: null }] })} />
          <IconAction icon="copy" label="Copy HEX" onClick={() => void copyText(data.colors.map((c) => c.hex).join(', '))} disabled={data.colors.length === 0} />
        </div>
      </Section>
      <ExtractPalette nodeId={nodeId} data={data} update={update} />
    </>
  );
}

function CollectionFields({ nodeId, data, update }: { nodeId: string; data: CollectionData; update: Update }) {
  const importImages = useImageImport();
  const ungroup = useGraphStore((s) => s.ungroupCollection);
  const items = data.items ?? [];
  const enabled = items.filter((i) => i.enabled).length;
  const overrides = items.filter((i) => i.promptOverride.trim()).length;
  const canAdd = !data.locked && data.role === 'input';
  const folded = data.foldedIds ?? [];
  const foldedGenerateId = useGraphStore((s) => (folded.length ? s.nodes.find((n) => n.type === 'generate' && folded.includes(n.id))?.id : undefined));
  const foldedBatch = useGenerationStore((s) => (foldedGenerateId ? latestBatchFor(s.batches, foldedGenerateId) : null));
  const foldedRunning = useGenerationStore((s) => Boolean(foldedGenerateId && s.starting[foldedGenerateId])) || isRunning(foldedBatch);
  return (
    <>
      {foldedGenerateId && (
        <Section title="Workflow" note="The Prompt, Generate and style Image nodes are folded into this collection's generate button. Ungroup to edit the prompt, quality or other settings.">
          <Button variant="primary" disabled={foldedRunning || data.locked} onClick={() => void useGenerationStore.getState().start(foldedGenerateId)}>
            {foldedRunning ? 'Generating…' : 'Generate'}
          </Button>
          {foldedBatch && OPEN_STATUSES.includes(foldedBatch.status) && (
            <Button disabled={foldedBatch.cancel_requested} onClick={() => void useGenerationStore.getState().cancel(foldedBatch.id)}>
              {foldedBatch.cancel_requested ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
          <Button disabled={foldedRunning} onClick={() => useGraphStore.getState().ungroupWorkflow(nodeId)}>Ungroup</Button>
        </Section>
      )}
      <Section title="Collection">
        <div className="flex flex-wrap gap-2">
          <IconAction icon="preview" label="Open collection" onClick={() => useAssetStore.getState().openViewer(nodeId)} />
          {data.role === 'output' && items.length > 0 && <IconAction icon="expand" label="Expand to nodes" onClick={() => useGraphStore.getState().expandCollection(nodeId)} />}
          {canAdd && (
            <IconAction icon="add" label="Add images" onClick={() => void pickImageFiles(true).then((files) => importImages(files, { collectionNodeId: nodeId }))} />
          )}
          {canAdd && items.length > 0 && (
            <IconAction icon="expand" label="Ungroup" onClick={() => ungroup(nodeId)} />
          )}
        </div>
        <details className="text-[12px] text-ink-2">
          <summary className="cursor-pointer">Advanced</summary>
          <div className="mt-3 space-y-3">
        <Select
          label="Type"
          value={data.role}
          options={[
            { value: 'input', label: 'Input collection' },
            { value: 'output', label: 'Output collection' },
          ]}
          onChange={(role) => update({ role })}
          hint={data.role === 'input' ? 'Feeds the Original port of a Generate node.' : 'Receives generated results.'}
        />
        <TextArea label="Description" rows={2} value={data.description} onChange={(description) => update({ description })} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-ink-3">Images</dt>
          <dd>{items.length}</dd>
          <dt className="text-ink-3">Enabled</dt>
          <dd>{enabled}</dd>
          {data.role === 'input' && (
            <>
              <dt className="text-ink-3">Prompt overrides</dt>
              <dd>{overrides}</dd>
            </>
          )}
        </dl>
          </div>
        </details>

      </Section>
      {data.role === 'output' && <OutputBatches batchIds={data.batchIds ?? []} />}
    </>
  );
}

function GenerateFields({ id, data, update }: { id: string; data: GenerateData; update: Update }) {
  const starting = useGenerationStore((s) => !!s.starting[id]);
  // Select the store's own node objects: useShallow compares items by identity, so mapping to
  // fresh objects inside the selector would never compare equal and re-render forever.
  const originalNodes = useGraphStore(
    useShallow((s) =>
      s.edges
        .filter((e) => e.target === id && e.targetHandle === 'original')
        .map((e) => s.nodes.find((n) => n.id === e.source))
        .filter((n): n is CanvasNode => !!n),
    ),
  ).map((n) => ({ id: n.id, type: n.type, title: n.data.title }));
  const hasCollection = originalNodes.some((n) => n.type === 'collection');
  const needsPrimary = data.mode === 'manual' && (originalNodes.length > 1 || hasCollection);
  const primaryOptions = originalNodes.filter((n) => n.type !== 'collection');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    let alive = true;
    api.listProviders().then((list) => alive && setProviders(list), () => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const batches = useGenerationStore(
    useShallow((s) =>
      Object.values(s.batches)
        .filter((b) => b.generate_node_id === id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5),
    ),
  );

  return (
    <>
      <Section
        title=""
        note={data.editResult ? 'Edits the connected result using the Prompt. Unspecified details stay the same.' : 'Your Prompt fills the selected template; Palette, Theme and Reference images are added to it.'}
      >
        <Select
          label="Preset"
          value={data.editResult ? 'result_edit' : data.preset}
          options={[...(data.editResult ? [{ value: 'result_edit', label: 'Edit result' }] : []), ...PRESETS.map((p) => ({ value: p.id, label: p.label }))]}
          onChange={(preset) => update(preset === 'result_edit' ? { editResult: true } : { editResult: false, preset, ...(preset === 'screen' ? { aspectRatio: 'match' } : {}) })}
          hint={PRESETS.find((p) => p.id === data.preset)?.description}
        />
        {!data.editResult && data.preset === 'assets' && (
          <TextArea
            label="Assets"
            rows={3}
            value={data.assetSelection}
            onChange={(assetSelection) => update({ assetSelection })}
            placeholder="e.g. pots, flowers, ice and number badges"
            hint="Leave empty to let the AI pick the distinct assets. The Extract Assets node can fill this in for you."
          />
        )}
      </Section>
      <Section title="Image" note="The AI treats these as requests, not guarantees. Each result shows the size it actually came back with.">
        <Select
          label="Aspect ratio"
          value={data.aspectRatio}
          options={ASPECT_RATIOS.map((a) => ({ value: a, label: aspectLabel(a) }))}
          onChange={(aspectRatio) => update({ aspectRatio })}
          hint={data.aspectRatio === 'match' ? 'Uses the shape closest to each original image (a phone screenshot → 9:16).' : undefined}
        />
        <Select
          label="Quality"
          value={data.quality}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
          onChange={(quality) => update({ quality })}
        />
        <Select label="File format" value={data.outputFormat}
          options={[{ value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP (lossless)' }, { value: 'jpg', label: 'JPG' }]}
          onChange={(outputFormat) => update({ outputFormat })}
          hint={data.outputFormat === 'jpg' ? 'JPG removes transparency using a white background.' : 'Transparency is preserved when returned by the provider.'} />
      </Section>
      <Section title="Outputs">
        <Select
          label="Mode"
          value={data.mode}
          options={[
            { value: 'manual', label: 'Manual count' },
            { value: 'match', label: 'Match inputs' },
          ]}
          onChange={(mode) => update({ mode })}
        />
        {data.mode === 'manual' ? (
          <NumberInput
            label="Count"
            value={data.outputCount}
            min={1}
            max={LIMITS.maxOutputCount}
            onChange={(outputCount) => update({ outputCount })}
          />
        ) : (
          <NumberInput
            label="Variants"
            value={data.variantsPerInput}
            min={1}
            max={LIMITS.maxVariantsPerInput}
            onChange={(variantsPerInput) => update({ variantsPerInput })}
            hint="Expected outputs = originals × variants."
          />
        )}
        {needsPrimary && (
          <Select
            label="Primary original"
            value={data.primaryOriginalNodeId ?? ''}
            options={[
              { value: '', label: 'Choose one…' },
              ...primaryOptions.map((n) => ({ value: n.id, label: n.title })),
            ]}
            onChange={(v) => update({ primaryOriginalNodeId: v || null })}
            hint="All connected originals are sent. The primary is the main one (image 1): pick it here or click its wire on the canvas. Or switch to Match inputs for one result per original."
          />
        )}
      </Section>

      <Section title="Run">
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={data.locked || starting} onClick={() => void useGenerationStore.getState().start(id)}>{starting ? 'Starting...' : 'Generate'}</Button>
          <IconAction icon="preview" label="Preview request" onClick={() => useGenerationStore.getState().openPreview(id)} />
        </div>
      </Section>
      <details className="border-b border-line px-4 py-3">
        <summary className="cursor-pointer text-[12px] text-ink-2">Advanced</summary>
        <div className="mt-3 space-y-3">
        <Select
          label="Provider"
          value={data.providerId}
          options={[
            ...providers.map((p) => ({ value: p.id, label: p.name })),
            // Keep an unknown saved id visible instead of silently showing another provider.
            ...(providers.some((p) => p.id === data.providerId) ? [] : [{ value: data.providerId, label: `${data.providerId} (unavailable)` }]),
          ]}
          onChange={(providerId) => update({ providerId })}
        />
        {batches.length > 0 && (
          <ul className="space-y-1 text-[12px] text-ink-2">
            {batches.map((b) => (
              <li key={b.id}>
                <span className="text-ink-3">{new Date(b.created_at).toLocaleTimeString()}</span> ·{' '}
                {b.status.replace('_', ' ')} · {b.completed_count}/{b.expected_count}
                {b.failed_count > 0 && <span className="text-danger"> · {b.failed_count} failed</span>}
              </li>
            ))}
          </ul>
        )}
        </div>
      </details>
    </>
  );
}

export function Inspector() {
  const selected = useGraphStore(useShallow((s) => s.nodes.filter((n) => n.selected)));
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const duplicateSelected = useGraphStore((s) => s.duplicateSelected);
  const deleteSelected = useGraphStore((s) => s.deleteSelected);
  const groupIntoCollection = useGraphStore((s) => s.groupIntoCollection);
  const groupable = selected.filter((n) => nodeAssetId(n) && !n.data.locked).length;

  if (selected.length === 0) {
    return <p className="p-4 text-[12px] text-ink-3">Select a node to edit its properties.</p>;
  }
  if (selected.length > 1) {
    return (
      <div className="space-y-3 p-4">
        <p className="text-[12px] text-ink-2">{selected.length} nodes selected</p>
        <div className="flex flex-wrap gap-2">
          {groupable >= 2 && <Button onClick={() => groupIntoCollection()}>Group into collection</Button>}
          <Button onClick={duplicateSelected}>Duplicate</Button>
          <Button variant="danger" onClick={deleteSelected}>
            Delete
          </Button>
        </div>

      </div>
    );
  }

  const node = selected[0];
  const frozen = isNodeFrozen(node.id);
  const def = getDefinition(node.type!);
  const update: Update = (patch) => updateNodeData(node.id, patch);
  const d = node.data;

  return (
    <div>
      {frozen && <FrozenBanner />}
      <div className="flex items-start gap-2.5 border-b border-line px-4 py-3">
        <span className="mt-1">
          <NodeIcon kind={node.type!} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <EditableTitle key={node.id} value={d.title} disabled={frozen} onCommit={(title) => update({ title })} />
          <p className="text-[11px] text-ink-3">{def.label}</p>
        </div>
        <IconToggle
          disabled={frozen}
          on={d.collapsed}
          onChange={(collapsed) => update({ collapsed })}
          label={d.collapsed ? 'Expand node on the canvas' : 'Collapse node on the canvas'}
          icon={d.collapsed ? <path d="m9 18 6-6-6-6" /> : <path d="m6 9 6 6 6-6" />}
        />
        <IconToggle
          disabled={frozen}
          on={d.locked}
          onChange={(locked) => update({ locked })}
          label={d.locked ? 'Locked: cannot be moved or deleted. Click to unlock' : 'Lock: prevent moving and deleting'}
          icon={
            <>
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d={d.locked ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.9-1'} />
            </>
          }
        />
      </div>
      <fieldset disabled={frozen} className="m-0 min-w-0 border-0 p-0">
        {node.type === 'text' && <Section title="">
          <TextArea label="Text" value={(d as NodeDataByKind['text']).text} onChange={(text) => update({ text })} rows={3} />
          <label className="flex items-center gap-2 text-[11px] text-ink-2">
            Size
            <input type="range" aria-label="Text size" min={12} max={72} value={(d as NodeDataByKind['text']).fontSize}
              onChange={(e) => update({ fontSize: Number(e.target.value) })} className="min-w-0 flex-1 accent-[var(--color-accent)]" />
            <span className="w-8 text-right tabular-nums">{(d as NodeDataByKind['text']).fontSize}</span>
          </label>
          <div className="flex items-center gap-3">
            <input type="color" aria-label="Text color" value={String(d.color)} onChange={(e) => update({ color: e.target.value })} className="size-8 cursor-pointer" />
            <Toggle label="Comment" checked={!!(d as NodeDataByKind['text']).comment} onChange={(comment) => update({ comment })} />
          </div>
        </Section>}
        {node.type === 'drawing' && <Section title="">
          <input type="color" aria-label="Drawing color" value={String(d.color)} onChange={(e) => update({ color: e.target.value })} className="size-8 cursor-pointer" />
          <NumberInput label="Width" value={(d as NodeDataByKind['drawing']).strokeWidth} min={1} max={12} onChange={(strokeWidth) => update({ strokeWidth })} />
        </Section>}
        {node.type === 'prompt' && <PromptFields nodeId={node.id} data={d as PromptData} update={update} />}
        {node.type === 'image' && <ImageFields nodeId={node.id} data={d as ImageData} update={update} />}
        {node.type === 'output' && <OutputFields node={node} />}
        {node.type === 'palette' && <PaletteFields nodeId={node.id} data={d as PaletteData} update={update} />}
        {node.type === 'collection' && <CollectionFields nodeId={node.id} data={d as CollectionData} update={update} />}
        {node.type === 'extract' && <ExtractFields nodeId={node.id} data={d as ExtractData} update={update} />}
        {node.type === 'generate' && <GenerateFields id={node.id} data={d as GenerateData} update={update} />}
      </fieldset>
      <div className="flex gap-2 px-4 py-4">
        <IconAction icon="duplicate" label="Duplicate" onClick={duplicateSelected} disabled={frozen} />
        <IconAction icon="delete" label="Delete" onClick={deleteSelected} disabled={d.locked || frozen} danger />
      </div>
    </div>
  );
}

/** Shown while a batch runs on this Generate node: settings are read-only until it ends. */
function FrozenBanner() {
  return (
    <div role="status" className="border-b-2 border-accent bg-accent-soft px-4 py-2 text-[12px] text-ink">
      Generating.
    </div>
  );
}

/** Node title shown as text; click (or Enter/F2 when focused) to rename. One rename = one undo step. */
function EditableTitle({ value, onCommit, disabled }: { value: string; onCommit: (v: string) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const finish = (save: boolean) => {
    const next = draft?.trim();
    if (save && next && next !== value) onCommit(next);
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <input
        autoFocus
        aria-label="Node title"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') {
            e.stopPropagation();
            finish(false);
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        className="-mx-1 w-full rounded-md border border-focus bg-panel-2 px-1 py-0.5 text-[14px] font-semibold text-ink outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setDraft(value)}
      disabled={disabled}
      title={disabled ? 'Frozen while generating' : 'Click to rename'}
      className="-mx-1 block w-full truncate rounded-md px-1 py-0.5 text-left text-[14px] font-semibold text-ink hover:bg-panel-2"
    >
      {value || 'Untitled'}
    </button>
  );
}

function IconToggle({
  on,
  onChange,
  label,
  icon,
  disabled,
}: {
  disabled?: boolean;
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`mt-0.5 rounded-md border p-1 disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? 'border-outline bg-accent-soft text-ink' : 'border-transparent text-ink-3 hover:bg-panel-2 hover:text-ink'
      }`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {icon}
      </svg>
    </button>
  );
}
