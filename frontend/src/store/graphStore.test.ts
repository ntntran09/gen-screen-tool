import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OUT } from '../graph/registry';
import type { CollectionData } from '../graph/types';
import { api, toGraphPayload, toInlineGenerationPayload, type AssetInfo } from '../lib/api';
import { EXTRACT_PROMPT } from './graphStore';
import { useGraphStore } from './graphStore';

const s = () => useGraphStore.getState();

function select(ids: string[]) {
  useGraphStore.setState({ nodes: s().nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })) });
}

beforeEach(() => {
  s().setTool('select');
  s().loadProject({
    id: 'p',
    name: 'Test',
    description: '',
    created_at: '',
    updated_at: '',
    graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  });
});

describe('graph store', () => {
  it('does not move a drawing when an eraser drag emits a node position change', () => {
    const id = s().addNode('drawing', { x: 40, y: 50 }, { points: [{ x: 3, y: 3 }, { x: 30, y: 20 }] });
    s().setTool('eraser');
    s().onNodesChange([{ type: 'position', id, position: { x: 400, y: 500 }, dragging: true }]);
    expect(s().nodes.find((n) => n.id === id)?.position).toEqual({ x: 40, y: 50 });
    s().setTool('select');
    s().onNodesChange([{ type: 'position', id, position: { x: 400, y: 500 }, dragging: true }]);
    expect(s().nodes.find((n) => n.id === id)?.position).toEqual({ x: 400, y: 500 });
  });
  it('resizes text horizontally while keeping height automatic through persistence and undo', () => {
    const id = s().addNode('text', { x: 0, y: 0 }, { text: 'A wrapping comment', comment: true });
    s().commit();
    s().onNodesChange([{ type: 'dimensions', id, dimensions: { width: 140, height: 300 }, setAttributes: true }]);
    expect(s().nodes.find((n) => n.id === id)?.width).toBe(140);
    expect(s().nodes.find((n) => n.id === id)?.height).toBeUndefined();
    expect(toGraphPayload(s().nodes, s().edges, s().viewport).nodes[0]).toMatchObject({ width: 140, height: null });
    s().undo();
    expect(s().nodes.find((n) => n.id === id)?.width).toBeUndefined();
  });
  it('saves annotations and reuses the eraser with undo/redo', () => {
    const text = s().addNode('text', { x: 20, y: 30 }, { text: 'Review this', color: '#4c8df6' });
    const drawing = s().addNode('drawing', { x: 40, y: 50 }, { points: [{ x: 3, y: 3 }, { x: 30, y: 20 }], canvasWidth: 33, canvasHeight: 23 });
    const saved = toGraphPayload(s().nodes, s().edges, s().viewport);
    expect(saved.nodes.map((n) => n.type)).toEqual(['text', 'drawing']);
    expect(s().eraseItems({ nodeIds: [text, drawing] })).toBe(0);
    expect(s().nodes).toHaveLength(0);
    s().undo();
    expect(s().nodes.map((n) => n.id)).toEqual([text, drawing]);
    s().redo();
    expect(s().nodes).toHaveLength(0);
  });
  it('creates only a directly connected result and stores the inline prompt on its source', () => {
    const source = s().addNode('output', { x: 0, y: 0 }, { assetId: 'result' });
    const generate = s().placeInlineResult(source, 'result', 'Change only the background', 'new-batch', { providerId: 'fake' });
    expect(generate).toBeTruthy();
    expect(s().nodes).toHaveLength(2);
    expect(s().nodes.every((n) => n.type === 'output')).toBe(true);
    expect(s().edges[0]).toMatchObject({ source, target: s().nodes[1].id, targetHandle: 'edit' });
    expect(s().nodes[0].data.inlineGeneration).toMatchObject({ prompt: 'Change only the background', batchIds: ['new-batch'] });
    s().undo();
    expect(s().nodes).toHaveLength(1);
    expect(s().edges).toHaveLength(0);
    s().redo();
    expect(s().edges).toHaveLength(1);
  });

  it('references only the selected collection asset without placing helper nodes', () => {
    const source = s().addNode('collection', { x: 0, y: 0 }, { role: 'output', items: [
      { id: 'a', assetId: 'a', enabled: true, promptOverride: '' },
      { id: 'b', assetId: 'b', enabled: true, promptOverride: '' },
    ] });
    s().placeInlineResult(source, 'b', 'Make it pink', 'new-batch');
    expect(s().nodes).toHaveLength(2);
    expect(s().nodes[0].data.inlineGeneration?.assetId).toBe('b');
    expect(s().nodes.some((n) => n.type === 'image' || n.type === 'generate' || n.type === 'prompt')).toBe(false);
    const snapshot = toInlineGenerationPayload(toGraphPayload(s().nodes, s().edges, s().viewport), source);
    expect(snapshot.nodes.find((n) => n.type === 'image')?.data.assetId).toBe('b');
    expect(s().nodes).toHaveLength(2);
  });

  it('a copied inline control gets independent history and identity', () => {
    const source = s().addNode('output', { x: 0, y: 0 }, { assetId: 'result' });
    const id = s().placeInlineResult(source, 'result', 'Make it pink', 'batch');
    select([source]);
    s().copySelected();
    s().paste();
    const copy = s().nodes.find((n) => n.selected)!;
    expect(copy.data.inlineGeneration?.id).not.toBe(id);
    expect(copy.data.inlineGeneration?.batchIds).toEqual([]);
    expect(copy.data.inlineGeneration?.prompt).toBe('Make it pink');
  });

  it('expands selected outputs without removing collection contents; one undo step', () => {
    const id = s().addNode('collection', { x: 0, y: 0 }, { role: 'output', items: [
      { id: 'a', assetId: 'asset-a', enabled: false, promptOverride: '' },
      { id: 'b', assetId: 'asset-b', enabled: true, promptOverride: '' },
    ] });
    s().expandCollection(id, ['a']);
    expect(s().nodes).toHaveLength(2);
    expect(s().nodes[1].data.assetId).toBe('asset-a');
    expect((s().nodes[0].data as CollectionData).items).toHaveLength(2);
    s().undo();
    expect(s().nodes).toHaveLength(1);
  });

  it('refuses collection edits and expansion when locked', () => {
    const id = s().addNode('collection', { x: 0, y: 0 }, { locked: true });
    s().setCollectionItems(id, [{ id: 'a', assetId: 'a', enabled: true, promptOverride: '' }]);
    s().expandCollection(id);
    expect(s().nodes).toHaveLength(1);
    expect((s().nodes[0].data as CollectionData).items).toHaveLength(0);
  });
  it('adds nodes with default data and undoes/redoes', () => {
    const id = s().addNode('prompt', { x: 10, y: 20 });
    expect(s().nodes).toHaveLength(1);
    expect(s().nodes[0].data.title).toBe('Prompt');
    s().undo();
    expect(s().nodes).toHaveLength(0);
    s().redo();
    expect(s().nodes[0].id).toBe(id);
  });

  it('rejects invalid connections and reports why', () => {
    const p = s().addNode('prompt', { x: 0, y: 0 });
    const g = s().addNode('generate', { x: 300, y: 0 });
    s().connect({ source: p, sourceHandle: OUT, target: g, targetHandle: 'palette' });
    expect(s().edges).toHaveLength(0);
    expect(s().toast?.tone).toBe('error');
    s().connect({ source: p, sourceHandle: OUT, target: g, targetHandle: 'prompt' });
    expect(s().edges).toHaveLength(1);
  });

  it('copy/paste clones nodes and internal edges with new ids', () => {
    const p = s().addNode('prompt', { x: 0, y: 0 });
    const g = s().addNode('generate', { x: 300, y: 0 });
    s().connect({ source: p, sourceHandle: OUT, target: g, targetHandle: 'prompt' });
    select([p, g]);
    s().copySelected();
    s().paste();
    expect(s().nodes).toHaveLength(4);
    expect(s().edges).toHaveLength(2);
    const pasted = s().nodes.filter((n) => n.selected);
    expect(pasted.map((n) => n.id)).not.toContain(p);
    expect(pasted[0].position).toEqual({ x: 40, y: 40 });
  });

  it('does not delete locked nodes', () => {
    const a = s().addNode('prompt', { x: 0, y: 0 });
    const b = s().addNode('palette', { x: 0, y: 0 });
    s().updateNodeData(a, { locked: true });
    expect(s().nodes.find((n) => n.id === a)?.draggable).toBe(false);
    select([a, b]);
    s().deleteSelected();
    expect(s().nodes.map((n) => n.id)).toEqual([a]);
  });

  it('deleting a node removes its edges, and undo restores both', () => {
    const p = s().addNode('prompt', { x: 0, y: 0 });
    const g = s().addNode('generate', { x: 300, y: 0 });
    s().connect({ source: p, sourceHandle: OUT, target: g, targetHandle: 'prompt' });
    select([p]);
    s().deleteSelected();
    expect(s().edges).toHaveLength(0);
    s().undo();
    expect(s().nodes).toHaveLength(2);
    expect(s().edges).toHaveLength(1);
  });

  it('coalesces rapid edits to the same field into one undo step', () => {
    const p = s().addNode('prompt', { x: 0, y: 0 });
    s().updateNodeData(p, { text: 'a' });
    s().updateNodeData(p, { text: 'ab' });
    s().updateNodeData(p, { text: 'abc' });
    s().undo();
    expect((s().nodes[0].data as { text: string }).text).toBe('');
  });

  it('switching a collection to input drops its incoming generated edge', () => {
    const g = s().addNode('generate', { x: 0, y: 0 });
    const c = s().addNode('collection', { x: 300, y: 0 });
    s().updateNodeData(c, { role: 'output' });
    s().connect({ source: g, sourceHandle: OUT, target: c, targetHandle: 'in' });
    expect(s().edges).toHaveLength(1);
    s().updateNodeData(c, { role: 'input' });
    expect(s().edges).toHaveLength(0);
  });
});

