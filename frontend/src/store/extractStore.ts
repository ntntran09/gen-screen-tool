import { create } from 'zustand';
import { sourceAssetFor } from '../graph/detect';
import type { ExtractData } from '../graph/types';
import { api } from '../lib/api';
import { useGraphStore } from './graphStore';

type Busy = 'detect' | 'crop';

interface ExtractState {
  /** Extract nodes with a request in flight (transient). */
  busy: Record<string, Busy | undefined>;
  error: Record<string, string | undefined>;
  build: (nodeId: string) => Promise<void>;
  detect: (nodeId: string) => Promise<void>;
}

const dataOf = (nodeId: string) => useGraphStore.getState().nodes.find((n) => n.id === nodeId)?.data as ExtractData | undefined;

export const useExtractStore = create<ExtractState>()((set, get) => {
  const run = async (nodeId: string, kind: Busy, work: () => Promise<void>) => {
    if (get().busy[nodeId]) return;
    set((s) => ({ busy: { ...s.busy, [nodeId]: kind }, error: { ...s.error, [nodeId]: undefined } }));
    try {
      await work();
    } catch (err) {
      set((s) => ({ error: { ...s.error, [nodeId]: (err as Error).message } }));
    } finally {
      set((s) => ({ busy: { ...s.busy, [nodeId]: undefined } }));
    }
  };

  return {
    busy: {},
    error: {},

    build: (nodeId) => run(nodeId, 'crop', async () => {
      const result = await useGraphStore.getState().addExtractionWorkflow(nodeId);
      if (result) useGraphStore.getState().showToast(`Cropped ${result.count} assets. Press Generate to remove their backgrounds.`);
    }),

    detect: (nodeId) =>
      run(nodeId, 'detect', async () => {
        const { nodes, edges } = useGraphStore.getState();
        const assetId = sourceAssetFor(nodes, edges, nodeId);
        if (!assetId) throw new Error('Connect an Image with a picture to the Image port first.');
        const providers = await api.listProviders();
        const provider = providers.find((p) => p.auth_state === 'connected')?.id;
        if (!provider) throw new Error('Connect ChatGPT first (the Codex button in the top bar).');
        const hint = dataOf(nodeId)?.hint ?? '';
        const r = await api.detectAssets(assetId, provider, hint, dataOf(nodeId)?.model ?? '', dataOf(nodeId)?.effort ?? '');
        useGraphStore.getState().updateNodeData(nodeId, {
          detections: { assetId, model: r.model, seconds: r.elapsed_seconds, items: r.assets },
          off: [],
        });
        if (r.assets.length === 0) throw new Error('The model found no separate assets in this image.');
      }),
  };
});
