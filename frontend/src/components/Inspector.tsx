import { nanoid } from 'nanoid';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getDefinition, LIMITS } from '../graph/registry';
import {
  ASPECT_RATIOS,
  ASSET_CATEGORIES,
  COLOR_ROLES,
  PRESERVATION_OPTIONS,
  THEME_ROLES,
  type AnyNodeData,
  type CanvasNode,
  type CollectionData,
  type GenerateData,
  type ImageData,
  type OutputData,
  type OriginalData,
  type PaletteData,
  type PromptData,
  type ThemeData,
} from '../graph/types';
import { nodeAssetId } from '../graph/collections';
import { useImageImport } from '../hooks/useImageImport';
import { assetUrls } from '../lib/api';
import { pickImageFiles } from '../lib/filePicker';
import { useAssetStore } from '../store/assetStore';
import { useGraphStore } from '../store/graphStore';
import { AssetThumb, formatBytes } from './AssetThumb';
import { Button, NumberInput, Section, Select, TextArea, TextInput, Toggle } from './fields';

const PRESERVE_LABELS: Record<(typeof PRESERVATION_OPTIONS)[number], string> = {
  composition: 'Composition',
  shape: 'Shape',
  proportions: 'Proportions',
  silhouette: 'Silhouette',
  mainSubject: 'Main subject',
  objectCount: 'Object count',
};

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

function PromptFields({ data, update }: { data: PromptData; update: Update }) {
  return (
    <Section title="Prompt">
      <TextArea
        label="Main prompt"
        rows={6}
        value={data.text}
        onChange={(text) => update({ text })}
        placeholder="Repaint {asset_name} into a polished 3D casual mobile game asset…"
        hint={
          <>
            Variables: <code>{'{asset_name}'}</code> <code>{'{asset_index}'}</code> <code>{'{collection_name}'}</code>{' '}
            <code>{'{variant_index}'}</code>
          </>
        }
      />
      <TextArea label="Constraints" rows={3} value={data.constraints} onChange={(constraints) => update({ constraints })} />
      <Select
        label="Role"
        value={data.role}
        options={[
          { value: 'main', label: 'Main description' },
          { value: 'style', label: 'Art style' },
          { value: 'constraints', label: 'Constraints' },
          { value: 'output', label: 'Output requirements' },
        ]}
        onChange={(role) => update({ role })}
      />
      <NumberInput label="Order" value={data.order} min={0} max={99} onChange={(order) => update({ order })} />
      <Toggle label="Enabled" checked={data.enabled} onChange={(enabled) => update({ enabled })} />
      <Button onClick={() => void navigator.clipboard.writeText(data.text)} disabled={!data.text}>
        Copy prompt
      </Button>
    </Section>
  );
}

const ROLE_LABEL: Record<'image' | 'original' | 'theme', string> = {
  image: 'Reference',
  original: 'Original',
  theme: 'Theme',
};

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function AssetNameField({ assetId, name }: { assetId: string; name: string }) {
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
      hint="Display name only. The stored file is never renamed or overwritten."
    />
  );
}

/** Preview, file facts and actions for the image a node points at (spec §6.3–6.4). */
function AssetPanel({ nodeId, assetId, canReplace }: { nodeId: string; assetId: string | null; canReplace: boolean }) {
  const asset = useAssetStore((s) => (assetId ? s.assets[assetId] : undefined));
  const importImages = useImageImport();
  const choose = async () => {
    const files = await pickImageFiles(false);
    if (files.length) await importImages(files, { replaceNodeId: nodeId });
  };
  const g = asset ? gcd(asset.width, asset.height) : 1;

  return (
    <div className="space-y-3">
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
          <AssetNameField assetId={asset.id} name={asset.name} />
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
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {canReplace && <Button onClick={() => void choose()}>{assetId ? 'Replace image' : 'Choose image'}</Button>}
        {asset && !asset.missing && (
          <>
            <Button onClick={() => useAssetStore.getState().setPreview(asset.id)}>View full size</Button>
            <a
              href={assetUrls.download(asset.id)}
              className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink-2 hover:bg-panel-2 hover:text-ink"
            >
              Download
            </a>
          </>
        )}
      </div>
      {assetId && canReplace && (
        <p className="text-[11px] text-ink-3">Replacing keeps the old file; this node just points at the new one.</p>
      )}
    </div>
  );
}

