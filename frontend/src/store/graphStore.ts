import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react';
import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { getDefinition, isNodeKind } from '../graph/registry';
import { collectionItems, makeItems, nodeAssetId, readingOrder } from '../graph/collections';
import type { AnyNodeData, CanvasEdge, CanvasNode, CollectionItem, NodeKind, OriginalData } from '../graph/types';
import { checkConnection } from '../graph/validation';
import type { ProjectDetail, Viewport } from '../lib/api';

interface Snapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

const HISTORY_LIMIT = 100;
const COALESCE_MS = 1000;
const PASTE_OFFSET = 40;

interface GraphState {
  projectId: string | null;
  projectName: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  past: Snapshot[];
  future: Snapshot[];
  clipboard: Snapshot | null;
  /** Bumped on every change that must be persisted; auto-save watches it. */
  revision: number;
  saveStatus: SaveStatus;
  saveError: string | null;
  toast: Toast | null;
  /** Generate nodes with a run in progress. Transient: never saved or undone. */
  generatingNodeIds: Record<string, true>;
  lastCommit: { key: string; at: number } | null;

  loadProject: (project: ProjectDetail) => void;
  setProjectName: (name: string) => void;
  setSaveStatus: (status: SaveStatus, error?: string | null) => void;
  setViewport: (viewport: Viewport) => void;
  setGenerating: (nodeId: string, on: boolean) => void;
  showToast: (message: string, tone?: Toast['tone']) => void;

  commit: (coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;

  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void;
  connect: (connection: Connection) => void;
  addNode: (kind: NodeKind, position: XYPosition, data?: Partial<AnyNodeData>) => string;
  /** Add several nodes as one undo step; returns their ids in order. */
  addNodes: (items: { kind: NodeKind; position: XYPosition; data?: Partial<AnyNodeData> }[]) => string[];
  /** Change an image-like node's role (Reference / Original / Theme), keeping its asset. */
  convertNode: (id: string, kind: 'image' | 'original' | 'theme') => void;
  updateNodeData: (id: string, patch: Partial<AnyNodeData>) => void;
  /** Replace a collection's items. Pass a coalesce key for typing so one edit is one undo step. */
  setCollectionItems: (id: string, items: CollectionItem[], coalesceKey?: string) => void;
  /** Turn single-image nodes (default: the selection) into one Input Collection. Returns its id. */
  groupIntoCollection: (ids?: string[]) => string | null;
  /** Replace an Input Collection with one Original node per item. */
  ungroupCollection: (id: string) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  copySelected: () => void;
  paste: () => void;
  selectAll: () => void;
}

/** Apply per-node interaction flags derived from data (lock state). */
function withFlags(node: CanvasNode): CanvasNode {
  const locked = Boolean(node.data.locked);
  if (node.draggable === !locked && node.deletable === !locked) return node;
  return { ...node, draggable: !locked, deletable: !locked };
}

function stripSelection(snapshot: Snapshot): Snapshot {
  return {
    nodes: snapshot.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
    edges: snapshot.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
  };
}

function cloneSubgraph(source: Snapshot, offset: number): Snapshot {
  const idMap = new Map<string, string>();
  const nodes = source.nodes.map((n) => {
    const id = crypto.randomUUID();
    idMap.set(n.id, id);
    return withFlags({
      id,
      type: n.type,
      position: { x: n.position.x + offset, y: n.position.y + offset },
      width: n.width,
      height: n.height,
      // Assets are referenced by id, never copied, so a pasted node points at the same file.
      data: structuredClone(n.data),
      selected: true,
    });
  });
  const edges = source.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({
      id: `e-${nanoid(10)}`,
      source: idMap.get(e.source)!,
      sourceHandle: e.sourceHandle,
      target: idMap.get(e.target)!,
      targetHandle: e.targetHandle,
    }));
  return { nodes, edges };
}

let toastSeq = 0;

