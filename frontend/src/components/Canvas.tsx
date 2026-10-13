import {
  Background,
  BackgroundVariant,
  ControlButton,
  MiniMap,
  Panel,
  SelectionMode,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type IsValidConnection,
} from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { originalEdgeRoles, type OriginalRole } from '../graph/generation';
import { mainClusterBounds } from '../graph/mainCluster';
import { getDefinition, isNodeKind } from '../graph/registry';
import type { CanvasEdge, CanvasNode, CollectionData, NodeKind } from '../graph/types';
import { checkConnection } from '../graph/validation';
import { nodeTypes } from '../nodes/nodeTypes';
import { isNodeFrozen, isNodeLocked, useGraphStore, type CanvasTool } from '../store/graphStore';
import { isSupportedImage, useAssetPlacement, useImageImport, type ImportTarget } from '../hooks/useImageImport';
import { isTypingTarget } from '../hooks/useShortcuts';
import { useAssetStore } from '../store/assetStore';
import { AddNodeMenu } from './AddNodeMenu';
import { ContextMenu, type MenuItem } from './ContextMenu';

const ICON = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const TOOLS: { id: CanvasTool; label: string; key: string; icon: ReactNode }[] = [
  {
    id: 'select',
    label: 'Select',
    key: 'V',
    icon: (
      <svg {...ICON} className="tool-icon" aria-hidden>
        <path d="M5 3l14 7-6 2-2 6z" />
      </svg>
    ),
  },
  {
    id: 'pan',
    label: 'Hand: drag to pan',
    key: 'H',
    icon: (
      <svg {...ICON} className="tool-icon" aria-hidden>
        <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
      </svg>
    ),
  },
  {
    id: 'eraser',
    label: 'Eraser: click or drag over nodes and connections to delete them',
    key: 'E',
    icon: (
      <svg {...ICON} className="tool-icon" aria-hidden>
        <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
        <path d="M22 21H7" />
        <path d="m5 11 9 9" />
      </svg>
    ),
  },
];

type ItemMenu = { x: number; y: number; title: string; items: MenuItem[] };

let strokeSeq = 0;

const PORT_EDGE_CLASS: Record<string, string> = {
  prompt: 'edge-prompt',
  original: 'edge-original',
  theme: 'edge-theme',
  palette: 'edge-palette',
};

/**
 * Wires into a Generate node take their port's colour (the handle already does), so you can see
 * which is the original. With several originals in Manual count all are sent; the primary is thick and the
 * others lighter, and clicking another wire makes it the primary. Until one is chosen they are dashed.
 */