function ImageFields({
  nodeId,
  kind,
  data,
  update,
}: {
  nodeId: string;
  kind: 'image' | 'original' | 'theme';
  data: ImageData;
  update: Update;
}) {
  const convertNode = useGraphStore((s) => s.convertNode);
  return (
    <Section title="Image">
      <AssetPanel nodeId={nodeId} assetId={data.assetId} canReplace={!data.locked} />
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-ink-2">Use this image as</p>
        <div className="flex gap-1.5">
          {(Object.keys(ROLE_LABEL) as (keyof typeof ROLE_LABEL)[]).map((role) => (
            <button
              key={role}
              type="button"
              aria-pressed={role === kind}
              disabled={role === kind || data.locked}
              onClick={() => convertNode(nodeId, role)}
              className={`flex-1 rounded-md border px-2 py-1 text-[12px] ${
                role === kind
                  ? 'border-outline bg-accent-soft font-semibold text-ink'
                  : 'border-line text-ink-2 hover:bg-panel-2 disabled:opacity-40'
              }`}
            >
              {ROLE_LABEL[role]}
            </button>
          ))}
        </div>
      </div>
      <TextArea label="Notes" rows={2} value={data.notes} onChange={(notes) => update({ notes })} />
    </Section>
  );
}

function OutputFields({ node }: { node: CanvasNode }) {
  const data = node.data as OutputData;
  const addNode = useGraphStore((s) => s.addNode);
  // Non-destructive: the result stays where it is and a new node references the same file.
  const addAs = (kind: 'original' | 'theme') =>
    addNode(kind, { x: node.position.x + 260, y: node.position.y }, { assetId: data.assetId });
  return (
    <Section
      title="Result"
      note={data.assetId ? undefined : 'Generated results appear here once generation is wired up (Phase 3).'}
    >
      {data.assetId ? (
        <>
          <AssetPanel nodeId={node.id} assetId={data.assetId} canReplace={false} />
          <div className="flex gap-2">
            <Button onClick={() => addAs('original')}>Use as Original</Button>
            <Button onClick={() => addAs('theme')}>Use as Theme</Button>
          </div>
        </>
      ) : null}
    </Section>
  );
}

function OriginalFields({ nodeId, data, update }: { nodeId: string; data: OriginalData; update: Update }) {
  return (
    <>
      <ImageFields nodeId={nodeId} kind="original" data={data} update={update} />
      <Section title="Preservation" note="These become prompt instructions, not pixel-level guarantees.">
        <div className="grid grid-cols-2 gap-2">
          {PRESERVATION_OPTIONS.map((key) => (
            <Toggle
              key={key}
              label={PRESERVE_LABELS[key]}
              checked={data.preserve[key]}
              onChange={(on) => update({ preserve: { ...data.preserve, [key]: on } })}
            />
          ))}
        </div>
        <TextArea label="Extra instructions" rows={2} value={data.instructions} onChange={(instructions) => update({ instructions })} />
      </Section>
    </>
  );
}

function ThemeFields({ nodeId, data, update }: { nodeId: string; data: ThemeData; update: Update }) {
  return (
    <>
      <Section title="Reference roles">
        <div className="grid grid-cols-2 gap-2">
          {THEME_ROLES.map((role) => (
            <Toggle
              key={role}
              label={THEME_LABELS[role]}
              checked={data.roles.includes(role)}
              onChange={(on) =>
                update({ roles: on ? [...data.roles, role] : data.roles.filter((r) => r !== role) })
              }
            />
          ))}
        </div>
      </Section>
      <ImageFields nodeId={nodeId} kind="theme" data={data} update={update} />
    </>
  );
}