export const useGraphStore = create<GraphState>()((set, get) => {
  const touch = () => set((s) => ({ revision: s.revision + 1, saveStatus: 'dirty' }));

  return {
    projectId: null,
    projectName: '',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    past: [],
    future: [],
    clipboard: null,
    revision: 0,
    saveStatus: 'saved',
    saveError: null,
    toast: null,
    generatingNodeIds: {},
    lastCommit: null,

    loadProject: (project) =>
      set({
        projectId: project.id,
        projectName: project.name,
        nodes: project.graph.nodes
          .filter((n) => isNodeKind(n.type))
          .map((n) =>
            withFlags({
              id: n.id,
              type: n.type as NodeKind,
              position: n.position,
              width: n.width ?? undefined,
              height: n.height ?? undefined,
              // Fill fields added after the node was saved (e.g. collection items).
              data: { ...getDefinition(n.type as NodeKind).defaultData(), ...n.data } as AnyNodeData,
            }),
          ),
        edges: project.graph.edges.map((e) => ({ ...e })),
        viewport: project.graph.viewport,
        past: [],
        future: [],
        revision: 0,
        saveStatus: 'saved',
        saveError: null,
        lastCommit: null,
        generatingNodeIds: {},
      }),

    setProjectName: (name) => set({ projectName: name }),
    setSaveStatus: (saveStatus, error = null) => set({ saveStatus, saveError: error }),
    setViewport: (viewport) => {
      const cur = get().viewport;
      if (cur.x === viewport.x && cur.y === viewport.y && cur.zoom === viewport.zoom) return;
      set({ viewport });
      touch();
    },
    setGenerating: (nodeId, on) =>
      set((s) => {
        const next = { ...s.generatingNodeIds };
        if (on) next[nodeId] = true;
        else delete next[nodeId];
        return { generatingNodeIds: next };
      }),
    showToast: (message, tone = 'info') => set({ toast: { id: ++toastSeq, message, tone } }),

    commit: (coalesceKey) => {
      const { nodes, edges, past, lastCommit } = get();
      const now = Date.now();
      if (coalesceKey && lastCommit?.key === coalesceKey && now - lastCommit.at < COALESCE_MS) {
        set({ lastCommit: { key: coalesceKey, at: now } });
        return;
      }
      set({
        past: [...past, stripSelection({ nodes, edges })].slice(-HISTORY_LIMIT),
        future: [],
        lastCommit: coalesceKey ? { key: coalesceKey, at: now } : null,
      });
    },

    undo: () => {
      const { past, future, nodes, edges } = get();
      const prev = past.at(-1);
      if (!prev) return;
      set({
        past: past.slice(0, -1),
        future: [stripSelection({ nodes, edges }), ...future],
        nodes: prev.nodes,
        edges: prev.edges,
        lastCommit: null,
      });
      touch();
    },

    redo: () => {
      const { past, future, nodes, edges } = get();
      const next = future[0];
      if (!next) return;
      set({
        past: [...past, stripSelection({ nodes, edges })],
        future: future.slice(1),
        nodes: next.nodes,
        edges: next.edges,
        lastCommit: null,
      });
      touch();
    },

    onNodesChange: (changes) => {
      set({ nodes: applyNodeChanges(changes, get().nodes) });
      if (changes.some((c) => c.type === 'position' || c.type === 'remove' || (c.type === 'dimensions' && c.setAttributes))) {
        touch();
      }
    },

    onEdgesChange: (changes) => {
      set({ edges: applyEdgeChanges(changes, get().edges) });
      if (changes.some((c) => c.type === 'remove')) touch();
    },

    connect: (connection) => {
      const { nodes, edges, commit, showToast } = get();
      const check = checkConnection(connection, nodes, edges);
      if (!check.ok) {
        showToast(check.reason ?? 'Invalid connection.', 'error');
        return;
      }
      commit();
      set({ edges: addEdge({ ...connection, id: `e-${nanoid(10)}` }, get().edges) });
      touch();
    },

    addNode: (kind, position, data) => get().addNodes([{ kind, position, data }])[0],

    addNodes: (items) => {
      if (items.length === 0) return [];
      get().commit();
      const created = items.map(({ kind, position, data }) =>
        withFlags({
          id: crypto.randomUUID(),
          type: kind,
          position,
          data: { ...getDefinition(kind).defaultData(), ...data } as AnyNodeData,
          selected: true,
        }),
      );
      set((s) => ({ nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...created] }));
      touch();
      return created.map((n) => n.id);
    },

    convertNode: (id, kind) => {
      const { nodes, edges, commit, showToast } = get();
      const node = nodes.find((n) => n.id === id);
      if (!node || node.type === kind || !['image', 'original', 'theme', 'output'].includes(node.type!)) return;
      commit();
      const oldDef = getDefinition(node.type!);
      const fresh = getDefinition(kind).defaultData();
      const old = node.data as Record<string, unknown>;
      const data = {
        ...fresh,
        // Keep a custom title; a default one follows the new role.
        title: old.title === oldDef.defaultData().title ? fresh.title : old.title,
        locked: old.locked,
        collapsed: old.collapsed,
        assetId: old.assetId ?? null,
        notes: typeof old.notes === 'string' ? old.notes : '',
      } as AnyNodeData;
      const converted = withFlags({ ...node, type: kind, data });
      const nextNodes = nodes.map((n) => (n.id === id ? converted : n));
      // The output type changes with the role, so existing connections may no longer fit.
      const kept = edges.filter(
        (e) => e.source !== id || checkConnection(e, nextNodes, edges.filter((o) => o.id !== e.id)).ok,
      );
      set({ nodes: nextNodes, edges: kept });
      if (kept.length !== edges.length) showToast(`Removed ${edges.length - kept.length} connection(s) that no longer fit.`);
      touch();
    },

    updateNodeData: (id, patch) => {
      get().commit(`data:${id}:${Object.keys(patch).sort().join(',')}`);
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? withFlags({ ...n, data: { ...n.data, ...patch } as AnyNodeData }) : n)),
      }));
      if ('role' in patch) {
        // A collection switching input↔output changes which connections are legal.
        const { nodes, edges, showToast } = get();
        const kept = edges.filter(
          (e) =>
            (e.source !== id && e.target !== id) ||
            checkConnection(e, nodes, edges.filter((o) => o.id !== e.id)).ok,
        );
        if (kept.length !== edges.length) {
          set({ edges: kept });
          showToast(`Removed ${edges.length - kept.length} connection(s) that no longer fit.`);
        }
      }
      touch();
    },

    setCollectionItems: (id, items, coalesceKey) => {
      const node = get().nodes.find((n) => n.id === id);
      if (node?.type !== 'collection') return;
      get().commit(coalesceKey);
      set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, items } as AnyNodeData } : n)) }));
      touch();
    },

    groupIntoCollection: (ids) => {
      const { nodes, edges, commit, showToast } = get();
      const pool = ids ? nodes.filter((n) => ids.includes(n.id)) : nodes.filter((n) => n.selected);
      const members = readingOrder(pool.filter((n) => nodeAssetId(n) && !n.data.locked));
      if (members.length < 2) {
        showToast('Select at least two unlocked image nodes to group.', 'error');
        return null;
      }
      commit();
      const memberIds = new Set(members.map((n) => n.id));
      const items = makeItems(members.map((n) => nodeAssetId(n)!));
      // An Original's own instructions become that item's prompt override.
      members.forEach((n, i) => {
        if (n.type === 'original') items[i].promptOverride = (n.data as OriginalData).instructions ?? '';
      });
      const collection = withFlags({
        id: crypto.randomUUID(),
        type: 'collection',
        position: {
          x: Math.min(...members.map((n) => n.position.x)),
          y: Math.min(...members.map((n) => n.position.y)),
        },
        data: { ...getDefinition('collection').defaultData(), items } as AnyNodeData,
        selected: true,
      });
      // Members that fed a Generate node's Original port are replaced by the collection feeding it once.
      const feeds = new Set(
        edges.filter((e) => memberIds.has(e.source) && e.targetHandle === 'original').map((e) => e.target),
      );
      const kept = edges.filter((e) => !memberIds.has(e.source) && !memberIds.has(e.target));
      const nextNodes = [...nodes.filter((n) => !memberIds.has(n.id)).map((n) => (n.selected ? { ...n, selected: false } : n)), collection];
      const added: CanvasEdge[] = [];
      for (const target of feeds) {
        const edge = { id: `e-${nanoid(10)}`, source: collection.id, sourceHandle: 'out', target, targetHandle: 'original' };
        if (checkConnection(edge, nextNodes, [...kept, ...added]).ok) added.push(edge);
      }
      const dropped = edges.filter(
        (e) => (memberIds.has(e.source) || memberIds.has(e.target)) && !(memberIds.has(e.source) && e.targetHandle === 'original'),
      ).length;
      set({ nodes: nextNodes, edges: [...kept, ...added] });
      const skipped = pool.length - members.length;
      const notes = [
        `Grouped ${members.length} images into a collection.`,
        ...(dropped > 0 ? [`Removed ${dropped} connection(s) that a collection cannot keep.`] : []),
        ...(skipped > 0 ? [`${skipped} node(s) left out (locked, empty or not an image).`] : []),
      ];
      showToast(notes.join(' '));
      touch();
      return collection.id;
    },

    ungroupCollection: (id) => {
      const { nodes, edges, commit, showToast } = get();
      const node = nodes.find((n) => n.id === id);
      if (node?.type !== 'collection' || node.data.locked) return;
      const items = collectionItems(node);
      if ((node.data as { role?: string }).role !== 'input' || items.length === 0) {
        showToast('Only a non-empty Input Collection can be ungrouped.', 'error');
        return;
      }
      commit();
      const created = items.map((item, i) =>
        withFlags({
          id: crypto.randomUUID(),
          type: 'original' as const,
          position: { x: node.position.x + (i % 4) * 230, y: node.position.y + Math.floor(i / 4) * 290 },
          data: { ...getDefinition('original').defaultData(), assetId: item.assetId, instructions: item.promptOverride } as AnyNodeData,
          selected: true,
        }),
      );
      const feeds = edges.filter((e) => e.source === id).map((e) => e.target);
      const kept = edges.filter((e) => e.source !== id && e.target !== id);
      const nextNodes = [...nodes.filter((n) => n.id !== id).map((n) => (n.selected ? { ...n, selected: false } : n)), ...created];
      const added: CanvasEdge[] = [];
      for (const target of feeds) {
        for (const n of created) {
          const edge = { id: `e-${nanoid(10)}`, source: n.id, sourceHandle: 'out', target, targetHandle: 'original' };
          if (checkConnection(edge, nextNodes, [...kept, ...added]).ok) added.push(edge);
        }
      }
      set({ nodes: nextNodes, edges: [...kept, ...added] });
      const off = items.filter((i) => !i.enabled).length;
      showToast(`Ungrouped into ${created.length} Original nodes.${off ? ` ${off} were disabled in the collection.` : ''}`);
      touch();
    },

    deleteSelected: () => {
      const { nodes, edges, commit, showToast } = get();
      const removable = new Set(nodes.filter((n) => n.selected && !n.data.locked).map((n) => n.id));
      const lockedSelected = nodes.some((n) => n.selected && n.data.locked);
      const edgeIds = new Set(edges.filter((e) => e.selected).map((e) => e.id));
      if (removable.size === 0 && edgeIds.size === 0) {
        if (lockedSelected) showToast('Locked nodes cannot be deleted. Unlock them first.');
        return;
      }
      commit();
      set({
        nodes: nodes.filter((n) => !removable.has(n.id)),
        edges: edges.filter((e) => !edgeIds.has(e.id) && !removable.has(e.source) && !removable.has(e.target)),
      });
      if (lockedSelected) showToast('Locked nodes were kept.');
      touch();
    },

    copySelected: () => {
      const { nodes, edges } = get();
      const selected = nodes.filter((n) => n.selected);
      if (selected.length === 0) return;
      const ids = new Set(selected.map((n) => n.id));
      set({
        clipboard: structuredClone(
          stripSelection({ nodes: selected, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }),
        ),
      });
    },

    paste: () => {
      const { clipboard, commit } = get();
      if (!clipboard || clipboard.nodes.length === 0) return;
      commit();
      const copy = cloneSubgraph(clipboard, PASTE_OFFSET);
      set((s) => ({
        nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...copy.nodes],
        edges: [...s.edges.map((e) => (e.selected ? { ...e, selected: false } : e)), ...copy.edges],
        // Repeated pastes cascade instead of stacking on the same spot.
        clipboard: { nodes: copy.nodes, edges: copy.edges },
      }));
      touch();
    },

    duplicateSelected: () => {
      const { nodes, edges, commit } = get();
      const selected = nodes.filter((n) => n.selected);
      if (selected.length === 0) return;
      const ids = new Set(selected.map((n) => n.id));
      commit();
      const copy = cloneSubgraph(
        { nodes: selected, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) },
        PASTE_OFFSET,
      );
      set((s) => ({
        nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...copy.nodes],
        edges: [...s.edges, ...copy.edges],
      }));
      touch();
    },

    selectAll: () =>
      set((s) => ({ nodes: s.nodes.map((n) => (n.selected ? n : { ...n, selected: true })) })),
  };
});

if (import.meta.env.DEV && typeof window !== 'undefined') {
  // Debug handle for inspecting graph state from the browser console in development.
  (window as unknown as { __graphStore: typeof useGraphStore }).__graphStore = useGraphStore;
}