describe('palette from an image', () => {
  it('fills the palette when an image is connected, and follows a replaced image', async () => {
    const spy = vi.spyOn(api, 'assetPalette').mockImplementation(async (id) => ({
      colors: id === 'a1' ? [{ hex: '#FF0000', share: 70 }, { hex: '#0000FF', share: 30 }] : [{ hex: '#00FF00', share: 100 }],
    }));
    const img = s().addNode('image', { x: 0, y: 0 }, { assetId: 'a1' });
    const pal = s().addNode('palette', { x: 300, y: 0 });
    s().connect({ source: img, sourceHandle: OUT, target: pal, targetHandle: 'image' });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('a1', 5));
    const colors = () => (s().nodes.find((n) => n.id === pal)!.data as { colors: { hex: string; role: string; ratio: number }[] }).colors;
    await vi.waitFor(() => expect(colors().map((c) => c.hex)).toEqual(['#FF0000', '#0000FF']));
    expect(colors().map((c) => [c.role, c.ratio])).toEqual([['primary', 70], ['secondary', 30]]);

    s().updateNodeData(img, { assetId: 'a2' });
    await vi.waitFor(() => expect(colors().map((c) => c.hex)).toEqual(['#00FF00']));
    spy.mockRestore();
  });

  it('does nothing for an empty image node', async () => {
    const spy = vi.spyOn(api, 'assetPalette');
    const img = s().addNode('image', { x: 0, y: 0 });
    const pal = s().addNode('palette', { x: 300, y: 0 });
    s().connect({ source: img, sourceHandle: OUT, target: pal, targetHandle: 'image' });
    expect(await s().extractPalette(pal)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('extraction workflow', () => {
  const boxes = [
    { name: 'blue pot', description: 'a pot with {blue} flowers', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    { name: 'pause button', description: 'round', x: 0.8, y: 0.0, w: 0.1, h: 0.05 },
    { name: 'cat', description: 'orange cat', x: 0.0, y: 0.85, w: 0.2, h: 0.15 },
  ];
  /** An Image with a picture -> Extract node that has already "found" the boxes. */
  const found = (off: number[] = []) => {
    const src = s().addNode('image', { x: 0, y: 0 }, { assetId: 'screen' });
    const ex = s().addNode('extract', { x: 300, y: 0 });
    s().connect({ source: src, sourceHandle: OUT, target: ex, targetHandle: 'image' });
    s().updateNodeData(ex, { detections: { assetId: 'screen', model: 'm', seconds: 1, items: boxes }, off });
    return { src, ex };
  };
  const get = (id: string) => s().nodes.find((n) => n.id === id)!;
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'cropAssets').mockImplementation(async (_id, boxes) => ({
      assets: boxes.map((box, i) => ({ id: `crop-${i}-${box.name}`, name: `${box.name}.png` }) as AssetInfo),
    }));
  });

  it('crops ticked boxes into a collection and queues one background removal per crop', async () => {
    const { ex } = found([1]);
    const before = s().nodes.length;
    const made = (await s().addExtractionWorkflow(ex))!;
    expect(api.cropAssets).toHaveBeenCalledWith('screen', [
      { name: 'blue pot', x: .1, y: .1, w: .2, h: .2 },
      { name: 'cat', x: 0, y: .85, w: .2, h: .15 },
    ]);
    expect(s().nodes).toHaveLength(before + 3);
    expect((get(made.collection).data as CollectionData).items.map((i) => i.assetId)).toEqual(['crop-0-blue pot', 'crop-1-cat']);
    expect(get(made.prompt!).data.text).toBe(EXTRACT_PROMPT);
    const cropItems = (get(made.collection).data as CollectionData).items;
    expect(cropItems[0].promptOverride).toContain('Target asset: "blue pot"');
    expect(cropItems[0].promptOverride).toContain('a pot with blue flowers');
    expect(cropItems[0].promptOverride).not.toMatch(/[{}]/);
    expect(cropItems[1].promptOverride).toContain('Target asset: "cat"');
    expect(get(made.generate).data).toMatchObject({ preset: 'assets', mode: 'match', variantsPerInput: 1, aspectRatio: 'match' });
    expect(s().edges.map((e) => [e.source, e.target, e.targetHandle])).toEqual(expect.arrayContaining([
      [ex, made.collection, 'extract'], [made.collection, made.generate, 'original'], [made.prompt, made.generate, 'prompt'],
    ]));
    s().undo();
    expect(s().nodes).toHaveLength(before);
    expect(get(ex).data.collectionNodeId).toBeNull();
  });

  it('reuses collection and Generate while preserving edited art direction', async () => {
    const { ex } = found();
    const first = (await s().addExtractionWorkflow(ex))!;
    const count = s().nodes.length;
    s().updateNodeData(first.prompt!, { text: 'Remove bg, keep shadows.' });
    s().updateNodeData(ex, { off: [0, 1] });
    const again = (await s().addExtractionWorkflow(ex))!;
    expect(again).toMatchObject({ collection: first.collection, generate: first.generate, created: false });
    expect(s().nodes).toHaveLength(count);
    expect((get(first.collection).data as CollectionData).items).toHaveLength(1);
    expect(get(first.prompt!).data.text).toBe('Remove bg, keep shadows.');
  });

  it('refreshes the previously generated default removal prompt', async () => {
    const { ex } = found();
    const made = (await s().addExtractionWorkflow(ex))!;
    s().updateNodeData(made.prompt!, { text: 'Remove the background from this cropped asset. Keep only the main asset on a transparent background. Preserve its original art style, colors, shape, proportions, details and integral text. Do not restyle, add other objects or create multiple copies. Return one isolated asset.' });
    await s().addExtractionWorkflow(ex);
    expect(get(made.prompt!).data.text).toBe(EXTRACT_PROMPT);
  });

  it('refuses stale, empty, locked and frozen workflows without cropping', async () => {
    const { ex, src } = found([0, 1, 2]);
    expect(await s().addExtractionWorkflow(ex)).toBeNull();
    s().updateNodeData(ex, { off: [] });
    const made = (await s().addExtractionWorkflow(ex))!;
    vi.mocked(api.cropAssets).mockClear();
    s().updateNodeData(made.collection, { locked: true });
    expect(await s().addExtractionWorkflow(ex)).toBeNull();
    s().updateNodeData(made.collection, { locked: false });
    s().setFrozen([made.generate]);
    expect(await s().addExtractionWorkflow(ex)).toBeNull();
    s().setFrozen([]);
    s().updateNodeData(src, { assetId: 'changed' });
    expect(await s().addExtractionWorkflow(ex)).toBeNull();
    expect(api.cropAssets).not.toHaveBeenCalled();
  });

  it('does not overwrite the canvas after an image or project changes during cropping', async () => {
    const { ex, src } = found();
    let finish!: (value: { assets: AssetInfo[] }) => void;
    vi.mocked(api.cropAssets).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = s().addExtractionWorkflow(ex);
    s().updateNodeData(src, { assetId: 'changed' });
    finish({ assets: [{ id: 'late' } as AssetInfo] });
    expect(await pending).toBeNull();
    expect(s().nodes).toHaveLength(2);
    s().updateNodeData(src, { assetId: 'screen' });
    const next = s().addExtractionWorkflow(ex);
    useGraphStore.setState({ projectId: 'other-project', nodes: [], edges: [] });
    finish({ assets: [{ id: 'late' } as AssetInfo] });
    expect(await next).toBeNull();
    expect(s().nodes).toHaveLength(0);
  });

  it('crop failures leave the graph unchanged', async () => {
    const { ex } = found();
    const before = s().nodes;
    vi.mocked(api.cropAssets).mockRejectedValue(new Error('Source missing'));
    await expect(s().addExtractionWorkflow(ex)).rejects.toThrow('Source missing');
    expect(s().nodes).toBe(before);
  });

  it('copied workflows keep their own collection and Generate references', async () => {
    const { ex, src } = found();
    const made = (await s().addExtractionWorkflow(ex))!;
    select([ex, src, made.collection, made.prompt!, made.generate]);
    s().copySelected(); s().paste();
    const copied = s().nodes.filter((n) => n.selected);
    const copiedExtract = copied.find((n) => n.type === 'extract')!;
    const copiedCollection = copied.find((n) => n.type === 'collection')!;
    expect(copiedExtract.data.collectionNodeId).toBe(copiedCollection.id);
    expect(copiedExtract.data.generateNodeId).toBe(copied.find((n) => n.type === 'generate')!.id);
    s().updateNodeData(copiedExtract.id, { off: [0, 1] });
    await s().addExtractionWorkflow(copiedExtract.id);
    expect((get(copiedCollection.id).data as CollectionData).items).toHaveLength(1);
    expect((get(made.collection).data as CollectionData).items).toHaveLength(3);
  });
});

describe('one-connection ports', () => {
  it('a new connection replaces the old one, in one undo step', () => {
    const a = s().addNode('palette', { x: 0, y: 0 });
    const b = s().addNode('palette', { x: 0, y: 200 });
    const g = s().addNode('generate', { x: 400, y: 0 });
    s().connect({ source: a, sourceHandle: OUT, target: g, targetHandle: 'palette' });
    s().connect({ source: b, sourceHandle: OUT, target: g, targetHandle: 'palette' });
    expect(s().edges).toEqual([expect.objectContaining({ source: b, target: g, targetHandle: 'palette' })]);
    expect(s().toast?.message).toMatch(/Replaced/);
    s().undo();
    expect(s().edges).toEqual([expect.objectContaining({ source: a, target: g })]);
  });

  it('keeps a connection that a running generation is using', () => {
    const g = s().addNode('generate', { x: 0, y: 0 });
    const out = s().addNode('output', { x: 300, y: 0 });
    const g2 = s().addNode('generate', { x: 0, y: 300 });
    s().connect({ source: g, sourceHandle: OUT, target: out, targetHandle: 'in' });
    s().setFrozen([g]);
    s().connect({ source: g2, sourceHandle: OUT, target: out, targetHandle: 'in' });
    expect(s().edges).toEqual([expect.objectContaining({ source: g, target: out })]);
    expect(s().toast?.tone).toBe('error');
    s().setFrozen([]);
  });
});

describe('frozen while generating', () => {
  it('allows moving a generating node while keeping deletion and connections frozen until released', () => {
    const p = s().addNode('prompt', { x: 0, y: 0 });
    const g = s().addNode('generate', { x: 300, y: 0 });
    const other = s().addNode('prompt', { x: 0, y: 300 });
    s().connect({ source: p, sourceHandle: OUT, target: g, targetHandle: 'prompt' });
    s().setFrozen([g]);
    const gen = () => s().nodes.find((n) => n.id === g)!;
    expect([gen().draggable, gen().deletable, gen().connectable]).toEqual([true, false, false]);
    s().onNodesChange([{ type: 'position', id: g, position: { x: 500, y: 120 } }]);
    expect(gen().position).toEqual({ x: 500, y: 120 });
    expect(s().nodes.find((n) => n.id === p)!.deletable).toBe(true);

    // The eraser and Delete leave it, and its connections, alone.
    const edgeId = s().edges[0].id;
    expect(s().eraseItems({ nodeIds: [g], edgeIds: [edgeId] })).toBe(1);
    expect(s().nodes.some((n) => n.id === g)).toBe(true);
    expect(s().edges).toHaveLength(1);
    useGraphStore.setState({ nodes: s().nodes.map((n) => ({ ...n, selected: n.id === g })) });
    s().deleteSelected();
    expect(s().nodes.some((n) => n.id === g)).toBe(true);

    // New connections to it are refused; unrelated nodes still work.
    s().connect({ source: other, sourceHandle: OUT, target: g, targetHandle: 'prompt' });
    expect(s().edges).toHaveLength(1);
    expect(s().toast?.tone).toBe('error');
    s().eraseItems({ nodeIds: [other] });
    expect(s().nodes.some((n) => n.id === other)).toBe(false);

    s().setFrozen([]);
    expect([gen().draggable, gen().deletable, gen().connectable]).toEqual([true, true, true]);
    s().eraseItems({ edgeIds: [edgeId] });
    expect(s().edges).toHaveLength(0);
  });
});

describe('eraser', () => {
  it('removes nodes with their edges, keeps locked nodes, and undoes a stroke as one step', () => {
    const p = s().addNode('prompt', { x: 0, y: 0 });
    const g = s().addNode('generate', { x: 300, y: 0 });
    const locked = s().addNode('image', { x: 0, y: 300 }, { locked: true });
    s().connect({ source: p, sourceHandle: OUT, target: g, targetHandle: 'prompt' });
    const edgeId = s().edges[0].id;

    expect(s().eraseItems({ edgeIds: [edgeId] }, 'stroke-1')).toBe(0);
    expect(s().eraseItems({ nodeIds: [p, locked] }, 'stroke-1')).toBe(1);
    expect(s().nodes.map((n) => n.id).sort()).toEqual([g, locked].sort());
    expect(s().edges).toHaveLength(0);

    s().undo();
    expect(s().nodes).toHaveLength(3);
    expect(s().edges).toHaveLength(1);
  });
});

describe('generation results', () => {
  const done = (id: string, batch: string, slot: number, asset: string) => ({
    id,
    batch_id: batch,
    slot_index: slot,
    status: 'completed',
    output_asset_id: asset,
  });

  it('places one Output Image for a single result and fills it without an undo step', () => {
    const g = s().addNode('generate', { x: 0, y: 0 });
    s().placeResultNode(g, 'b1', 1);
    const out = s().nodes.find((n) => n.type === 'output')!;
    expect(s().edges).toContainEqual(expect.objectContaining({ source: g, target: out.id, targetHandle: 'in' }));
    const past = s().past.length;
    s().applyResults([done('t1', 'b1', 0, 'asset-1')]);
    const filled = s().nodes.find((n) => n.id === out.id)!;
    expect(filled.data).toMatchObject({ assetId: 'asset-1', taskId: 't1', generationId: 'b1' });
    expect(s().past.length).toBe(past);
  });

  it('reuses a connected Output Collection and does not re-add removed results', () => {
    const g = s().addNode('generate', { x: 0, y: 0 });
    s().placeResultNode(g, 'b1', 3);
    s().placeResultNode(g, 'b2', 2);
    const collections = s().nodes.filter((n) => n.type === 'collection');
    expect(collections).toHaveLength(1);
    expect(collections[0].data).toMatchObject({ role: 'output', batchIds: ['b1', 'b2'] });

    s().applyResults([done('t2', 'b1', 1, 'x2'), done('t1', 'b1', 0, 'x1'), done('t9', 'other', 0, 'nope')]);
    const items = () => (s().nodes.find((n) => n.type === 'collection')!.data as CollectionData).items;
    expect(items().map((i) => i.assetId)).toEqual(['x1', 'x2']);

    s().setCollectionItems(collections[0].id, items().slice(1));
    s().applyResults([done('t1', 'b1', 0, 'x1'), done('t2', 'b1', 1, 'x2')]);
    expect(items().map((i) => i.assetId)).toEqual(['x2']);
  });

  it('discards a placement whose batch could not be created', () => {
    const g = s().addNode('generate', { x: 0, y: 0 });
    s().placeResultNode(g, 'b1', 1);
    s().discardResultNode('b1');
    expect(s().nodes.map((n) => n.type)).toEqual(['generate']);
    expect(s().edges).toHaveLength(0);

    s().placeResultNode(g, 'b2', 2);
    s().placeResultNode(g, 'b3', 2); // reuses the collection
    s().discardResultNode('b3');
    const col = s().nodes.find((n) => n.type === 'collection')!;
    expect(col.data).toMatchObject({ batchIds: ['b2'] });
  });

  it('pasted output collections stop receiving batches', () => {
    const g = s().addNode('generate', { x: 0, y: 0 });
    s().placeResultNode(g, 'b1', 2);
    const col = s().nodes.find((n) => n.type === 'collection')!;
    select([col.id]);
    s().copySelected();
    s().paste();
    const copy = s().nodes.find((n) => n.type === 'collection' && n.id !== col.id)!;
    expect(copy.data).toMatchObject({ batchIds: [] });
  });
});

describe('image nodes', () => {
  it('addNodes creates several nodes in one undo step', () => {
    const ids = s().addNodes([
      { kind: 'image', position: { x: 0, y: 0 }, data: { assetId: 'a1', title: 'rose.png' } },
      { kind: 'image', position: { x: 10, y: 0 }, data: { assetId: 'a2' } },
    ]);
    expect(ids).toHaveLength(2);
    expect(s().nodes[0].data).toMatchObject({ assetId: 'a1', title: 'rose.png', notes: '' });
    s().undo();
    expect(s().nodes).toHaveLength(0);
  });

  it('loads old Original / Theme nodes as Image nodes, keeping their settings and edges', () => {
    s().loadProject({
      id: 'p2',
      name: 'Old',
      description: '',
      created_at: '',
      updated_at: '',
      graph: {
        nodes: [
          { id: 'o', type: 'original', position: { x: 0, y: 0 }, data: { title: 'Original Image', assetId: 'a', instructions: 'keep hat' } },
          { id: 't', type: 'theme', position: { x: 0, y: 0 }, data: { title: 'My style', assetId: 'b', roles: ['lighting'] } },
          { id: 'g', type: 'generate', position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [{ id: 'e', source: 'o', sourceHandle: OUT, target: 'g', targetHandle: 'original' }],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    const [o, t] = s().nodes;
    expect(o).toMatchObject({ type: 'image', data: { title: 'Image', assetId: 'a', instructions: 'keep hat' } });
    expect(t).toMatchObject({ type: 'image', data: { title: 'My style', roles: ['lighting'] } });
    expect(s().edges).toHaveLength(1);
  });

  it('groups image nodes into a collection, moving Original edges and undoing as one step', () => {
    const a = s().addNode('image', { x: 200, y: 0 }, { assetId: 'asset-a', instructions: 'keep the hat' });
    const b = s().addNode('image', { x: 0, y: 0 }, { assetId: 'asset-b' });
    const empty = s().addNode('image', { x: 400, y: 0 });
    const t = s().addNode('image', { x: 0, y: 300 }, { assetId: 'asset-t', locked: true });
    const g = s().addNode('generate', { x: 800, y: 0 });
    s().connect({ source: a, sourceHandle: OUT, target: g, targetHandle: 'original' });
    s().connect({ source: b, sourceHandle: OUT, target: g, targetHandle: 'reference' });
    select([a, b, empty, t]);

    const c = s().groupIntoCollection();
    expect(c).not.toBeNull();
    const col = s().nodes.find((n) => n.id === c)!;
    const items = (col.data as { items: { assetId: string; promptOverride: string; enabled: boolean }[] }).items;
    // Reading order: b (x=0) before a (x=200); locked and empty nodes are left out.
    expect(items.map((i) => i.assetId)).toEqual(['asset-b', 'asset-a']);
    expect(items[1].promptOverride).toBe('');
    expect(items.every((i) => i.enabled)).toBe(true);
    expect(s().nodes.map((n) => n.id).sort()).toEqual([c, empty, t, g].sort());
    expect(s().edges).toEqual([expect.objectContaining({ source: c, target: g, targetHandle: 'original' })]);

    s().undo();
    expect(s().nodes.some((n) => n.id === c)).toBe(false);
    expect(s().edges).toHaveLength(2);
  });

  it('refuses to group fewer than two images', () => {
    const a = s().addNode('image', { x: 0, y: 0 }, { assetId: 'x' });
    select([a]);
    expect(s().groupIntoCollection()).toBeNull();
    expect(s().toast?.tone).toBe('error');
  });

  it('ungroups an input collection into connected Image nodes', () => {
    const c = s().addNode('collection', { x: 0, y: 0 }, {
      items: [
        { id: '1', assetId: 'a1', enabled: true, promptOverride: 'red' },
        { id: '2', assetId: 'a2', enabled: false, promptOverride: '' },
      ],
    });
    const g = s().addNode('generate', { x: 800, y: 0 });
    s().connect({ source: c, sourceHandle: OUT, target: g, targetHandle: 'original' });
    s().ungroupCollection(c);
    const originals = s().nodes.filter((n) => n.type === 'image');
    expect(originals.map((n) => n.data.assetId)).toEqual(['a1', 'a2']);
    expect(originals[0].data.instructions).toBeUndefined();
    expect(s().edges.filter((e) => e.target === g && e.targetHandle === 'original')).toHaveLength(2);
    expect(s().nodes.some((n) => n.id === c)).toBe(false);
  });

  it('edits collection items with undo, coalescing typing', () => {
    const c = s().addNode('collection', { x: 0, y: 0 });
    const item = { id: 'i', assetId: 'a', enabled: true, promptOverride: '' };
    s().setCollectionItems(c, [item]);
    s().setCollectionItems(c, [{ ...item, promptOverride: 'b' }], 'override:i');
    s().setCollectionItems(c, [{ ...item, promptOverride: 'bl' }], 'override:i');
    const items = () => (s().nodes.find((n) => n.id === c)!.data as { items: unknown[] }).items;
    expect(items()).toEqual([{ ...item, promptOverride: 'bl' }]);
    s().undo();
    expect(items()).toEqual([item]);
    s().undo();
    expect(items()).toEqual([]);
  });

  it('fills fields missing from older saved nodes on load', () => {
    s().loadProject({
      id: 'p2',
      name: 'Old',
      description: '',
      created_at: '',
      updated_at: '',
      graph: {
        nodes: [{ id: 'c', type: 'collection', position: { x: 0, y: 0 }, data: { title: 'Old', role: 'input', itemCount: 0 } }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    expect(s().nodes[0].data).toMatchObject({ title: 'Old', items: [], locked: false });
  });
});
