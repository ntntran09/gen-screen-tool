import { useNodeConnections, type NodeProps, type NodeTypes } from '@xyflow/react';
import type {
  CanvasNode,
  CollectionData,
  ExtractData,
  GenerateData,
  ImageData,
  OutputData,
  PaletteData,
  PromptData,
} from '../graph/types';
import { aspectLabel, PRESETS } from '../graph/types';
import { AssetCaption, AssetThumb, MiniThumb } from '../components/AssetThumb';
import { FailureReasons } from '../components/FailureReasons';
import { MunLoader } from '../components/MunLoader';
import { OutputPlaceholder } from '../components/OutputPlaceholder';
import { estimateTasks } from '../graph/generation';
import { useImageImport } from '../hooks/useImageImport';
import { formatDuration, useBatchTime } from '../hooks/useBatchTime';
import { useEditableText } from '../hooks/useEditableText';
import { useImageRoles } from '../hooks/useImageRoles';
import { pickImageFiles } from '../lib/filePicker';
import { useAssetStore } from '../store/assetStore';
import { currentDetections, sourceAssetFor } from '../graph/detect';
import { useExtractStore } from '../store/extractStore';
import { isRunning, latestBatchFor, OPEN_STATUSES, useGenerationStore } from '../store/generationStore';
import { useGraphStore } from '../store/graphStore';
import { NodeShell } from './NodeShell';
import { TextNode, DrawingNode } from './AnnotationNodes';

type P = NodeProps<CanvasNode>;

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] leading-relaxed text-ink-3">{children}</p>;
}

/** Thumbnail + caption for nodes that hold one image; empty nodes offer a file chooser. */
function NodeImage({ nodeId, assetId, emptyLabel = 'No image' }: { nodeId: string; assetId: string | null; emptyLabel?: string }) {
  const importImages = useImageImport();
  const choose = async () => {
    const files = await pickImageFiles(false);
    if (files.length) await importImages(files, { replaceNodeId: nodeId });
  };
  return (
    <>
      <AssetThumb assetId={assetId} emptyLabel={emptyLabel} onChoose={() => void choose()} />
      <AssetCaption assetId={assetId} />
    </>
  );
}

function PromptNode(props: P) {
  const data = props.data as PromptData;
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const [text, setText] = useEditableText(data.text, (value) => updateNodeData(props.id, { text: value }));
  return (
    <NodeShell
      node={props}
      badge={<span className="text-[10px] uppercase tracking-wide text-ink-3">{data.enabled ? 'On' : 'Off'}</span>}
    >
      {/* nodrag/nowheel: typing, selecting text and scrolling stay inside the field instead of moving the canvas. */}
      <textarea
        aria-label="Main prompt"
        value={text}
        readOnly={data.locked}
        placeholder="Describe what to create or change…"
        rows={4}
        onChange={(e) => setText(e.target.value)}
        className="nodrag nowheel block max-h-60 min-h-20 w-full resize-y rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[12px] leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:border-focus"
      />
    </NodeShell>
  );
}

function ImageNode(props: P) {
  const data = props.data as ImageData;
  const roles = useImageRoles(props.id);
  return (
    <NodeShell
      node={props}
      width={200}
      badge={roles.length > 0 && <span className="text-[10px] uppercase tracking-wide text-ink-3">{roles.join(' · ')}</span>}
    >
      <NodeImage nodeId={props.id} assetId={data.assetId} />
      {roles.includes('Theme') && <p className="mt-1 text-[11px] text-ink-3">Theme: {data.roles.join(', ') || 'no role'}</p>}
    </NodeShell>
  );
}

function PaletteNode(props: P) {
  const data = props.data as PaletteData;
  return (
    <NodeShell node={props} width={220}>
      {data.colors.length === 0 ? (
        <Muted>No colors.</Muted>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {data.colors.map((c) => (
            <div key={c.id} className="flex flex-col items-center gap-0.5">
              <span className="size-7 rounded-md border border-line-strong" style={{ background: c.hex }} />
              <span className="font-mono text-[9px] text-ink-3">{c.hex.replace('#', '')}</span>
            </div>
          ))}
        </div>
      )}
    </NodeShell>
  );
}

const PREVIEW_SLOTS = 8;
const nodeBtn =
  'nodrag rounded-md border-2 border-outline bg-node px-2 py-0.5 text-[11px] font-medium text-ink hover:bg-accent-soft';