function PaletteFields({ data, update }: { data: PaletteData; update: Update }) {
  const setColor = (id: string, patch: Partial<PaletteData['colors'][number]>) =>
    update({ colors: data.colors.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const move = (index: number, delta: number) => {
    const next = [...data.colors];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    update({ colors: next });
  };
  return (
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
        <Button onClick={() => update({ colors: [...data.colors, { id: nanoid(8), hex: '#FFFFFF', role: 'accent', ratio: null }] })}>
          Add color
        </Button>
        <Button onClick={() => void navigator.clipboard.writeText(data.colors.map((c) => c.hex).join(', '))} disabled={data.colors.length === 0}>
          Copy HEX
        </Button>
      </div>
    </Section>
  );
}

function CollectionFields({ nodeId, data, update }: { nodeId: string; data: CollectionData; update: Update }) {
  const importImages = useImageImport();
  const ungroup = useGraphStore((s) => s.ungroupCollection);
  const items = data.items ?? [];
  const enabled = items.filter((i) => i.enabled).length;
  const overrides = items.filter((i) => i.promptOverride.trim()).length;
  const canAdd = !data.locked && data.role === 'input';
  return (
    <Section title="Collection">
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
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => useAssetStore.getState().openViewer(nodeId)}>Open viewer</Button>
        {canAdd && (
          <Button
            onClick={() =>
              void pickImageFiles(true).then((files) => importImages(files, { collectionNodeId: nodeId }))
            }
          >
            Add images
          </Button>
        )}
        {canAdd && items.length > 0 && (
          <Button onClick={() => ungroup(nodeId)}>Ungroup</Button>
        )}
      </div>
      {canAdd && <p className="text-[11px] text-ink-3">Ungroup turns every image into its own Original node.</p>}
    </Section>
  );
}

function GenerateFields({ id, data, update }: { id: string; data: GenerateData; update: Update }) {
  const originalNodes = useGraphStore(
    useShallow((s) =>
      s.edges
        .filter((e) => e.target === id && e.targetHandle === 'original')
        .map((e) => s.nodes.find((n) => n.id === e.source))
        .filter((n): n is CanvasNode => !!n)
        .map((n) => ({ id: n.id, type: n.type, title: n.data.title })),
    ),
  );
  const hasCollection = originalNodes.some((n) => n.type === 'collection');
  const needsPrimary = data.mode === 'manual' && (originalNodes.length > 1 || hasCollection);
  const primaryOptions = originalNodes.filter((n) => n.type === 'original');

  return (
    <>
      <Section title="Mode">
        <Select
          label="Generation mode"
          value={data.mode}
          options={[
            { value: 'manual', label: 'Manual count' },
            { value: 'match', label: 'Match inputs' },
          ]}
          onChange={(mode) => update({ mode })}
        />
        {data.mode === 'manual' ? (
          <NumberInput
            label="Number of outputs"
            value={data.outputCount}
            min={1}
            max={LIMITS.maxOutputCount}
            onChange={(outputCount) => update({ outputCount })}
          />
        ) : (
          <NumberInput
            label="Variants per original"
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
            hint="Several originals are connected. Pick one, or switch to Match inputs."
          />
        )}
      </Section>
      <Section
        title="Output"
        note="The provider's capabilities are not verified yet, so these settings will be sent as prompt instructions."
      >
        <p className="text-[12px] text-ink-2">
          Provider: <span className="text-ink">{data.providerId}</span>{' '}
          <span className="text-ink-3">(selection arrives with Phase 0)</span>
        </p>
        <Select label="Aspect ratio" value={data.aspectRatio} options={ASPECT_RATIOS} onChange={(aspectRatio) => update({ aspectRatio })} />
        <Select
          label="Quality"
          value={data.quality}
          options={['auto', 'low', 'medium', 'high'] as const}
          onChange={(quality) => update({ quality })}
        />
        <Select
          label="Format"
          value={data.outputFormat}
          options={['png', 'webp', 'jpg'] as const}
          onChange={(outputFormat) => update({ outputFormat })}
        />
        <Select
          label="Background"
          value={data.background}
          options={[
            { value: 'white', label: 'White' },
            { value: 'solid', label: 'Solid color' },
            { value: 'transparent', label: 'Transparent (preference)' },
            { value: 'custom', label: 'Custom prompt' },
          ]}
          onChange={(background) => update({ background })}
        />
        {(data.background === 'solid' || data.background === 'custom') && (
          <TextInput
            label={data.background === 'solid' ? 'Background color' : 'Background prompt'}
            value={data.backgroundValue}
            onChange={(backgroundValue) => update({ backgroundValue })}
          />
        )}
      </Section>
      <Section title="Game asset">
        <Select label="Asset type" value={data.assetCategory} options={ASSET_CATEGORIES} onChange={(assetCategory) => update({ assetCategory })} />
        <TextArea label="Art style instructions" rows={2} value={data.artStyle} onChange={(artStyle) => update({ artStyle })} />
        <div className="grid grid-cols-2 gap-2">
          <Toggle label="Preserve subject" checked={data.preserveSubject} onChange={(preserveSubject) => update({ preserveSubject })} />
          <Toggle label="Preserve silhouette" checked={data.preserveSilhouette} onChange={(preserveSilhouette) => update({ preserveSilhouette })} />
          <Toggle label="Consistent framing" checked={data.consistentFraming} onChange={(consistentFraming) => update({ consistentFraming })} />
          <Toggle label="Consistent scale" checked={data.consistentScale} onChange={(consistentScale) => update({ consistentScale })} />
        </div>
      </Section>
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
        {groupable >= 2 && (
          <p className="text-[11px] text-ink-3">
            Grouping puts {groupable} images into one Input Collection (Ctrl+G). Connections to a Generate node's Original
            port move to the collection.
          </p>
        )}
      </div>
    );
  }

  const node = selected[0];
  const def = getDefinition(node.type!);
  const update: Update = (patch) => updateNodeData(node.id, patch);
  const d = node.data;

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="size-2.5 rounded-full" style={{ background: def.color }} aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{def.label}</span>
      </div>
      <Section title="Node">
        <TextInput label="Title" value={d.title} onChange={(title) => update({ title })} />
        <div className="flex gap-4">
          <Toggle label="Collapsed" checked={d.collapsed} onChange={(collapsed) => update({ collapsed })} />
          <Toggle label="Locked" checked={d.locked} onChange={(locked) => update({ locked })} hint="Locked nodes cannot be moved or deleted" />
        </div>
        <div className="flex gap-2">
          <Button onClick={duplicateSelected}>Duplicate</Button>
          <Button variant="danger" onClick={deleteSelected} disabled={d.locked}>
            Delete
          </Button>
        </div>
      </Section>
      {node.type === 'prompt' && <PromptFields data={d as PromptData} update={update} />}
      {node.type === 'image' && <ImageFields nodeId={node.id} kind="image" data={d as ImageData} update={update} />}
      {node.type === 'output' && <OutputFields node={node} />}
      {node.type === 'original' && <OriginalFields nodeId={node.id} data={d as OriginalData} update={update} />}
      {node.type === 'theme' && <ThemeFields nodeId={node.id} data={d as ThemeData} update={update} />}
      {node.type === 'palette' && <PaletteFields data={d as PaletteData} update={update} />}
      {node.type === 'collection' && <CollectionFields nodeId={node.id} data={d as CollectionData} update={update} />}
      {node.type === 'generate' && <GenerateFields id={node.id} data={d as GenerateData} update={update} />}
    </div>
  );
}
