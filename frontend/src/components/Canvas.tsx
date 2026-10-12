import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  SelectionMode,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type IsValidConnection,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { getDefinition, isNodeKind } from '../graph/registry';
import type { CanvasEdge, CanvasNode, CollectionData, NodeKind } from '../graph/types';
import { checkConnection } from '../graph/validation';
import { nodeTypes } from '../nodes/nodeTypes';
import { useGraphStore } from '../store/graphStore';
import { isSupportedImage, useAssetPlacement, useImageImport, type ImportTarget } from '../hooks/useImageImport';
import { isTypingTarget } from '../hooks/useShortcuts';
import { useAssetStore } from '../store/assetStore';
import { AddNodeMenu } from './AddNodeMenu';

export const DRAG_MIME = 'application/x-nodecanvas-node';
/** Library drag payload: JSON array of { id, name } for stored assets. */
export const ASSET_DRAG_MIME = 'application/x-nodecanvas-assets';

/** Where dropped images go, decided by the node under the pointer (spec §6.4). */
function dropTarget(e: DragEvent, count: number): ImportTarget {
  const nodeId = (e.target as HTMLElement).closest<HTMLElement>('.react-flow__node')?.dataset.id;
  const node = nodeId ? useGraphStore.getState().nodes.find((n) => n.id === nodeId) : undefined;
  if (node && !node.data.locked) {
    if (node.type === 'collection' && (node.data as CollectionData).role === 'input') return { collectionNodeId: node.id };
    // Dropping a single image onto an image node replaces it; several images start a new group instead.
    if (count === 1 && ['image', 'original', 'theme'].includes(node.type!)) return { replaceNodeId: node.id };
  }
  // Alt keeps separate nodes; otherwise several images become one collection.
  return { screen: { x: e.clientX, y: e.clientY }, group: !e.altKey };
}

export function Canvas() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const viewport = useGraphStore((s) => s.viewport);
  const projectId = useGraphStore((s) => s.projectId);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const connect = useGraphStore((s) => s.connect);
  const addNode = useGraphStore((s) => s.addNode);
  const commit = useGraphStore((s) => s.commit);
  const setViewport = useGraphStore((s) => s.setViewport);
  const showToast = useGraphStore((s) => s.showToast);
  const { screenToFlowPosition, setViewport: applyViewport } = useReactFlow();
  const importImages = useImageImport();
  const placeAssets = useAssetPlacement();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  // Restore the saved viewport whenever a different project is loaded.
  useEffect(() => {
    if (projectId) void applyViewport(useGraphStore.getState().viewport);
  }, [projectId, applyViewport]);

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
    <div ref={wrapper} className="relative h-full w-full" onDoubleClick={onDoubleClick}>
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={viewport}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStart={() => commit()}
        onNodeDoubleClick={onNodeDoubleClick}
        onMoveEnd={(_, vp) => setViewport(vp)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          openMenuAt(e.clientX, e.clientY);
        }}
        colorMode="light"
        // Shortcuts are handled in useShortcuts so they can be undone and respect focus.
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode="Shift"
        panActivationKeyCode="Space"
        zoomOnDoubleClick={false}
        // Left-drag on empty canvas draws a selection box; anything it touches is selected.
        // The middle button (or Space+drag) pans.
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1]}
        minZoom={0.1}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#d9cfc2" />
        <Controls showInteractive={false} position="bottom-left" />
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
    </div>
  );
}