/** Run controls of the Extract flow folded into a collection's generate button: progress, cancel and Generate. */
function FoldedRun({ generateId, locked }: { generateId: string; locked: boolean }) {
  const batch = useGenerationStore((s) => latestBatchFor(s.batches, generateId));
  const starting = useGenerationStore((s) => Boolean(s.starting[generateId]));
  const expected = useGraphStore((s) => estimateTasks(s.nodes, s.edges, generateId));
  const time = useBatchTime(batch?.id);
  const running = starting || isRunning(batch);
  const open = Boolean(batch && OPEN_STATUSES.includes(batch.status));
  const done = batch ? batch.completed_count + batch.failed_count + batch.cancelled_count : 0;
  return (
    <div className="mt-2 space-y-1.5 text-[11px]">
      {batch && (open || batch.failed_count > 0) && (
        <>
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full border border-outline bg-panel-2" aria-hidden>
              <div className="h-full bg-success" style={{ width: `${(100 * done) / Math.max(1, batch.expected_count)}%` }} />
            </div>
            {open && (
              <button type="button" aria-label="Cancel generation" disabled={batch.cancel_requested}
                title="Cancel: stops the images not sent yet. A request already sent cannot be stopped; its image is kept if it arrives."
                className="nodrag flex size-4 shrink-0 items-center justify-center rounded-full border border-outline bg-node text-ink-2 hover:bg-danger-soft hover:text-danger disabled:cursor-wait disabled:opacity-40"
                onClick={() => void useGenerationStore.getState().cancel(batch.id)}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden="true">
                  <path d="m5 5 14 14M19 5 5 19" />
                </svg>
              </button>
            )}
          </div>
          <p className="text-ink-2">
            {batch.completed_count}/{batch.expected_count} done
            {batch.failed_count > 0 && <span className="text-danger"> · {batch.failed_count} failed</span>}
            {time && <span className="font-mono tabular-nums">{' · '}{time.live ? '⏱ ' : 'took '}{formatDuration(time.ms)}</span>}
          </p>
          <FailureReasons batchId={batch.id} />
        </>
      )}
      <button
        type="button"
        disabled={running || locked || expected === 0}
        onClick={() => void useGenerationStore.getState().start(generateId)}
        className="nodrag w-full rounded-lg border-2 border-outline bg-accent py-1.5 text-[12px] font-semibold text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? 'Generating…' : `Generate ${expected}`}
      </button>
    </div>
  );
}

function CollectionNode(props: P) {
  const data = props.data as CollectionData;
  const folded = data.foldedIds ?? [];
  const foldedGenerateId = useGraphStore((s) => (folded.length ? s.nodes.find((n) => n.type === 'generate' && folded.includes(n.id))?.id : undefined));
  const items = data.items ?? [];
  const lastBatchId = data.role === 'output' ? data.batchIds?.at(-1) : undefined;
  const batch = useGenerationStore((s) => (lastBatchId ? s.batches[lastBatchId] : undefined));
  const outTime = useBatchTime(lastBatchId);
  const importImages = useImageImport();
  const enabled = items.filter((i) => i.enabled).length;
  const shown = items.slice(0, PREVIEW_SLOTS);
  const extra = items.length - shown.length;
  const open = () => useAssetStore.getState().openViewer(props.id);
  const choose = async () => {
    const files = await pickImageFiles(true);
    if (files.length) await importImages(files, { collectionNodeId: props.id });
  };
  return (
    <NodeShell
      node={props}
      width={260}
      hiddenInputs={data.role === 'input' ? ['in'] : ['extract']}
      outputSymbol={Boolean(foldedGenerateId)}
      badge={<span className="text-[10px] uppercase tracking-wide text-ink-3">{data.role}</span>}
    >
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line-strong bg-panel px-2 py-4 text-center text-[11px] text-ink-3">
          {data.role === 'input' ? (
            <>
              <span>Empty collection</span>
              {!data.locked && (
                <button
                  type="button"
                  className="nodrag rounded-md border-2 border-outline bg-node px-2 py-1 text-[11px] font-medium text-ink hover:bg-accent-soft"
                  onClick={() => void choose()}
                >
                  Choose images
                </button>
              )}
            </>
          ) : (
            <span>Generated results will collect here</span>
          )}
        </div>
      ) : (
        <button type="button" className="nodrag block w-full text-left" onClick={open} title="Open the Collection Viewer">
          <div className="grid grid-cols-4 gap-1">
            {shown.map((item, i) => (
              <span
                key={item.id}
                className={`checkerboard relative block aspect-square overflow-hidden rounded border border-outline ${
                  item.enabled ? '' : 'opacity-35'
                }`}
              >
                <MiniThumb assetId={item.assetId} />
                {extra > 0 && i === shown.length - 1 && (
                  <span className="absolute inset-0 flex items-center justify-center bg-overlay text-[11px] font-semibold text-white">
                    +{extra + 1}
                  </span>
                )}
              </span>
            ))}
          </div>
        </button>
      )}
      {batch && (
        <p className="mt-2 text-[11px] text-ink-2">
          Latest run: {batch.completed_count}/{batch.expected_count} done
          {batch.failed_count > 0 && <span className="text-danger"> · {batch.failed_count} failed</span>}
          {isRunning(batch) && <span> · running</span>}
          {outTime && <span className="font-mono tabular-nums"> · {formatDuration(outTime.ms)}</span>}
        </p>
      )}
      {batch && batch.failed_count > 0 && <div className="mt-1"><FailureReasons batchId={batch.id} /></div>}
      {foldedGenerateId && <FoldedRun generateId={foldedGenerateId} locked={Boolean(data.locked)} />}
      <div className="mt-2 flex items-center gap-2 text-[12px]">
        <span className="text-ink-2">
          {items.length} {items.length === 1 ? 'image' : 'images'}
          {enabled !== items.length && <span className="text-ink-3"> · {items.length - enabled} off</span>}
        </span>
        {items.length > 0 && (
          <button
            type="button"
            className="nodrag ml-auto rounded-md border-2 border-outline bg-node px-2 py-0.5 text-[11px] font-medium text-ink hover:bg-accent-soft"
            onClick={open}
          >
            Open
          </button>
        )}
      </div>
    </NodeShell>
  );
}