function styleEdges(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasEdge[] {
  const roles = new Map<string, OriginalRole>();
  for (const g of nodes) {
    if (g.type === 'generate') for (const [id, role] of originalEdgeRoles(nodes, edges, g.id)) roles.set(id, role);
  }
  return edges.map((e) => {
    const port = e.targetHandle ? PORT_EDGE_CLASS[e.targetHandle] : undefined;
    const role = roles.get(e.id);
    const classes = [port, role && role !== 'used' ? `edge-${role}` : undefined].filter(Boolean).join(' ');
    return classes ? { ...e, className: classes } : e;
  });
}

export const DRAG_MIME = 'application/x-nodecanvas-node';
/** Library drag payload: JSON array of { id, name } for stored assets. */
export const ASSET_DRAG_MIME = 'application/x-nodecanvas-assets';

/** Where dropped images go, decided by the node under the pointer (spec §6.4). */
function dropTarget(e: DragEvent, count: number): ImportTarget {
  const nodeId = (e.target as HTMLElement).closest<HTMLElement>('.react-flow__node')?.dataset.id;
  const node = nodeId ? useGraphStore.getState().nodes.find((n) => n.id === nodeId) : undefined;
  if (node && !isNodeLocked(node)) {
    if (node.type === 'collection' && (node.data as CollectionData).role === 'input') return { collectionNodeId: node.id };
    // Dropping a single image onto an image node replaces it; several images start a new group instead.
    if (count === 1 && node.type === 'image') return { replaceNodeId: node.id };
  }
  // Alt keeps separate nodes; otherwise several images become one collection.
  return { screen: { x: e.clientX, y: e.clientY }, group: !e.altKey };
}

export function Canvas() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const shownEdges = useMemo(() => styleEdges(nodes, edges), [nodes, edges]);
  const viewport = useGraphStore((s) => s.viewport);
  const projectId = useGraphStore((s) => s.projectId);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const connect = useGraphStore((s) => s.connect);
  const addNode = useGraphStore((s) => s.addNode);
  const commit = useGraphStore((s) => s.commit);
  const setViewport = useGraphStore((s) => s.setViewport);
  const showToast = useGraphStore((s) => s.showToast);
  const { screenToFlowPosition, setViewport: applyViewport, zoomIn, zoomOut, fitView, fitBounds } = useReactFlow();
  const importImages = useImageImport();
  const placeAssets = useAssetPlacement();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [itemMenu, setItemMenu] = useState<ItemMenu | null>(null);
  const tool = useGraphStore((s) => s.tool);
  const setTool = useGraphStore((s) => s.setTool);
  const wrapper = useRef<HTMLDivElement>(null);
  // Active eraser stroke (left button held); its key makes the whole stroke one undo step.
  const stroke = useRef<string | null>(null);

  const erase = useCallback(
    (items: { nodeIds?: string[]; edgeIds?: string[] }, key?: string) => {
      const kept = useGraphStore.getState().eraseItems(items, key);
      if (kept > 0) showToast('Locked nodes cannot be deleted. Unlock them first.');
    },
    [showToast],
  );

  useEffect(() => {
    const end = () => {
      stroke.current = null;
    };
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, []);

  /** Clicking a wire into a Generate node's Original port makes that image the Primary original. */
  const chooseAsPrimary = useCallback(
    (edgeId: string) => {
      const s = useGraphStore.getState();
      const edge = s.edges.find((e) => e.id === edgeId);
      const gen = edge && s.nodes.find((n) => n.id === edge.target);
      const src = edge && s.nodes.find((n) => n.id === edge.source);
      if (!edge || gen?.type !== 'generate' || edge.targetHandle !== 'original' || !src) return;
      const role = originalEdgeRoles(s.nodes, s.edges, gen.id).get(edge.id);
      if (role === 'primary' || role === 'used') return; // already the one in use
      if (src.type === 'collection') {
        showToast('A collection cannot be the primary original. Use Match inputs to run on all its images.', 'error');
        return;
      }
      if (isNodeLocked(gen)) {
        showToast('This Generate node is locked or generating, so its primary original cannot change now.', 'error');
        return;
      }
      s.updateNodeData(gen.id, { primaryOriginalNodeId: src.id });
      showToast(`Primary original: ${String(src.data.title)}.`);
    },
    [showToast],
  );

  const onNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: CanvasNode) => {
      e.preventDefault();
      setMenu(null);
      setItemMenu({
        x: e.clientX,
        y: e.clientY,
        title: String(node.data.title || getDefinition(node.type!).label),
        items: [
          {
            label: 'Duplicate',
            onSelect: () => {
              const s = useGraphStore.getState();
              useGraphStore.setState({ nodes: s.nodes.map((n) => ({ ...n, selected: n.id === node.id })) });
              useGraphStore.getState().duplicateSelected();
            },
          },
          {
            label: 'Delete node',
            danger: true,
            disabled: isNodeLocked(node),
            hint: isNodeFrozen(node.id) ? 'Generating: it can be deleted when the run ends' : node.data.locked ? 'Locked nodes cannot be deleted' : undefined,
            onSelect: () => erase({ nodeIds: [node.id] }),
          },
        ],
      });
    },
    [erase],
  );

  const onEdgeContextMenu = useCallback(
    (e: ReactMouseEvent, edge: CanvasEdge) => {
      e.preventDefault();
      setMenu(null);
      setItemMenu({
        x: e.clientX,
        y: e.clientY,
        title: 'Connection',
        items: [
          {
            label: 'Delete connection',
            danger: true,
            disabled: isNodeFrozen(edge.source) || isNodeFrozen(edge.target),
            hint: 'A node on this connection is generating',
            onSelect: () => erase({ edgeIds: [edge.id] }),
          },
        ],
      });
    },
    [erase],
  );

  // Restore this tab's viewport when a project is loaded. A tab that has never opened the project
  // (e.g. another machine) has none: the viewport stored on the server is stale because sync keeps
  // it local, so open on the main cluster of nodes instead.
  useEffect(() => {
    if (!projectId) return;
    let seen = true;
    try { seen = sessionStorage.getItem(`nodecanvas:viewport:${projectId}`) !== null; } catch { /* storage unavailable */ }
    const bounds = seen ? null : mainClusterBounds(useGraphStore.getState().nodes);
    if (bounds) void fitBounds(bounds, { padding: 0.15 });
    else void applyViewport(useGraphStore.getState().viewport);
  }, [projectId, applyViewport, fitBounds]);

  const isValidConnection: IsValidConnection<CanvasEdge> = useCallback(
    (c) => {
      const s = useGraphStore.getState();
      return checkConnection(c as Connection | Edge, s.nodes, s.edges).ok;
    },
    [],
  );

  const onConnectEnd = useCallback(
    (_: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      // Explain why a drop onto a handle was refused instead of failing silently.
      if (state.isValid !== false || !state.fromHandle || !state.toHandle) return;
      const from = state.fromHandle;
      const to = state.toHandle;
      const conn =
        from.type === 'source'
          ? { source: from.nodeId, sourceHandle: from.id ?? null, target: to.nodeId, targetHandle: to.id ?? null }
          : { source: to.nodeId, sourceHandle: to.id ?? null, target: from.nodeId, targetHandle: from.id ?? null };
      const s = useGraphStore.getState();
      const res = checkConnection(conn, s.nodes, s.edges);
      if (!res.ok && res.reason) showToast(res.reason, 'error');
    },
    [showToast],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(DRAG_MIME) && !types.includes(ASSET_DRAG_MIME) && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes(DRAG_MIME) ? 'move' : 'copy';
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const kind = e.dataTransfer.getData(DRAG_MIME);
      if (isNodeKind(kind)) {
        e.preventDefault();
        addNode(kind, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        return;
      }
      const libraryPayload = e.dataTransfer.getData(ASSET_DRAG_MIME);
      if (libraryPayload) {
        e.preventDefault();
        let assets: { id: string; name: string }[] = [];
        try {
          assets = JSON.parse(libraryPayload);
        } catch {
          return;
        }
        if (Array.isArray(assets) && assets.length > 0) {
          const message = placeAssets(assets, dropTarget(e, assets.length));
          if (message) showToast(`${message}.`);
        }
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        e.preventDefault();
        void importImages(files, dropTarget(e, files.filter(isSupportedImage).length));
      }
    },
    [addNode, screenToFlowPosition, importImages, placeAssets, showToast],
  );

  // Paste: images from the clipboard become nodes; otherwise paste copied nodes (spec §3.3).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter(isSupportedImage);
      e.preventDefault();
      // With a Collection Viewer open, pasted images join that collection.
      const viewerNodeId = useAssetStore.getState().viewerNodeId;
      if (viewerNodeId) {
        if (files.length > 0) void importImages(files, { collectionNodeId: viewerNodeId });
        return;
      }
      if (files.length > 0) void importImages(files);
      else useGraphStore.getState().paste();
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importImages]);

  const onNodeDoubleClick = useCallback((_: ReactMouseEvent, node: CanvasNode) => {
    if (node.type === 'collection') {
      useAssetStore.getState().openViewer(node.id);
      return;
    }
    const assetId = (node.data as { assetId?: unknown }).assetId;
    if (typeof assetId === 'string') useAssetStore.getState().setPreview(assetId);
  }, []);

  const openMenuAt = useCallback((clientX: number, clientY: number) => setMenu({ x: clientX, y: clientY }), []);

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('react-flow__pane')) openMenuAt(e.clientX, e.clientY);
    },
    [openMenuAt],
  );

  const pick = useCallback(
    (kind: NodeKind) => {
      if (!menu) return;
      const pos = screenToFlowPosition({ x: menu.x, y: menu.y });
      addNode(kind, pos);
      setMenu(null);
    },
    [menu, addNode, screenToFlowPosition],
  );

  return (
    <div
      ref={wrapper}
      className={`relative h-full w-full tool-${tool}`}
      onDoubleClick={onDoubleClick}
      onPointerDownCapture={(e) => {
        if (tool === 'eraser' && e.button === 0) stroke.current = `erase:${++strokeSeq}`;
      }}
    >
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
        defaultViewport={viewport}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStart={() => commit()}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onNodeClick={(_, node) => {
          if (tool === 'eraser') erase({ nodeIds: [node.id] }, stroke.current ?? undefined);
        }}
        onEdgeClick={(_, edge) => {
          if (tool === 'eraser') {
            erase({ edgeIds: [edge.id] }, stroke.current ?? undefined);
            return;
          }
          chooseAsPrimary(edge.id);
        }}
        onNodeMouseEnter={(_, node) => {
          if (stroke.current) erase({ nodeIds: [node.id] }, stroke.current);
        }}
        onEdgeMouseEnter={(_, edge) => {
          if (stroke.current) erase({ edgeIds: [edge.id] }, stroke.current);
        }}
        nodesDraggable={tool !== 'eraser'}
        nodesConnectable={tool !== 'eraser'}
        elementsSelectable={tool !== 'eraser'}
        onMoveEnd={(_, vp) => setViewport(vp)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          setItemMenu(null);
          openMenuAt(e.clientX, e.clientY);
        }}
        colorMode="light"
        // Shortcuts are handled in useShortcuts so they can be undone and respect focus.
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode="Shift"
        panActivationKeyCode="Space"
        zoomOnDoubleClick={false}
        // Select tool: left-drag on empty canvas draws a selection box (anything it touches is selected).
        // Hand tool: left-drag pans. The middle button (or Space+drag) always pans.
        selectionOnDrag={tool === 'select'}
        selectionMode={SelectionMode.Partial}
        panOnDrag={tool === 'pan' ? [0, 1] : [1]}
        // Dropping a connection near a handle (not exactly on it) still connects.
        connectionRadius={36}
        minZoom={0.1}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#d9cfc2" />
        {/* Two boxes: tools on top, zoom underneath. */}
        <Panel position="bottom-left" className="flex flex-col gap-2">
          <div className="react-flow__controls vertical" role="toolbar" aria-label="Canvas tools">
            {TOOLS.map((t) => (
              <ControlButton
                key={t.id}
                onClick={() => setTool(t.id)}
                title={`${t.label} (${t.key})`}
                aria-label={t.label}
                aria-pressed={tool === t.id}
                className={tool === t.id ? 'tool-active' : undefined}
              >
                {t.icon}
              </ControlButton>
            ))}
          </div>
          <div className="react-flow__controls vertical" role="toolbar" aria-label="Zoom">
            <ControlButton onClick={() => void zoomIn({ duration: 150 })} title="Zoom in (+)" aria-label="Zoom in">
              <svg {...ICON} className="tool-icon" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </ControlButton>
            <ControlButton onClick={() => void zoomOut({ duration: 150 })} title="Zoom out (-)" aria-label="Zoom out">
              <svg {...ICON} className="tool-icon" aria-hidden>
                <path d="M5 12h14" />
              </svg>
            </ControlButton>
            <ControlButton
              onClick={() => void fitView({ padding: 0.2, duration: 200 })}
              title="Fit all (Shift+1)"
              aria-label="Fit all nodes"
            >
              <svg {...ICON} className="tool-icon" aria-hidden>
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              </svg>
            </ControlButton>
          </div>
        </Panel>
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={(n) => (isNodeKind(n.type) ? getDefinition(n.type).color : '#9a948c')}
          maskColor="rgb(247 243 238 / 0.7)"
          style={{ width: 160, height: 110 }}
        />
      </ReactFlow>
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="text-[14px] text-ink-2">Empty canvas</p>
            <p className="mt-1 text-[12px] text-ink-3">
              Drag a node from the sidebar, drop images here, or double-click the canvas to add a node.
            </p>
          </div>
        </div>
      )}
      {menu && <AddNodeMenu x={menu.x} y={menu.y} onPick={pick} onClose={() => setMenu(null)} />}
      {itemMenu && <ContextMenu {...itemMenu} onClose={() => setItemMenu(null)} />}
    </div>
  );
}
