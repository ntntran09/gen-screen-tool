import { useNodeConnections, type NodeProps, type NodeTypes } from '@xyflow/react';
import type {
  CanvasNode,
  CollectionData,
  GenerateData,
  ImageData,
  OriginalData,
  OutputData,
  PaletteData,
  PromptData,
  ThemeData,
} from '../graph/types';
import { AssetCaption, AssetThumb, MiniThumb } from '../components/AssetThumb';
import { MunLoader } from '../components/MunLoader';
import { useImageImport } from '../hooks/useImageImport';
import { pickImageFiles } from '../lib/filePicker';
import { useAssetStore } from '../store/assetStore';
import { useGraphStore } from '../store/graphStore';
import { NodeShell } from './NodeShell';

type P = NodeProps<CanvasNode>;

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] leading-relaxed text-ink-3">{children}</p>;
}

/** Thumbnail + caption for nodes that hold one image; empty nodes offer a file chooser. */
function NodeImage({ nodeId, assetId, emptyLabel = 'Drop, paste or choose an image' }: { nodeId: string; assetId: string | null; emptyLabel?: string }) {
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
  return (
    <NodeShell node={props} badge={!data.enabled && <span className="text-[10px] text-ink-3">Off</span>}>
      {/* nodrag/nowheel: typing, selecting text and scrolling stay inside the field instead of moving the canvas. */}
      <textarea
        aria-label="Main prompt"
        value={data.text}
        readOnly={data.locked}
        placeholder="Describe what to create or change…"
        rows={4}
        onChange={(e) => updateNodeData(props.id, { text: e.target.value })}
        className="nodrag nowheel block max-h-60 min-h-20 w-full resize-y rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[12px] leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:border-focus"
      />
      {data.constraints && <p className="mt-1.5 line-clamp-2 text-[11px] text-ink-3">+ constraints</p>}
    </NodeShell>
  );
}

function ImageLikeNode(props: P) {
  const data = props.data as ImageData;
  return (
    <NodeShell node={props} width={200}>
      <NodeImage nodeId={props.id} assetId={data.assetId} />
    </NodeShell>
  );
}

function OriginalNode(props: P) {
  const data = props.data as OriginalData;
  const kept = Object.entries(data.preserve)
    .filter(([, on]) => on)
    .map(([k]) => k);
  return (
    <NodeShell node={props} width={200}>
      <NodeImage nodeId={props.id} assetId={data.assetId} />
      {kept.length > 0 && <p className="mt-2 text-[11px] text-ink-3">Preserve: {kept.join(', ')}</p>}
    </NodeShell>
  );
}

function ThemeNode(props: P) {
  const data = props.data as ThemeData;
  return (
    <NodeShell node={props} width={200}>
      <NodeImage nodeId={props.id} assetId={data.assetId} />
      <p className="mt-1 text-[11px] text-ink-3">{data.roles.join(', ') || 'No role'}</p>
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

function CollectionNode(props: P) {
  const data = props.data as CollectionData;
  const items = data.items ?? [];
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
      hiddenInputs={data.role === 'input' ? ['in'] : []}
      badge={<span className="text-[10px] uppercase tracking-wide text-ink-3">{data.role}</span>}
    >
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line-strong bg-panel px-2 py-4 text-center text-[11px] text-ink-3">
          {data.role === 'input' ? (
            <>
              <span>Drop several images here</span>
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

function GenerateNode(props: P) {
  const data = props.data as GenerateData;
  const originals = useNodeConnections({ handleType: 'target', handleId: 'original' });
  const prompts = useNodeConnections({ handleType: 'target', handleId: 'prompt' });
  const generating = useGraphStore((s) => Boolean(s.generatingNodeIds[props.id]));
  const summary =
    data.mode === 'manual'
      ? `Manual · ${data.outputCount} output${data.outputCount === 1 ? '' : 's'}`
      : `Match inputs · ×${data.variantsPerInput} per original`;
  return (
    <NodeShell node={props} width={260}>
      <div className="space-y-1 text-[12px] text-ink-2">
        <p>{summary}</p>
        <p className="text-ink-3">
          {data.aspectRatio} · {data.outputFormat.toUpperCase()} · {data.assetCategory}
        </p>
        {prompts.length === 0 && <p className="text-warning">Needs a prompt</p>}
        {data.mode === 'match' && originals.length === 0 && <p className="text-warning">Needs original images</p>}
      </div>
      {generating && <MunLoader label={null} className="mt-3" />}
      <button
        type="button"
        disabled
        aria-busy={generating}
        className={`nodrag mt-2 w-full cursor-not-allowed rounded-lg border-2 border-outline bg-accent py-1.5 text-[12px] font-semibold text-accent-ink ${
          generating ? '' : 'opacity-40'
        }`}
        title={generating ? undefined : 'Generation arrives with the AI workflow phase'}
      >
        {generating ? 'Generating…' : 'Generate'}
      </button>
    </NodeShell>
  );
}

function OutputNode(props: P) {
  const data = props.data as OutputData;
  return (
    <NodeShell node={props} width={200}>
      {data.assetId ? (
        <NodeImage nodeId={props.id} assetId={data.assetId} />
      ) : (
        <AssetThumb assetId={null} emptyLabel="Waiting for a generation" />
      )}
    </NodeShell>
  );
}

export const nodeTypes: NodeTypes = {
  prompt: PromptNode,
  image: ImageLikeNode,
  original: OriginalNode,
  theme: ThemeNode,
  palette: PaletteNode,
  collection: CollectionNode,
  generate: GenerateNode,
  output: OutputNode,
};