function ExtractNode(props: P) {
  const data = props.data as ExtractData;
  const assetId = useGraphStore((s) => sourceAssetFor(s.nodes, s.edges, props.id));
  const busy = useExtractStore((s) => s.busy[props.id]);
  const error = useExtractStore((s) => s.error[props.id]);
  const { detect } = useExtractStore.getState();
  const found = currentDetections(data, assetId);
  const chosen = found ? found.items.filter((_, i) => !data.off.includes(i)).length : 0;
  // One main action: find the assets first, then build the asset sheet from the ticked ones.
  // Finding again is in the inspector.
  const hasFound = Boolean(found && found.items.length > 0);
  return (
    <NodeShell node={props} width={260}>
      <div className="space-y-1.5 text-[12px] text-ink-2">
        {!assetId && <p className="text-warning">Connect an Image with a picture</p>}
        {assetId && !found && <p>{data.detections ? 'Image changed: find again' : 'Ready to find assets'}</p>}
        {found && (
          <p>
            Found <span className="font-semibold text-ink">{found.items.length}</span> ·{' '}
            <span className="font-semibold text-ink">{chosen}</span> ticked
          </p>
        )}

        {error && <p className="text-danger">{error}</p>}
      </div>
      {assetId && (
        <button
          type="button"
          disabled={busy !== undefined || data.locked || (hasFound && chosen === 0)}
          aria-busy={busy !== undefined}
          onClick={() => void (hasFound ? useExtractStore.getState().build(props.id) : detect(props.id))}
          className="nodrag mt-2 w-full rounded-lg border-2 border-outline bg-accent py-1.5 text-[12px] font-semibold text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'detect' ? 'Looking…' : busy === 'crop' ? 'Cutting assets…' : hasFound ? `Build asset sheet (${chosen})` : 'Find assets'}
        </button>
      )}
    </NodeShell>
  );
}

