import { currentDetections, sourceAssetFor } from '../graph/detect';
import { extractedCollection } from '../graph/generation';
import type { ExtractData } from '../graph/types';
import { assetUrls } from '../lib/api';
import { useAssetStore } from '../store/assetStore';
import { useExtractStore } from '../store/extractStore';
import { useGraphStore } from '../store/graphStore';
import { Button, Section, TextInput } from './fields';

/** Inspector for an Extract Assets node: find the assets, review them, then build the redraw nodes. */
export function ExtractFields({ nodeId, data, update }: { nodeId: string; data: ExtractData; update: (p: Partial<ExtractData>) => void }) {
  const assetId = useGraphStore((s) => sourceAssetFor(s.nodes, s.edges, nodeId));
  const busy = useExtractStore((s) => s.busy[nodeId]);
  const error = useExtractStore((s) => s.error[nodeId]);
  const imageName = useAssetStore((s) => (assetId ? s.assets[assetId]?.name : undefined));
  const collection = useGraphStore((s) => extractedCollection(s.nodes, s.edges, nodeId));
  const { detect } = useExtractStore.getState();
  const found = currentDetections(data, assetId);
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

  const redraw = () => {
    const g = useGraphStore.getState();
    const r = g.addExtractionWorkflow(nodeId);
    if (!r) return;
    g.showToast(
      r.generate
        ? `Built the redraw nodes for ${r.count} asset${r.count === 1 ? '' : 's'}. Press Generate to start.`
        : `Updated the list to ${r.count} asset${r.count === 1 ? '' : 's'}.`,
    );
  };

  return (
    <>
      <Section
        title="Find assets with AI"
        note="A small ChatGPT model (gpt-6-luna) counts and names the separate assets in the connected image and marks where they are. It uses a little of your ChatGPT usage."
      >
        {assetId ? (
          <p className="text-[12px] text-ink-2">
            Image: <span className="font-medium text-ink">{imageName ?? 'connected image'}</span>
          </p>
        ) : (
          <p className="text-[12px] text-warning">Connect an Image node (with a picture) to this node's Image port.</p>
        )}
        <TextInput label="Hint (optional)" value={data.hint} onChange={(hint) => update({ hint })} placeholder="e.g. only the flower pots and the buttons" />
        <Button variant="primary" disabled={!assetId || busy !== undefined} onClick={() => void detect(nodeId)}>
          {busy === 'detect' ? 'Looking…' : found ? 'Find again' : 'Find assets'}
        </Button>
        {stale && <p className="text-[12px] text-warning">The image changed since the last search. Find assets again.</p>}
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </Section>

      {found && items.length > 0 && (
        <Section
          title="Redraw"
          note="Builds a list of the original image once per ticked asset (each says which asset to take and where it is), plus a Prompt and a Generate that redraw each one as a clean standalone asset on a transparent background."
        >
          <Button variant="primary" disabled={chosen === 0} onClick={redraw}>
            {collection ? `Update redraw list (${chosen})` : `Redraw nodes (${chosen})`}
          </Button>
          {collection && (
            <Button onClick={() => useAssetStore.getState().openViewer(collection.id)}>Open the list</Button>
          )}
          <p className="text-[11px] text-ink-3">Nothing is generated until you press Generate on the new node.</p>
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
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-ink-3">
            The boxes are the model's best guess and only show where each asset is. Untick any that look wrong and fix the names;
            the names are used in the prompt and for the result files.
          </p>
        </Section>
      )}

    </>
  );
}
