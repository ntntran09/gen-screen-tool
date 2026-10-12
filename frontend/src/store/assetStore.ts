import { create } from 'zustand';
import { api, type AssetInfo } from '../lib/api';

/** Metadata for the current project's assets. Nodes only store asset ids. */
interface AssetState {
  projectId: string | null;
  assets: Record<string, AssetInfo>;
  load: (projectId: string) => Promise<void>;
  upsert: (items: AssetInfo[]) => void;
  rename: (id: string, name: string) => Promise<void>;
  /** Asset shown in the full-size viewer, if any. */
  previewId: string | null;
  setPreview: (id: string | null) => void;
  /** Collection node whose viewer is open, if any. */
  viewerNodeId: string | null;
  openViewer: (nodeId: string | null) => void;
}

export const useAssetStore = create<AssetState>()((set, get) => ({
  projectId: null,
  assets: {},
  previewId: null,
  setPreview: (previewId) => set({ previewId }),
  viewerNodeId: null,
  openViewer: (viewerNodeId) => set({ viewerNodeId }),

  load: async (projectId) => {
    set({ projectId, assets: {}, previewId: null, viewerNodeId: null });
    const list = await api.listAssets(projectId);
    if (get().projectId !== projectId) return; // another project was opened meanwhile
    set({ assets: Object.fromEntries(list.map((a) => [a.id, a])) });
  },

  upsert: (items) => set((s) => ({ assets: { ...s.assets, ...Object.fromEntries(items.map((a) => [a.id, a])) } })),

  rename: async (id, name) => {
    const updated = await api.renameAsset(id, name);
    get().upsert([updated]);
  },
}));