function GenerateNode(props: P) {
  const data = props.data as GenerateData;
  const originals = useNodeConnections({ handleType: 'target', handleId: 'original' });
  const prompts = useNodeConnections({ handleType: 'target', handleId: 'prompt' });
  const expected = useGraphStore((s) => estimateTasks(s.nodes, s.edges, props.id));
  const batch = useGenerationStore((s) => latestBatchFor(s.batches, props.id));
  const starting = useGenerationStore((s) => Boolean(s.starting[props.id]));
  const running = isRunning(batch);
  const time = useBatchTime(batch?.id);
  const open = batch && OPEN_STATUSES.includes(batch.status);
  const { start, resume, retry, cancel } = useGenerationStore.getState();

  const problems = [
    prompts.length === 0 && 'Needs a prompt',
    originals.length === 0 && 'Needs an original image',
    data.mode === 'match' && originals.length > 0 && expected === 0 && 'No enabled originals',
  ].filter(Boolean) as string[];
  const summary =
    data.mode === 'manual'
      ? `Manual · ${data.outputCount} output${data.outputCount === 1 ? '' : 's'}`
      : `Match inputs · ×${data.variantsPerInput} per original`;
  const done = batch ? batch.completed_count + batch.failed_count + batch.cancelled_count : 0;

  return (
    <NodeShell node={props} width={260}>
      <div className="space-y-1 text-[12px] text-ink-2">
        <p>{data.editResult ? 'Edit result' : PRESETS.find((p) => p.id === data.preset)?.label}</p>
        <p>{summary}</p>
        <p className="text-ink-3">
          {aspectLabel(data.aspectRatio)} · quality {data.quality}
        </p>
        {problems.map((p) => (
          <p key={p} className="text-warning">
            {p}
          </p>
        ))}
      </div>
      {running && <MunLoader label={null} className="mt-3" />}
      {batch && (open || batch.failed_count > 0) && (
        <div className="mt-2 space-y-1.5 text-[11px]">
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full border border-outline bg-panel-2" aria-hidden>
              <div className="h-full bg-success" style={{ width: `${(100 * done) / Math.max(1, batch.expected_count)}%` }} />
            </div>
            {open && (
              <button type="button" aria-label="Cancel generation" disabled={batch.cancel_requested}
                title={batch.cancel_requested
                  ? 'Cancelling…'
                  : 'Cancel: stops the images not sent yet. A request already sent cannot be stopped; its image is kept if it arrives.'}
                className="nodrag flex size-4 shrink-0 items-center justify-center rounded-full border border-outline bg-node text-ink-2 hover:bg-danger-soft hover:text-danger focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-40"
                onClick={() => void cancel(batch.id)}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden="true">
                  <path d="m5 5 14 14M19 5 5 19" />
                </svg>
              </button>
            )}
          </div>
          <p className="text-ink-2">
            {batch.completed_count}/{batch.expected_count} done
            {batch.failed_count > 0 && <span className="text-danger"> · {batch.failed_count} failed</span>}
            {batch.cancelled_count > 0 && <span> · {batch.cancelled_count} cancelled</span>}
            {time && (
              <span className="font-mono tabular-nums" title="Time spent generating (waiting and pauses not counted)">
                {' · '}
                {time.live ? '⏱ ' : 'took '}
                {formatDuration(time.ms)}
              </span>
            )}
          </p>
          {!running && <FailureReasons batchId={batch.id} />}
          {batch.status_reason && !running && <p className="text-warning">{batch.status_reason}</p>}
          <div className="flex gap-1.5">
            {(batch.status === 'paused' || batch.status === 'interrupted') && batch.active_count > 0 && (
              <button type="button" className={nodeBtn} onClick={() => void resume(batch.id)}>
                Resume
              </button>
            )}
            {!running && batch.failed_count > 0 && (
              <button type="button" className={nodeBtn} onClick={() => void retry(batch.id)}>
                Retry failed
              </button>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        disabled={running || starting || problems.length > 0 || data.locked}
        aria-busy={running || starting}
        onClick={() => void start(props.id)}
        className="nodrag mt-2 w-full rounded-lg border-2 border-outline bg-accent py-1.5 text-[12px] font-semibold text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        title={problems[0]}
      >
        {running ? 'Generating…' : starting ? 'Starting…' : expected > 1 ? `Generate ${expected}` : 'Generate'}
      </button>
    </NodeShell>
  );
}

function OutputNode(props: P) {
  const data = props.data as OutputData;
  return (
    <NodeShell node={props} width={200} hiddenInputs={data.sourceNodeId ? ['in'] : ['edit']}
      outputSymbol={!!data.inlineGeneration}>
      {data.assetId ? (
        <NodeImage nodeId={props.id} assetId={data.assetId} />
      ) : (
        <OutputPlaceholder data={data} />
      )}
    </NodeShell>
  );
}

export const nodeTypes: NodeTypes = {
  text: TextNode,
  drawing: DrawingNode,
  prompt: PromptNode,
  image: ImageNode,
  palette: PaletteNode,
  collection: CollectionNode,
  extract: ExtractNode,
  generate: GenerateNode,
  output: OutputNode,
};
