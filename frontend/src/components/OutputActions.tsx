import { useId, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { makeItems } from '../graph/collections';
import { assetUrls } from '../lib/api';
import type { CollectionData } from '../graph/types';
import { GenerateEditButton, ResultEditPanel } from './InlineGenerationControl';
import { isNodeLocked, useGraphStore } from '../store/graphStore';

const iconButton = 'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40';

function ActionIcon({ children }: { children: ReactNode }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

export function OutputActions({ nodeId, assetId, batchId, taskId, showGenerate = true }: {
  nodeId: string; assetId: string; batchId?: string | null; taskId?: string | null; showGenerate?: boolean;
}) {
  const [target, setTarget] = useState('');
  const [choosing, setChoosing] = useState(false);
  const pickerId = useId();
  const collections = useGraphStore(useShallow((s) => s.nodes.filter((n) =>
    n.type === 'collection' && n.id !== nodeId && !isNodeLocked(n))));
  const locked = useGraphStore((s) => {
    const node = s.nodes.find((n) => n.id === nodeId);
    return !node || isNodeLocked(node);
  });
  const add = () => {
    const g = useGraphStore.getState();
    const source = g.nodes.find((n) => n.id === nodeId);
    if (!source || isNodeLocked(source)) return;
    if (!target) {
      g.addNode('collection', { x: source.position.x + 300, y: source.position.y + 300 }, {
        title: 'Selected results', role: 'input', items: makeItems([assetId]),
      });
    } else {
      const collection = g.nodes.find((n) => n.id === target && n.type === 'collection');
      if (!collection || isNodeLocked(collection)) return;
      g.setCollectionItems(target, [...(collection.data as CollectionData).items, ...makeItems([assetId])]);
    }
    g.showToast('Image added to collection.');
    setChoosing(false);
  };
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Image actions" className="flex items-center gap-1">
        <a className={iconButton} href={assetUrls.download(assetId)} title="Download image" aria-label="Download image">
          <ActionIcon><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" /></ActionIcon>
        </a>
        {showGenerate && <GenerateEditButton nodeId={nodeId} assetId={assetId} />}
        <GenerateEditButton nodeId={nodeId} assetId={assetId} mode="variation" batchId={batchId} taskId={taskId} />
        <button type="button" className={iconButton} disabled={locked} title="Add to collection" aria-label="Add to collection"
          aria-expanded={choosing} aria-controls={pickerId} onClick={() => setChoosing(!choosing)}>
          <ActionIcon><path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 4-2M3 17l9 4M19 15v6m-3-3h6" /></ActionIcon>
        </button>
      </div>
      {showGenerate && <ResultEditPanel nodeId={nodeId} assetId={assetId} batchId={batchId} taskId={taskId} />}
      {choosing && <div id={pickerId} className="flex items-center gap-1">
        <select autoFocus disabled={locked} aria-label="Destination collection" value={target} onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setChoosing(false); } }}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[12px]">
          <option value="">New input collection</option>
          {collections.map((n) => <option key={n.id} value={n.id}>{n.data.title}</option>)}
        </select>
        <button type="button" className={iconButton} disabled={locked} onClick={add} title="Add image" aria-label="Add image">
          <ActionIcon><path d="M12 5v14M5 12h14" /></ActionIcon>
        </button>
      </div>}
    </div>
  );
}
