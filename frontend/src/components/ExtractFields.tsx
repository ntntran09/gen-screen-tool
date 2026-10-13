import { useState } from 'react';
import { currentDetections, sourceAssetFor } from '../graph/detect';
import type { ExtractData } from '../graph/types';
import { assetUrls } from '../lib/api';
import { useAssetStore } from '../store/assetStore';
import { useExtractStore } from '../store/extractStore';
import { useGraphStore } from '../store/graphStore';
import { Button, Section, TextInput } from './fields';
import { CropEditor } from './CropEditor';

/** Inspector for an Extract Assets node: find the assets, review them, then crop them and build background removal. */
export function ExtractFields({ nodeId, data, update }: { nodeId: string; data: ExtractData; update: (p: Partial<ExtractData>) => void }) {
  const assetId = useGraphStore((s) => sourceAssetFor(s.nodes, s.edges, nodeId));
  const busy = useExtractStore((s) => s.busy[nodeId]);
  const error = useExtractStore((s) => s.error[nodeId]);
  const imageName = useAssetStore((s) => (assetId ? s.assets[assetId]?.name : undefined));
  const { detect } = useExtractStore.getState();
  const found = currentDetections(data, assetId);
  const [editing, setEditing] = useState<{ index: number; found: NonNullable<ExtractData['detections']> } | null>(null);
  const items = found?.items ?? [];
  const off = new Set(data.off);
  const chosen = items.filter((_, i) => !off.has(i)).length;
  const stale = Boolean(data.detections) && !found;

  const toggle = (i: number) => {
    const next = new Set(off);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    update({ off: [...next] });
  };
  const rename = (i: number, name: string) =>
    found && update({ detections: { ...found, items: found.items.map((it, k) => (k === i ? { ...it, name } : it)) } });

  return (
    <>
      <Section
        title="Find assets"
        note="A small ChatGPT model finds the separate visual assets in your image, including objects, characters and UI elements. Thinking is kept light. It uses a little of your ChatGPT usage."
      >
        {assetId ? (
          <p className="text-[12px] text-ink-2">
            Image: <span className="font-medium text-ink">{imageName ?? 'connected image'}</span>
          </p>
        ) : (
          <p className="text-[12px] text-warning">Image required.</p>
        )}
        <TextInput
          label="Model"
          value={data.model ?? ''}
          onChange={(model) => update({ model: model.trim() })}
          placeholder="Default (gpt-6-luna, then gpt-5.6-luna)"
          list="extract-models"
        />
        <datalist id="extract-models">
          <option value="gpt-6-luna" />
          <option value="gpt-5.6-luna" />
        </datalist>
        <TextInput label="Find" value={data.hint} onChange={(hint) => update({ hint })} placeholder="e.g. flowers and pots only; no HUD" />
        <Button variant="primary" disabled={!assetId || busy !== undefined} onClick={() => void detect(nodeId)}>
          {busy === 'detect' ? 'Looking…' : found ? 'Find again' : 'Find assets'}
        </Button>
        {stale && <p className="text-[12px] text-warning">Image changed. Search again.</p>}
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </Section>

      {found && items.length > 0 && (
        <Section title="Asset sheet">
          <Button variant="primary" disabled={chosen === 0 || busy !== undefined} onClick={() => void useExtractStore.getState().build(nodeId)}>
            {busy === 'crop' ? 'Cutting assets…' : `Build asset sheet (${chosen})`}
          </Button>
        </Section>
      )}
      {found && items.length > 0 && (
        <Section title="Found">
          <p className="text-[12px] text-ink-2">
            <span className="font-semibold text-ink">{items.length}</span> asset{items.length === 1 ? '' : 's'}
            <span className="text-ink-3">
              {' '}
              · {found.model ?? 'model'} · {found.seconds}s
            </span>
          </p>
          <div className="checkerboard relative overflow-hidden rounded-lg border-2 border-outline">
            <img src={assetUrls.thumbnail(found.assetId)} alt="" className="block w-full" draggable={false} />
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                title={`${i + 1}. ${it.name}${off.has(i) ? ' (not selected)' : ''}`}
                onClick={() => toggle(i)}
                className={`absolute border-2 text-left ${off.has(i) ? 'border-dashed border-ink-3/60 opacity-60' : 'border-accent bg-accent/10'}`}
                style={{ left: `${it.x * 100}%`, top: `${it.y * 100}%`, width: `${it.w * 100}%`, height: `${it.h * 100}%` }}
              >
                <span className="absolute -left-0.5 -top-0.5 rounded-br bg-accent px-1 text-[9px] font-bold leading-tight text-accent-ink">
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
          <ul className="space-y-1">
            {items.map((it, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  aria-label={`Select ${it.name}`}
                  checked={!off.has(i)}
                  onChange={() => toggle(i)}
                  className="accent-[var(--color-accent)]"
                />
                <span className="w-5 shrink-0 text-right font-mono text-[10px] text-ink-3">{i + 1}</span>
                <input
                  aria-label={`Name of asset ${i + 1}`}
                  value={it.name}
                  title={it.description}
                  onChange={(e) => rename(i, e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-1.5 py-1 text-[12px] outline-none focus:border-focus"
                />
                <button type="button" disabled={busy !== undefined} onClick={() => setEditing({ index: i, found })}
                  aria-label={`Adjust crop of ${it.name}`} className="rounded-md border border-line px-1.5 py-1 text-[11px] hover:bg-accent-soft disabled:opacity-40">Crop</button>
              </li>
            ))}
          </ul>

        </Section>
      )}
      {editing && found === editing.found && found.items[editing.index] && busy === undefined && !data.locked && (
        <CropEditor assetId={found.assetId} item={found.items[editing.index]} onClose={() => setEditing(null)}
          onSave={(box) => {
            update({ detections: { ...found, items: found.items.map((it, i) => i === editing.index ? { ...it, ...box } : it) } });
            setEditing(null);
          }} />
      )}

    </>
  );
}
