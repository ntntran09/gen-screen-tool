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
import { uuid } from '../lib/uuid';
import { useAssetStore } from './assetStore';
import { getDefinition, isNodeKind } from '../graph/registry';
import { collectionItems, makeItems, nodeAssetId, readingOrder } from '../graph/collections';
import { currentDetections, sourceAssetFor } from '../graph/detect';
import { attachResults, connectedOutputCollection, type TaskResult } from '../graph/generation';
import { findFreeSpot } from '../graph/layout';
import type {
  AnyNodeData,
  CanvasEdge,
  CanvasNode,
  CollectionData,
  CollectionItem,
  ExtractData,
  GenerateData,
  NodeKind,
  OutputData,
  PaletteData,
} from '../graph/types';
import { LEGACY_IMAGE_KINDS } from '../graph/types';
import { checkConnection } from '../graph/validation';
import { api, toGraphPayload, type GraphPayload, type ProjectDetail, type Viewport } from '../lib/api';
import { applyGraphOps, graphDiff } from '../lib/graphSync';

interface Snapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

/** Canvas pointer tool: box-select, hand (left-drag pans), or eraser (click/drag deletes). */
export type CanvasTool = 'select' | 'pan' | 'eraser' | 'text' | 'draw';

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
  lastCommit: { key: string; at: number } | null;
  /** Transient UI state: never saved or undone. */
  tool: CanvasTool;
  setTool: (tool: CanvasTool) => void;

  loadProject: (project: ProjectDetail) => void;
  applySyncedGraph: (graph: GraphPayload) => void;
  setProjectName: (name: string) => void;
  setSaveStatus: (status: SaveStatus, error?: string | null) => void;
  setViewport: (viewport: Viewport) => void;
  /** Freeze exactly these Generate nodes (a batch is running on them). */
  setFrozen: (ids: string[]) => void;
  frozenCount: number;
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
  updateNodeData: (id: string, patch: Partial<AnyNodeData>) => void;
  /** Replace a collection's items. Pass a coalesce key for typing so one edit is one undo step. */
  setCollectionItems: (id: string, items: CollectionItem[], coalesceKey?: string) => void;
  expandCollection: (id: string, itemIds?: string[]) => void;
  placeInlineResult: (nodeId: string, assetId: string, prompt: string, batchId: string, settings?: Partial<GenerateData>, pending?: { slot_index: number; attempt_number: number }, title?: string, resultAction?: OutputData['resultAction']) => string | null;
  /** Turn single-image nodes (default: the selection) into one Input Collection. Returns its id. */
  groupIntoCollection: (ids?: string[]) => string | null;
  /**
   * Fill a Color Palette from the image connected to its Image port (replaces its colours).
   * `count` defaults to the node's own setting. Resolves to false when there is nothing to read.
   */
  extractPalette: (paletteId: string, count?: number) => Promise<boolean>;
  /** Build or update an Asset sheet Generate from selected detections. One undo step. */
  addExtractionWorkflow: (extractNodeId: string) => Promise<{ collection: string; prompt: string | null; generate: string; count: number; created: boolean } | null>;
  /** Replace an Input Collection with one Original node per item. */
  ungroupCollection: (id: string) => void;
  /**
   * Create (or reuse) the node that receives a new batch's results, connected to the Generate
   * node: an Output Image for one expected result, an Output Collection for several (spec §16.4).
   */
  placeResultNode: (generateId: string, batchId: string, expected: number) => void;
  /** Clear every node and collection item that shows one of these assets (one undo step). Returns the count. */
  clearAssetRefs: (assetIds: string[]) => number;
  /** Undo `placeResultNode` when the batch could not be created (only removes still-empty nodes). */
  discardResultNode: (batchId: string) => void;
  /** Fill result nodes from completed tasks. Not an undo step: results come from the backend. */
  applyResults: (tasks: TaskResult[]) => void;
  deleteSelected: () => void;
  /**
   * Delete specific nodes and connections (eraser, context menu). Locked nodes are kept.
   * Calls sharing a coalesce key (one eraser stroke) undo as one step. Returns how many locked nodes were kept.
   */
  eraseItems: (items: { nodeIds?: string[]; edgeIds?: string[] }, coalesceKey?: string) => number;
  duplicateSelected: () => void;
  copySelected: () => void;
  paste: () => void;
  selectAll: () => void;
}

