import { useReactFlow } from '@xyflow/react';
import { useState, type DragEvent } from 'react';
import { ADDABLE_KINDS, getDefinition } from '../graph/registry';
import type { NodeKind } from '../graph/types';
import type { ProjectSummary } from '../lib/api';
import { useGraphStore } from '../store/graphStore';
import { findFreeSpot } from '../graph/layout';
import { AssetLibrary } from './AssetLibrary';
import { DRAG_MIME } from './Canvas';

type Tab = 'nodes' | 'library' | 'projects';

const NODE_GROUPS: { id: string; label: string; kinds: NodeKind[] }[] = [
  { id: 'all', label: 'All', kinds: ADDABLE_KINDS },
  { id: 'inputs', label: 'Inputs', kinds: ['prompt', 'palette'] },
  { id: 'images', label: 'Images', kinds: ['image', 'original', 'theme', 'collection'] },
  { id: 'ai', label: 'AI', kinds: ['generate'] },
];


export function Sidebar({
  projects,
  onOpenProject,
  onNewProject,
}: {
  projects: ProjectSummary[];
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
}) {
  const [tab, setTab] = useState<Tab>('nodes');
  const [group, setGroup] = useState('all');
  const addNode = useGraphStore((s) => s.addNode);
  const currentId = useGraphStore((s) => s.projectId);
  const { screenToFlowPosition } = useReactFlow();

  const onDragStart = (e: DragEvent, kind: NodeKind) => {
    e.dataTransfer.setData(DRAG_MIME, kind);
    e.dataTransfer.effectAllowed = 'move';
  };

  // Click-to-add drops the node at the centre of the visible canvas.
  const addAtCenter = (kind: NodeKind) => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    const center = pane
      ? { x: pane.left + pane.width / 2 - 120, y: pane.top + pane.height / 2 - 60 }
      : { x: 400, y: 300 };
    addNode(kind, findFreeSpot(screenToFlowPosition(center), useGraphStore.getState().nodes));
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div role="tablist" className="flex border-b border-line">
        {(
          [
            ['nodes', 'Nodes'],
            ['library', 'Library'],
            ['projects', 'Projects'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            type="button"
            className={`flex-1 py-2.5 text-[12px] ${
              tab === id ? 'border-b-2 border-focus text-ink' : 'text-ink-3 hover:text-ink-2'
            }`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tab === 'nodes' && (
          <>
            <div role="tablist" aria-label="Node groups" className="mb-2 flex gap-1">
              {NODE_GROUPS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  role="tab"
                  aria-selected={group === g.id}
                  onClick={() => setGroup(g.id)}
                  className={`flex-1 rounded-full border px-1.5 py-0.5 text-[11px] ${
                    group === g.id ? 'border-outline bg-accent-soft font-semibold text-ink' : 'border-line text-ink-2 hover:bg-panel-2'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
            {/* Each entry looks like that node collapsed on the canvas, so the sidebar previews what you get. */}
            <ul className="space-y-2 px-1.5">
              {(NODE_GROUPS.find((g) => g.id === group)?.kinds ?? ADDABLE_KINDS).map((kind) => {
                const def = getDefinition(kind);
                return (
                  <li key={kind}>
                    <button
                      type="button"
                      draggable
                      onDragStart={(e) => onDragStart(e, kind)}
                      onClick={() => addAtCenter(kind)}
                      title={`${def.description}. Drag onto the canvas or click to add.`}
                      className="relative flex w-full cursor-grab items-center gap-2 rounded-[12px] border-2 border-outline px-3 py-1.5 text-left transition-transform hover:-translate-y-px active:cursor-grabbing"
                      style={{ background: `color-mix(in srgb, ${def.color} 16%, white)` }}
                    >
                      {def.inputs.length > 0 && kind !== 'collection' && (
                        <span className="absolute -left-[6px] top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2 border-outline bg-node" aria-hidden />
                      )}
                      <span className="size-2.5 shrink-0 rounded-full border-2 border-outline" style={{ background: def.color }} aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">{def.label}</span>
                      <span className="text-[10px] text-ink-2" aria-hidden>
                        ▸
                      </span>
                      {def.outputs.length > 0 && (
                        <span className="absolute -right-[6px] top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2 border-outline bg-node" aria-hidden />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="px-0.5 pt-2 text-[11px] text-ink-3">Drag onto the canvas or click to add. Hover for details.</p>
          </>
        )}

        {tab === 'library' && <AssetLibrary />}

        {tab === 'projects' && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={onNewProject}
              className="w-full rounded-lg border border-dashed border-line-strong py-2 text-[12px] text-ink-2 hover:border-focus hover:text-ink"
            >
              New project
            </button>
            <ul className="space-y-0.5">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onOpenProject(p.id)}
                    className={`w-full rounded-md px-2 py-1.5 text-left ${
                      p.id === currentId ? 'bg-panel-2 text-ink' : 'text-ink-2 hover:bg-panel-2'
                    }`}
                  >
                    <span className="block truncate text-[12px]">{p.name}</span>
                    <span className="block text-[10px] text-ink-3">
                      {new Date(p.updated_at).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
