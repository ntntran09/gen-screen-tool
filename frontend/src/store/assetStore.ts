import { create } from 'zustand';
import { api, type AssetInfo } from '../lib/api';

/** Metadata for the current project's assets. Nodes only store asset ids. */
interface AssetState {
  projectId: string | null;
  assets: Record<string, AssetInfo>;
  load: (projectId: string) => Promise<void>;
  upsert: (items: AssetInfo[]) => void;
  rename: (id: string, name: string) => Promise<void>;
  /** Delete assets from the library (files go to backups). Returns the ids actually deleted. */
  remove: (ids: string[]) => Promise<string[]>;
  /** Fetch one asset's metadata (e.g. a newly generated image) unless it is already known. */
  refresh: (id: string) => Promise<void>;
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

  remove: async (ids) => {
    const projectId = get().projectId;
    if (!projectId) return [];
    const { deleted } = await api.deleteAssets(projectId, ids);
    if (get().projectId === projectId) {
      const gone = new Set(ids);
      set((s) => ({ assets: Object.fromEntries(Object.entries(s.assets).filter(([id]) => !gone.has(id))) }));
    }
    return deleted;
  },

  refresh: async (id) => {
    const projectId = get().projectId;
    if (get().assets[id]) return;
    try {
      const asset = await api.getAsset(id);
      if (get().projectId === projectId) get().upsert([asset]);
    } catch {
      /* the thumbnail still loads by id; metadata will come with the next full load */
    }
  },

  rename: async (id, name) => {
    const updated = await api.renameAsset(id, name);
    get().upsert([updated]);
  },
}));
