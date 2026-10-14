import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentDetections, sourceAssetFor } from '../graph/detect';
import { OUT } from '../graph/registry';
import type { ExtractData } from '../graph/types';
import { api } from '../lib/api';
import { useExtractStore } from './extractStore';
import { useGraphStore } from './graphStore';

const g = () => useGraphStore.getState();
const data = (id: string) => g().nodes.find((n) => n.id === id)!.data as ExtractData;

beforeEach(() => {
  vi.restoreAllMocks();
  g().loadProject({
    id: 'p',
    name: 'T',
    description: '',
    created_at: '',
    updated_at: '',
    graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  });
  useExtractStore.setState({ busy: {}, error: {} });
});

function setup(assetId: string | null = 'screen') {
  const img = g().addNode('image', { x: 0, y: 0 }, { assetId });
  const ex = g().addNode('extract', { x: 300, y: 0 });
  g().connect({ source: img, sourceHandle: OUT, target: ex, targetHandle: 'image' });
  return { img, ex };
}

const found = [
  { name: 'pot', description: 'a pot', x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
  { name: 'pot', description: 'another pot', x: 0.5, y: 0.1, w: 0.3, h: 0.3 },
  { name: 'cat', description: 'a cat', x: 0.1, y: 0.6, w: 0.3, h: 0.3 },
];

const connected = [{ id: 'codex', name: 'C', experimental: true, may_consume_quota: true, auth_state: 'connected' }];

describe('extract store', () => {
  it('finds the connected image, stores the boxes, and follows a replaced image', async () => {
    const { img, ex } = setup();
    vi.spyOn(api, 'listProviders').mockResolvedValue(connected);
    const spy = vi.spyOn(api, 'detectAssets').mockResolvedValue({ asset_id: 'screen', model: 'gpt-6-luna', elapsed_seconds: 7, assets: found });
    g().updateNodeData(ex, { hint: 'pots', off: [2] });
    await useExtractStore.getState().detect(ex);
    expect(spy).toHaveBeenCalledWith('screen', 'codex', 'pots', '', '');
    expect(data(ex).detections).toMatchObject({ assetId: 'screen', model: 'gpt-6-luna' });
    expect(data(ex).off).toEqual([]); // a new search starts with everything ticked
    g().updateNodeData(ex, { model: 'gpt-6.1-sol', effort: 'high' });
    await useExtractStore.getState().detect(ex);
    expect(spy).toHaveBeenLastCalledWith('screen', 'codex', 'pots', 'gpt-6.1-sol', 'high');
    expect(currentDetections(data(ex), sourceAssetFor(g().nodes, g().edges, ex))?.items).toHaveLength(3);
    g().updateNodeData(img, { assetId: 'other' });
    expect(currentDetections(data(ex), sourceAssetFor(g().nodes, g().edges, ex))).toBeNull(); // stale: the image changed
  });

  it('explains what is missing instead of failing silently', async () => {
    const { ex } = setup(null);
    await useExtractStore.getState().detect(ex);
    expect(useExtractStore.getState().error[ex]).toMatch(/Connect an Image/);

    const spy = vi.spyOn(api, 'listProviders').mockResolvedValue([]);
    const withImage = setup('screen').ex;
    await useExtractStore.getState().detect(withImage);
    expect(spy).toHaveBeenCalled();
    expect(useExtractStore.getState().error[withImage]).toMatch(/Connect ChatGPT/);
    expect(useExtractStore.getState().busy[withImage]).toBeUndefined(); // never left "busy"
  });

  it('says so when the model finds nothing, and clears the error on the next try', async () => {
    const { ex } = setup();
    vi.spyOn(api, 'listProviders').mockResolvedValue(connected);
    const spy = vi.spyOn(api, 'detectAssets').mockResolvedValueOnce({ asset_id: 'screen', model: 'm', elapsed_seconds: 1, assets: [] });
    await useExtractStore.getState().detect(ex);
    expect(useExtractStore.getState().error[ex]).toMatch(/found no separate assets/);
    spy.mockResolvedValueOnce({ asset_id: 'screen', model: 'm', elapsed_seconds: 1, assets: found });
    await useExtractStore.getState().detect(ex);
    expect(useExtractStore.getState().error[ex]).toBeUndefined();
  });
  it('Build reports crop errors and prevents duplicate requests', async () => {
    const { ex } = setup();
    let reject!: (error: Error) => void;
    const spy = vi.spyOn(g(), 'addExtractionWorkflow').mockReturnValue(new Promise((_, no) => { reject = no; }));
    const pending = useExtractStore.getState().build(ex);
    expect(useExtractStore.getState().busy[ex]).toBe('crop');
    await useExtractStore.getState().build(ex);
    expect(spy).toHaveBeenCalledTimes(1);
    reject(new Error('Image missing'));
    await pending;
    expect(useExtractStore.getState().error[ex]).toBe('Image missing');
    expect(useExtractStore.getState().busy[ex]).toBeUndefined();
  });

});