/**
 * Generate nodes with a batch running. They are frozen: not editable, deletable or connectable
 * until the batch ends. Transient (never saved or undone); kept in step by generationStore.
 */
let frozenIds: ReadonlySet<string> = new Set();

/** True while the user must not change this node: locked by them, or frozen by a running batch. */
export function isNodeLocked(node: Pick<CanvasNode, 'id' | 'data'>): boolean {
  return Boolean(node.data.locked) || frozenIds.has(node.id);
}

export const isNodeFrozen = (id: string) => frozenIds.has(id);

/** Apply per-node interaction flags derived from data (lock state) and running batches. */
function withFlags(node: CanvasNode): CanvasNode {
  if (node.type === 'text' && node.height !== undefined) node = { ...node, height: undefined };
  const locked = isNodeLocked(node);
  const draggable = !node.data.locked;
  const frozen = frozenIds.has(node.id);
  if (node.draggable === draggable && node.deletable === !locked && node.connectable === !frozen) return node;
  return { ...node, draggable, deletable: !locked, connectable: !frozen };
}

function stripSelection(snapshot: Snapshot): Snapshot {
  return {
    nodes: snapshot.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
    edges: snapshot.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
  };
}

function cloneSubgraph(source: Snapshot, offset: number): Snapshot {
  const idMap = new Map(source.nodes.map((n) => [n.id, uuid()]));
  const nodes = source.nodes.map((n) => {
    const id = idMap.get(n.id)!;
    return withFlags({
      id,
      type: n.type,
      position: { x: n.position.x + offset, y: n.position.y + offset },
      width: n.width,
      height: n.height,
      // Assets are referenced by id, never copied, so a pasted node points at the same file.
      // A copied Output Collection keeps its images but no longer receives the original's batches.
      data: n.data.inlineGeneration
        ? { ...structuredClone(n.data), ...(n.type === 'collection' ? { batchIds: [] } : {}),
          inlineGeneration: { ...structuredClone(n.data.inlineGeneration), id: uuid(), batchIds: [] } }
        : n.type === 'collection'
        ? { ...structuredClone(n.data), batchIds: [] }
        : n.type === 'extract'
          ? { ...structuredClone(n.data), generateNodeId: idMap.get((n.data as ExtractData).generateNodeId ?? '') ?? null, collectionNodeId: idMap.get((n.data as ExtractData).collectionNodeId ?? '') ?? null }
          : structuredClone(n.data),
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

const EXTRACT_PROMPT_V1 = 'Isolate the target asset specified in the per-image instructions from this crop. Remove the background and all other objects, including neighboring or attached components that are not part of the target. Keep only the target asset on a transparent background. Preserve its original art style, colors, shape, proportions, details and integral text. Do not restyle, add other objects or create multiple copies. Return one isolated asset.';
export const EXTRACT_PROMPT = 'Isolate the target asset specified in the per-image instructions from this crop. Remove the background and all other objects, including neighboring or attached components that are not part of the target. Keep only the target asset on a transparent background. Preserve its original art style, colors, shape, proportions, details and integral text. When the per-image instructions describe the request the source image was made from, use it to understand the intended theme, materials and style, and redraw the asset so it clearly belongs to that theme, including parts the crop hides or blurs. Do not change what the asset is, add other objects or create multiple copies. Return one isolated asset.';

/** Old projects had separate Original / Theme nodes; both are an Image node now (role = port). */
function upgradeLegacyNode<T extends { type: string; data: Record<string, unknown> }>(n: T): T {
  if (n.type === 'generate' && 'concurrency' in n.data) {
    const data = { ...n.data };
    delete data.concurrency;
    return { ...n, data };
  }
  if (!(LEGACY_IMAGE_KINDS as readonly string[]).includes(n.type)) return n;
  const legacyTitle = n.type === 'original' ? 'Original Image' : 'Theme Image';
  return { ...n, type: 'image', data: { ...n.data, title: n.data.title === legacyTitle ? 'Image' : n.data.title } };
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
    lastCommit: null,
    tool: 'select',
    setTool: (tool) => set({ tool }),

    loadProject: (project) =>
      set({
        projectId: project.id,
        projectName: project.name,
        nodes: project.graph.nodes
          .map(upgradeLegacyNode)
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
      }),

    setProjectName: (name) => set({ projectName: name }),
    applySyncedGraph: (graph) => {
      const current = get();
      const changes = graphDiff(toGraphPayload(current.nodes, current.edges, current.viewport), graph);
      if (!changes.length) return;
      const convert = (payload: GraphPayload, existing: CanvasNode[]) => {
        const byId = new Map(existing.map((n) => [n.id, n]));
        return payload.nodes.filter((n) => isNodeKind(n.type)).map((n) => {
          const old = byId.get(n.id);
          if (old && n.data === old.data && n.position.x === old.position.x && n.position.y === old.position.y
            && (n.width ?? undefined) === old.width && (n.height ?? undefined) === old.height) return withFlags(old);
          const fresh = withFlags({ ...old, id: n.id, type: n.type as NodeKind, position: n.position,
            width: n.width ?? undefined, height: n.height ?? undefined,
            data: { ...getDefinition(n.type as NodeKind).defaultData(), ...n.data } as AnyNodeData });
          return old && JSON.stringify(old) === JSON.stringify(fresh) ? old : fresh;
        });
      };
      const rebase = (snapshot: Snapshot): Snapshot => {
        const payload = applyGraphOps(toGraphPayload(snapshot.nodes, snapshot.edges, current.viewport), changes);
        return { nodes: convert(payload, snapshot.nodes), edges: payload.edges };
      };
      const edgesById = new Map(current.edges.map((e) => [e.id, e]));
      set({ nodes: convert(graph, current.nodes),
        edges: graph.edges.map((e) => ({ ...edgesById.get(e.id), ...e })),
        past: current.past.map(rebase), future: current.future.map(rebase) });
    },
    frozenCount: 0,
    setFrozen: (ids) => {
      const next = new Set(ids);
      if (next.size === frozenIds.size && [...next].every((id) => frozenIds.has(id))) return;
      frozenIds = next;
      set((s) => ({ nodes: s.nodes.map(withFlags), frozenCount: next.size }));
    },
    setSaveStatus: (saveStatus, error = null) => set({ saveStatus, saveError: error }),
    setViewport: (viewport) => {
      const cur = get().viewport;
      if (cur.x === viewport.x && cur.y === viewport.y && cur.zoom === viewport.zoom) return;
      set({ viewport });
      touch();
    },
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
      if (nodes.some((n) => isNodeFrozen(n.id) && !prev.nodes.some((p) => p.id === n.id))) {
        get().showToast('Generating nodes cannot be deleted.');
        return;
      }
      set({
        past: past.slice(0, -1),
        future: [stripSelection({ nodes, edges }), ...future],
        nodes: prev.nodes.map(withFlags),
        edges: prev.edges,
        lastCommit: null,
      });
      touch();
    },

    redo: () => {
      const { past, future, nodes, edges } = get();
      const next = future[0];
      if (!next) return;
      if (nodes.some((n) => isNodeFrozen(n.id) && !next.nodes.some((p) => p.id === n.id))) {
        get().showToast('Generating nodes cannot be deleted.');
        return;
      }
      set({
        past: [...past, stripSelection({ nodes, edges })],
        future: future.slice(1),
        nodes: next.nodes.map(withFlags),
        edges: next.edges,
        lastCommit: null,
      });
      touch();
    },

    onNodesChange: (changes) => {
      const canMove = get().tool === 'select' || get().tool === 'pan';
      changes = changes.filter((c) => c.type !== 'position' || !c.position || canMove);
      changes = changes.filter((c) => c.type !== 'remove' || !get().nodes.some((n) => n.id === c.id && isNodeLocked(n)));
      changes = changes.map((c) => c.type === 'dimensions' && c.setAttributes && get().nodes.some((n) => n.id === c.id && n.type === 'text')
        ? { ...c, setAttributes: 'width' as const } : c);
      set({ nodes: applyNodeChanges(changes, get().nodes).map(withFlags) });
      if (changes.some((c) => c.type === 'position' || c.type === 'remove' || (c.type === 'dimensions' && c.setAttributes))) {
        touch();
      }
    },

    onEdgesChange: (changes) => {
      changes = changes.filter((c) => c.type !== 'remove' || !get().edges.some((e) => e.id === c.id && (isNodeFrozen(e.source) || isNodeFrozen(e.target))));
      set({ edges: applyEdgeChanges(changes, get().edges) });
      if (changes.some((c) => c.type === 'remove')) touch();
    },

    connect: (connection) => {
      const { nodes, edges, commit, showToast } = get();
      if (frozenIds.has(connection.source!) || frozenIds.has(connection.target!)) {
        showToast('This node is generating. Connections change when it finishes.', 'error');
        return;
      }
      const check = checkConnection(connection, nodes, edges);
      if (!check.ok) {
        showToast(check.reason ?? 'Invalid connection.', 'error');
        return;
      }
      const replaced = edges.filter((e) => check.replaces?.includes(e.id));
      // The old connection goes away with the new one; not while a node on it is generating.
      if (replaced.some((e) => frozenIds.has(e.source) || frozenIds.has(e.target))) {
        showToast('The current connection is in use by a running generation. Try again when it finishes.', 'error');
        return;
      }
      commit();
      set({
        edges: addEdge(
          { ...connection, id: `e-${nanoid(10)}` },
          edges.filter((e) => !check.replaces?.includes(e.id)),
        ),
      });
      touch();
      if (replaced.length > 0) showToast('Replaced the previous connection.');
      if (connection.targetHandle === 'image' && nodes.find((n) => n.id === connection.target)?.type === 'palette') {
        void get().extractPalette(connection.target!);
      }
    },

    extractPalette: async (paletteId, count) => {
      const { nodes, edges, showToast } = get();
      const palette = nodes.find((n) => n.id === paletteId);
      const edge = edges.find((e) => e.target === paletteId && e.targetHandle === 'image');
      const source = edge && nodes.find((n) => n.id === edge.source);
      const assetId = source ? nodeAssetId(source) : null;
      if (palette?.type !== 'palette' || !assetId) return false;
      const n = Math.min(8, Math.max(2, count ?? (palette.data as PaletteData).extractCount ?? 5));
      try {
        const { colors } = await api.assetPalette(assetId, n);
        const roles = ['primary', 'secondary', 'accent'] as const;
        get().updateNodeData(paletteId, {
          colors: colors.map((c, i) => ({ id: nanoid(8), hex: c.hex, role: roles[i] ?? 'accent', ratio: c.share })),
        });
        return true;
      } catch (err) {
        showToast(`Could not read colors from the image: ${(err as Error).message}`, 'error');
        return false;
      }
    },

    addNode: (kind, position, data) => get().addNodes([{ kind, position, data }])[0],

    addNodes: (items) => {
      if (items.length === 0) return [];
      get().commit();
      const created = items.map(({ kind, position, data }) =>
        withFlags({
          id: uuid(),
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

    updateNodeData: (id, patch) => {
      get().commit(`data:${id}:${Object.keys(patch).sort().join(',')}`);
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? withFlags({ ...n, data: { ...n.data, ...patch } as AnyNodeData }) : n)),
      }));
      if ('assetId' in patch) {
        // A connected image changed: its palette follows it.
        for (const e of get().edges) {
          if (e.source === id && e.targetHandle === 'image') void get().extractPalette(e.target);
        }
      }
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
      if (node?.type !== 'collection' || isNodeLocked(node)) return;
      get().commit(coalesceKey);
      set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, items } as AnyNodeData } : n)) }));
      touch();
    },

    expandCollection: (id, itemIds) => {
      const node = get().nodes.find((n) => n.id === id);
      if (node?.type !== 'collection' || isNodeLocked(node)) return;
      const items = collectionItems(node).filter((i) => !itemIds || itemIds.includes(i.id));
      get().addNodes(items.map((item, i) => ({
        kind: 'image',
        position: { x: node.position.x + 320 + (i % 4) * 280, y: node.position.y + Math.floor(i / 4) * 280 },
        data: { assetId: item.assetId },
      })));
    },

    placeInlineResult: (nodeId, assetId, prompt, batchId, settings = {}, pending, title, resultAction) => {
      const { nodes, edges, commit } = get();
      const source = nodes.find((n) => n.id === nodeId);
      if (!source || isNodeLocked(source)) return null;
      if (nodeAssetId(source) !== assetId && !(source.type === 'collection' && collectionItems(source).some((i) => i.assetId === assetId))) return null;
      const generationId = source.data.inlineGeneration?.id ?? uuid();
      const result: CanvasNode = withFlags({ id: uuid(), type: 'output',
        position: findFreeSpot({ x: source.position.x + 320, y: source.position.y }, nodes),
        data: { ...getDefinition('output').defaultData(), title: title ?? (pending ? 'Retried result' : 'Edited result'), generationId: batchId, sourceNodeId: source.id,
          ...(resultAction || pending ? { resultAction: resultAction ?? 'retry' } : {}),
          ...(pending ? { pendingSlot: pending.slot_index, pendingAttempt: pending.attempt_number } : {}),
        },
      });
      commit();
      set({ nodes: [...nodes.map((n) => n.id === source.id ? { ...n, data: { ...n.data,
        inlineGeneration: { id: generationId, assetId, prompt: prompt.trim(), settings,
          batchIds: [...new Set([...(source.data.inlineGeneration?.batchIds ?? []), batchId])] },
      } } : n), result], edges: [...edges,
        { id: uuid(), source: source.id, sourceHandle: 'out', target: result.id, targetHandle: 'edit' },
      ] });
      touch();
      return generationId;
    },

    groupIntoCollection: (ids) => {
      const { nodes, edges, commit, showToast } = get();
      const pool = ids ? nodes.filter((n) => ids.includes(n.id)) : nodes.filter((n) => n.selected);
      const members = readingOrder(pool.filter((n) => nodeAssetId(n) && !isNodeLocked(n)));
      if (members.length < 2) {
        showToast('Select at least two unlocked image nodes to group.', 'error');
        return null;
      }
      commit();
      const memberIds = new Set(members.map((n) => n.id));
      const items = makeItems(members.map((n) => nodeAssetId(n)!));
      const collection = withFlags({
        id: uuid(),
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

    addExtractionWorkflow: async (extractNodeId) => {
      const initial = get();
      const extract = initial.nodes.find((n) => n.id === extractNodeId);
      if (extract?.type !== 'extract' || isNodeLocked(extract) || !initial.projectId) return null;
      const data = extract.data as ExtractData;
      const assetId = sourceAssetFor(initial.nodes, initial.edges, extractNodeId);
      const found = currentDetections(data, assetId);
      const chosen = found?.items.filter((_, i) => !data.off.includes(i)) ?? [];
      if (!assetId || chosen.length === 0) return null;
      const oldGenerate = initial.nodes.find((n) => n.id === data.generateNodeId && n.type === 'generate');
      const oldCollection = initial.nodes.find((n) => n.id === data.collectionNodeId && n.type === 'collection');
      const blocked = () => [oldGenerate, oldCollection].some((n) => n && isNodeLocked(n));
      if (blocked()) {
        initial.showToast('The collection or Generate node is locked or generating.', 'error');
        return null;
      }
      // The request that made the source image tells the model which theme to rebuild each asset in.
      // Best effort: a plain upload has none, and a failed lookup must not block the crop.
      const originPrompts = await api.assetOriginPrompts(assetId).then((r) => r.prompts, () => [] as string[]);
      const { assets } = await api.cropAssets(assetId, chosen.map(({ name, x, y, w, h }) => ({ name, x, y, w, h })));
      const { nodes, edges, commit } = get();
      // Do not attach delayed crops to another project or overwrite edits made during the request.
      if (get().projectId !== initial.projectId || nodes.find((n) => n.id === extractNodeId)?.data !== data ||
          sourceAssetFor(nodes, edges, extractNodeId) !== assetId ||
          [oldGenerate, oldCollection].some((old) => old && nodes.find((n) => n.id === old.id) !== old) || blocked()) return null;
      useAssetStore.getState().upsert(assets);
      const items = makeItems(assets.map((a) => a.id));
      items.forEach((item, i) => {
        const target = chosen[i];
        const clean = (text: string) => text.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
        const context = clean(originPrompts.join(' Then edited: ')).slice(0, 700);
        item.promptOverride = `Target asset: "${clean(target.name)}". ${clean(target.description)} Keep only this target; remove all other objects in the crop.` +
          (context ? ` Source image context: the full image was created from this request: "${context}". Use it to understand the theme and style, and make this asset match it.` : '');
      });
      const wire = (from: string, to: string, handle: string): CanvasEdge => ({
        id: `e-${nanoid(10)}`, source: from, sourceHandle: 'out', target: to, targetHandle: handle,
      });
      commit();
      const collection: CanvasNode = oldCollection
        ? { ...oldCollection, data: { ...oldCollection.data, role: 'input', items } as AnyNodeData }
        : withFlags({
            id: uuid(), type: 'collection',
            position: findFreeSpot({ x: extract.position.x + 330, y: extract.position.y }, nodes),
            data: { ...getDefinition('collection').defaultData(), title: 'Cropped assets', items } as AnyNodeData,
          });
      let nextNodes = nodes.map((n) => n.id === oldCollection?.id ? collection : { ...n, selected: false });
      if (!oldCollection) nextNodes.push(collection);
      const origin = findFreeSpot({ x: collection.position.x + 360, y: collection.position.y }, nextNodes);
      const settings = { preset: 'assets', assetSelection: 'only the target asset specified in the per-image instructions', mode: 'match', variantsPerInput: 1, aspectRatio: 'match', primaryOriginalNodeId: null };
      const generate: CanvasNode = oldGenerate
        ? { ...oldGenerate, selected: true, data: { ...oldGenerate.data, ...settings } as AnyNodeData }
        : withFlags({ id: uuid(), type: 'generate', position: origin,
            data: { ...getDefinition('generate').defaultData(), title: 'Remove backgrounds', ...settings } as AnyNodeData, selected: true });
      const promptEdge = oldGenerate && edges.find((e) => e.target === oldGenerate.id && e.targetHandle === 'prompt' && nodes.find((n) => n.id === e.source)?.type === 'prompt');
      const prompt = !promptEdge ? withFlags({
        id: uuid(), type: 'prompt', position: { x: collection.position.x, y: collection.position.y - 260 },
        data: { ...getDefinition('prompt').defaultData(), title: 'Remove background', text: EXTRACT_PROMPT } as AnyNodeData,
      }) : null;
      nextNodes = nextNodes.map((n) => {
        if (n.id === extractNodeId) return { ...n, data: { ...n.data, generateNodeId: generate.id, collectionNodeId: collection.id } as AnyNodeData };
        if (n.id === oldGenerate?.id) return generate;
        if (n.id === promptEdge?.source && ['Keep the original art style.', EXTRACT_PROMPT_V1, 'Remove the background from this cropped asset. Keep only the main asset on a transparent background. Preserve its original art style, colors, shape, proportions, details and integral text. Do not restyle, add other objects or create multiple copies. Return one isolated asset.'].includes(String(n.data.text))) return { ...n, data: { ...n.data, text: EXTRACT_PROMPT, title: 'Remove background' } as AnyNodeData };
        return n;
      });
      if (!oldGenerate) nextNodes.push(generate);
      if (prompt) nextNodes.push(prompt);
      set({
        nodes: nextNodes,
        edges: [
          ...edges.filter((e) => !(e.target === generate.id && e.targetHandle === 'original') && !(e.target === collection.id && e.targetHandle === 'extract')),
          wire(extractNodeId, collection.id, 'extract'), wire(collection.id, generate.id, 'original'),
          ...(prompt ? [wire(prompt.id, generate.id, 'prompt')] : []),
        ],
      });
      touch();
      return { collection: collection.id, prompt: prompt?.id ?? null, generate: generate.id, count: assets.length, created: !oldGenerate };
    },

    ungroupCollection: (id) => {
      const { nodes, edges, commit, showToast } = get();
      const node = nodes.find((n) => n.id === id);
      if (node?.type !== 'collection' || isNodeLocked(node)) return;
      const items = collectionItems(node);
      if ((node.data as { role?: string }).role !== 'input' || items.length === 0) {
        showToast('Only a non-empty Input Collection can be ungrouped.', 'error');
        return;
      }
      commit();
      const created = items.map((item, i) =>
        withFlags({
          id: uuid(),
          type: 'image' as const,
          position: { x: node.position.x + (i % 4) * 230, y: node.position.y + Math.floor(i / 4) * 290 },
          data: { ...getDefinition('image').defaultData(), assetId: item.assetId } as AnyNodeData,
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
      showToast(`Ungrouped into ${created.length} Image nodes.${off ? ` ${off} were disabled in the collection.` : ''}`);
      touch();
    },

    placeResultNode: (generateId, batchId, expected) => {
      const { nodes, edges, commit } = get();
      const gen = nodes.find((n) => n.id === generateId);
      if (!gen) return;
      commit();
      const existing = expected > 1 ? connectedOutputCollection(nodes, edges, generateId) : null;
      if (existing) {
        const data = existing.data as CollectionData;
        set({
          nodes: nodes.map((n) =>
            n.id === existing.id ? { ...n, data: { ...data, batchIds: [...(data.batchIds ?? []), batchId] } as AnyNodeData } : n,
          ),
        });
        touch();
        return;
      }
      const kind = expected > 1 ? 'collection' : 'output';
      const fresh = getDefinition(kind).defaultData();
      const data =
        kind === 'collection'
          ? { ...fresh, title: `${gen.data.title} results`, role: 'output', batchIds: [batchId] }
          : { ...fresh, title: `${gen.data.title} result`, generationId: batchId };
      const node = withFlags({
        id: uuid(),
        type: kind,
        position: findFreeSpot({ x: gen.position.x + 320, y: gen.position.y }, nodes),
        data: data as AnyNodeData,
      });
      set({
        nodes: [...nodes, node],
        edges: [
          ...edges,
          { id: `e-${nanoid(10)}`, source: generateId, sourceHandle: 'out', target: node.id, targetHandle: 'in' },
        ],
      });
      touch();
    },

    clearAssetRefs: (assetIds) => {
      const gone = new Set(assetIds);
      const { nodes, commit } = get();
      let count = 0;
      const next = nodes.map((n) => {
        const id = nodeAssetId(n);
        if (id && gone.has(id)) {
          count += 1;
          return { ...n, data: { ...n.data, assetId: null } as AnyNodeData };
        }
        const items = collectionItems(n);
        const kept = items.filter((i) => !gone.has(i.assetId));
        if (kept.length === items.length) return n;
        count += items.length - kept.length;
        return { ...n, data: { ...n.data, items: kept } as AnyNodeData };
      });
      if (count === 0) return 0;
      commit();
      set({ nodes: next });
      touch();
      return count;
    },

    discardResultNode: (batchId) => {
      const { nodes, edges } = get();
      const dropped = new Set(
        nodes
          .filter((n) => {
            const d = n.data as Partial<OutputData & CollectionData>;
            if (n.type === 'output') return d.generationId === batchId && !d.assetId;
            return n.type === 'collection' && d.batchIds?.length === 1 && d.batchIds[0] === batchId && !d.items?.length;
          })
          .map((n) => n.id),
      );
      set({
        nodes: nodes
          .filter((n) => !dropped.has(n.id))
          .map((n) => {
            if (n.data.inlineGeneration?.batchIds.includes(batchId)) {
              return { ...n, data: { ...n.data, inlineGeneration: { ...n.data.inlineGeneration,
                batchIds: n.data.inlineGeneration.batchIds.filter((id) => id !== batchId),
              } } };
            }
            const d = n.data as CollectionData;
            return n.type === 'collection' && d.batchIds?.includes(batchId)
              ? { ...n, data: { ...d, batchIds: d.batchIds.filter((b) => b !== batchId) } as AnyNodeData }
              : n;
          }),
        edges: edges.filter((e) => !dropped.has(e.target)),
      });
      touch();
    },

    applyResults: (tasks) => {
      const { nodes } = get();
      const next = attachResults(nodes, tasks);
      if (next === nodes) return;
      set({ nodes: next });
      touch();
    },

    deleteSelected: () => {
      const { nodes, edges, commit, showToast } = get();
      const removable = new Set(nodes.filter((n) => n.selected && !isNodeLocked(n)).map((n) => n.id));
      const lockedSelected = nodes.some((n) => n.selected && isNodeLocked(n));
      const edgeIds = new Set(edges.filter((e) => e.selected && !isNodeFrozen(e.source) && !isNodeFrozen(e.target)).map((e) => e.id));
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

    eraseItems: ({ nodeIds = [], edgeIds = [] }, coalesceKey) => {
      const { nodes, edges, commit } = get();
      const wanted = new Set(nodeIds);
      const removable = new Set(nodes.filter((n) => wanted.has(n.id) && !isNodeLocked(n)).map((n) => n.id));
      const kept = nodes.filter((n) => wanted.has(n.id) && isNodeLocked(n)).length;
      // A connection into or out of a generating node stays until the batch ends.
      const edgeSet = new Set(edgeIds.filter((id) => {
        const e = edges.find((x) => x.id === id);
        return !e || !(frozenIds.has(e.source) || frozenIds.has(e.target));
      }));
      const nextEdges = edges.filter((e) => !edgeSet.has(e.id) && !removable.has(e.source) && !removable.has(e.target));
      if (removable.size === 0 && nextEdges.length === edges.length) return kept;
      commit(coalesceKey);
      set({ nodes: nodes.filter((n) => !removable.has(n.id)), edges: nextEdges });
      touch();
      return kept;
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
