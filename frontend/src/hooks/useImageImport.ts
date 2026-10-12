import { useReactFlow, type XYPosition } from '@xyflow/react';
import { useCallback } from 'react';
import { collectionItems, makeItems } from '../graph/collections';
import { findFreeSpot } from '../graph/layout';
import { api, type AssetInfo } from '../lib/api';
import { useAssetStore } from '../store/assetStore';
import { useGraphStore } from '../store/graphStore';

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const GRID_COLUMNS = 4;
const GRID_DX = 230;
const GRID_DY = 290;

export function isSupportedImage(file: File) {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || IMAGE_RE.test(file.name);
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '') || name;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface ImportTarget {
  /** Screen position where new nodes start (drop point). */
  screen?: XYPosition;
  /** Put the first image into this existing node instead of creating nodes. */
  replaceNodeId?: string;
  /** Append the images to this collection node. */
  collectionNodeId?: string;
  /** Two or more images become one Input Collection (default) instead of separate nodes. */
  group?: boolean;
  /** false: only store the files (Library import), leave the canvas alone. */
  place?: boolean;
}

type PlacedAsset = Pick<AssetInfo, 'id' | 'name'>;

/**
 * Put already-stored assets on the canvas: into a node, into a collection,
 * as one new collection, or as separate Image nodes (spec §6.4, §22.2).
 * Returns a short description of what happened.
 */
export function useAssetPlacement() {
  const { screenToFlowPosition } = useReactFlow();

  return useCallback(
    (assets: PlacedAsset[], target: ImportTarget = {}): string => {
      const store = useGraphStore.getState();
      if (assets.length === 0 || target.place === false) return '';

      if (target.replaceNodeId) {
        store.updateNodeData(target.replaceNodeId, { assetId: assets[0].id });
        return assets.length > 1 ? 'Only the first image was used' : 'Image replaced';
      }

      if (target.collectionNodeId) {
        const node = store.nodes.find((n) => n.id === target.collectionNodeId);
        if (node) {
          store.setCollectionItems(node.id, [...collectionItems(node), ...makeItems(assets.map((a) => a.id))]);
          return `Added ${plural(assets.length, 'image')} to ${node.data.title}`;
        }
      }

      const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
      const screen =
        target.screen ?? (pane ? { x: pane.left + pane.width / 2 - 100, y: pane.top + pane.height / 2 - 120 } : { x: 400, y: 300 });
      // An explicit drop point is honoured; otherwise (paste, buttons) avoid landing on existing nodes.
      const origin = target.screen ? screenToFlowPosition(screen) : findFreeSpot(screenToFlowPosition(screen), store.nodes);

      if (assets.length > 1 && target.group !== false) {
        store.addNode('collection', origin, { items: makeItems(assets.map((a) => a.id)) });
        return `Created a collection of ${plural(assets.length, 'image')}`;
      }
      store.addNodes(
        assets.map((a, i) => ({
          kind: 'image' as const,
          position: {
            x: origin.x + (i % GRID_COLUMNS) * GRID_DX,
            y: origin.y + Math.floor(i / GRID_COLUMNS) * GRID_DY,
          },
          data: { assetId: a.id, title: stem(a.name) },
        })),
      );
      return `Added ${plural(assets.length, 'image node')}`;
    },
    [screenToFlowPosition],
  );
}

/** Upload image files, then place them (see useAssetPlacement). */
export function useImageImport() {
  const placeAssets = useAssetPlacement();

  return useCallback(
    async (files: File[], target: ImportTarget = {}) => {
      const graph = useGraphStore.getState();
      const projectId = graph.projectId;
      if (!projectId || files.length === 0) return;

      const images = files.filter(isSupportedImage);
      const skipped = files.length - images.length;
      if (images.length === 0) {
        graph.showToast('Only PNG, JPG and WebP images can be imported.', 'error');
        return;
      }
      const toImport = target.replaceNodeId ? images.slice(0, 1) : images;
      graph.showToast(`Importing ${plural(toImport.length, 'image')}…`);

      let result;
      try {
        result = await api.importAssets(projectId, toImport);
      } catch (err) {
        useGraphStore.getState().showToast((err as Error).message, 'error');
        return;
      }
      // The user may have switched project while uploading; don't drop nodes into the wrong one.
      if (useGraphStore.getState().projectId !== projectId) return;
      useAssetStore.getState().upsert(result.imported);

      const placed = placeAssets(result.imported, target);
      const problems = [
        ...result.errors.map((e) => `${e.filename || 'image'}: ${e.message}`),
        ...(skipped > 0 ? [`${skipped} file(s) skipped: not PNG, JPG or WebP`] : []),
        ...(target.replaceNodeId && images.length > 1 ? ['Only the first image was used'] : []),
      ];
      const store = useGraphStore.getState();
      if (problems.length > 0) {
        store.showToast([placed, ...problems].filter(Boolean).join(' · '), result.imported.length ? 'info' : 'error');
      } else {
        store.showToast(`Imported ${plural(result.imported.length, 'image')}.${placed && target.replaceNodeId === undefined ? ` ${placed}.` : ''}`);
      }
    },
    [placeAssets],
  );
}
