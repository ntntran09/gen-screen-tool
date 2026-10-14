import { beforeEach, expect, it, vi } from 'vitest';
import { api, type GenerationBatch, type GenerationTask } from '../lib/api';
import { failureReasons, useGenerationStore, variationContext } from './generationStore';
import { useGraphStore } from './graphStore';

const g = () => useGraphStore.getState();
const s = () => useGenerationStore.getState();
const task = (id: string, attempt: number, asset: string): GenerationTask => ({
  id, batch_id: 'batch', project_id: 'p', slot_index: 0, attempt_number: attempt,
  variant_index: 1, source_asset_id: 'original', source_name: 'original', status: 'completed',
  prompt: 'saved request', request: { operation: 'edit', original_asset_id: 'original',
    theme_asset_ids: [], reference_asset_ids: [], settings: {} },
  output_asset_id: asset, result: null, error_code: null, error_message: null,
  created_at: '', started_at: null, finished_at: null,
});
const batch = { id: 'batch', project_id: 'p', generate_node_id: 'generate', status: 'queued' } as GenerationBatch;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'health').mockResolvedValue({ status: 'ok', result_edit: true, inline_result_edit: true, retry_prompt: true });
  useGenerationStore.setState({ projectId: 'p', batches: {}, tasks: {}, starting: {}, editTarget: null });
  g().loadProject({ id: 'p', name: 'Test', description: '', created_at: '', updated_at: '',
    graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } });
});

it('opens the exact prompt that produced the displayed result', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old', generationId: 'batch', taskId: 'one' });
  vi.spyOn(api, 'generationTasks').mockResolvedValue([task('one', 1, 'old')]);
  await s().openEdit(old, 'old');
  expect(s().editTarget).toMatchObject({ prompt: 'saved request', batchId: 'batch', taskId: 'one' });
});

it('starts with the short input, expands without changing it, and preserves the template when edited', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old', generationId: 'batch', taskId: 'one' });
  vi.spyOn(api, 'generationTasks').mockResolvedValue([{ ...task('one', 1, 'old'), prompt: 'PREFIX\nMake it pink\nSUFFIX',
    prompt_parts: { prefix: 'PREFIX\n', user_prompt: 'Make it pink', suffix: '\nSUFFIX' } }]);
  await s().openEdit(old, 'old');
  expect(s().editTarget?.shortPrompt).toBe('Make it pink');
  expect(s().editTarget?.expanded).toBe(false);
  s().toggleFullPrompt();
  expect(s().editTarget?.expanded).toBe(true);
  expect(s().editTarget?.prompt).toBe('PREFIX\nMake it pink\nSUFFIX');
  s().setEditPrompt('Make it blue');
  expect(s().editTarget?.prompt).toBe('PREFIX\nMake it blue\nSUFFIX');
  s().setEditPrompt('');
  expect(s().editTarget?.prompt).toBe('');
  expect(s().editTarget?.originalPrompt).toBe('PREFIX\nMake it pink\nSUFFIX');
});

it.each(['Make the flowers pink', ''])('retries from the old inputs with optional edited prompt %s', async (prompt) => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old', generationId: 'batch', taskId: 'one' });
  vi.spyOn(api, 'generationTasks').mockResolvedValueOnce([task('one', 1, 'old')])
    .mockResolvedValueOnce([task('one', 1, 'old'), task('two', 2, 'new')]);
  const save = vi.spyOn(api, 'updateProject').mockResolvedValue(undefined as never);
  const start = vi.spyOn(api, 'startGeneration');
  const retry = vi.spyOn(api, 'retryGeneration').mockImplementation(async (_, ids, edited) => {
    expect(save).toHaveBeenCalledOnce();
    expect(ids).toEqual(['one']);
    expect(edited).toBe(prompt || 'saved request');
    const saved = save.mock.calls[0][1].graph!;
    expect(saved.nodes).toHaveLength(2);
    expect(saved.nodes.every((n) => n.type === 'output')).toBe(true);
    expect(saved.nodes[1].data.resultAction).toBe('retry');
    expect(saved.edges[0]).toMatchObject({ source: old, targetHandle: 'edit' });
    return { batch, retried: 1 };
  });
  expect(await s().regenerate(old, 'old', prompt, 'batch', 'one')).toBe(true);
  expect(retry).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  expect(g().nodes.filter((n) => n.type === 'output').map((n) => n.data.assetId)).toEqual(['old', 'new']);
  expect(s().starting).toEqual({});
});

it('keeps the old result and removes the empty receiver when retry is rejected', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old' });
  vi.spyOn(api, 'generationTasks').mockResolvedValue([task('one', 1, 'old')]);
  vi.spyOn(api, 'updateProject').mockResolvedValue(undefined as never);
  vi.spyOn(api, 'retryGeneration').mockRejectedValue(new Error('Provider offline'));
  expect(await s().regenerate(old, 'old', 'Make it pink', 'batch', 'one')).toBe(false);
  expect(g().nodes).toHaveLength(1);
  expect(g().edges).toHaveLength(0);
  expect(g().toast?.message).toBe('Provider offline');
});

it('does not retry when the connected graph could not save', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old' });
  vi.spyOn(api, 'generationTasks').mockResolvedValue([task('one', 1, 'old')]);
  vi.spyOn(api, 'updateProject').mockRejectedValue(new Error('Save failed'));
  const retry = vi.spyOn(api, 'retryGeneration');
  expect(await s().regenerate(old, 'old', '', 'batch', 'one')).toBe(false);
  expect(retry).not.toHaveBeenCalled();
  expect(g().nodes).toHaveLength(1);
});

it('rejects changed asset references before submitting', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old' });
  vi.spyOn(api, 'generationTasks').mockResolvedValue([task('one', 1, 'old')]);
  const retry = vi.spyOn(api, 'retryGeneration');
  expect(await s().regenerate(old, 'replaced', '', 'batch', 'one')).toBe(false);
  expect(g().nodes).toHaveLength(1);
  expect(retry).not.toHaveBeenCalled();
});

it('does not send edited prompts to an older backend', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old' });
  vi.mocked(api.health).mockResolvedValue({ status: 'ok' });
  const retry = vi.spyOn(api, 'retryGeneration');
  expect(await s().regenerate(old, 'old', 'Changed', 'batch', 'one')).toBe(false);
  expect(retry).not.toHaveBeenCalled();
});

it('does not put tasks from a previous project into the current store', async () => {
  let resolve!: (tasks: GenerationTask[]) => void;
  vi.spyOn(api, 'generationTasks').mockReturnValue(new Promise((done) => { resolve = done; }));
  const pending = s().loadTasks('batch');
  useGenerationStore.setState({ projectId: 'other', tasks: {} });
  resolve([task('one', 1, 'old')]);
  await pending;
  expect(s().tasks).toEqual({});
});

it('previews a variation without adding canvas nodes and lets the short prompt change', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old' });
  vi.spyOn(api, 'previewGeneration').mockImplementation(async (body) => {
    const prompt = body.graph!.nodes.find((n) => n.type === 'prompt')!.data.text as string;
    return { ok: true, errors: [], total_tasks: 1, tasks: [{ slot_index: 0, variant_index: 1,
      source_asset_id: 'old', source_name: 'old', operation: 'edit', prompt: `PREFIX\n${prompt}\nSUFFIX` }] };
  });
  const start = vi.spyOn(api, 'startGeneration');
  await s().openVariation(old, 'old');
  expect(g().nodes).toHaveLength(1);
  expect(g().edges).toHaveLength(0);
  expect(start).not.toHaveBeenCalled();
  expect(s().editTarget).toMatchObject({ mode: 'variation', loading: false });
  expect(s().editTarget?.expanded).toBeFalsy();
  s().setEditPrompt('Change the flowers');
  expect(s().editTarget?.prompt).toBe('PREFIX\nChange the flowers\nSUFFIX');
});

it.each(['Make the flowers pink', ''])('creates a directly connected Varied result using the current image: %s', async (prompt) => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old' });
  const save = vi.spyOn(api, 'updateProject').mockResolvedValue(undefined as never);
  vi.spyOn(api, 'startGeneration').mockImplementation(async (body) => {
    const saved = save.mock.calls[0][1].graph!;
    expect(saved.nodes).toHaveLength(2);
    expect(saved.nodes.every((n) => n.type === 'output')).toBe(true);
    expect(saved.nodes[1].data.title).toBe('Varied result');
    expect(saved.nodes[1].data.resultAction).toBe('variation');
    expect(saved.edges[0]).toMatchObject({ source: old, target: saved.nodes[1].id, targetHandle: 'edit' });
    expect(body.graph!.edges).toContainEqual(expect.objectContaining({ source: old, target: body.generate_node_id, targetHandle: 'original' }));
    expect(body.graph!.nodes.find((n) => n.type === 'prompt')?.data.text).toBe(prompt || 'Create a subtle variation of this image. Preserve its art style, main subject and composition.');
    return { batch: { ...batch, id: body.batch_id!, generate_node_id: body.generate_node_id },
      tasks: [{ ...task('varied', 1, 'new'), batch_id: body.batch_id! }] };
  });
  expect(await s().vary(old, 'old', prompt)).toBe(true);
  expect(g().nodes.map((n) => n.data.assetId)).toEqual(['old', 'new']);
  expect(s().starting).toEqual({});
});

it('a variation sends the original image along as a secondary original, for context', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old', generationId: 'batch', taskId: 'one' });
  // The result 'old' was made from 'original' (plus a second original) in batch 'batch'.
  const made: GenerationTask = { ...task('one', 1, 'old'), request: { ...task('one', 1, 'old').request, original_asset_id: 'original', extra_original_asset_ids: ['second', 'old'] } };
  // A finished batch: a result of a running batch is frozen and cannot be varied.
  useGenerationStore.setState({ batches: { batch: { ...batch, status: 'completed' } }, tasks: { batch: [made] } });
  vi.spyOn(api, 'updateProject').mockResolvedValue(undefined as never);
  let sent: Parameters<typeof api.startGeneration>[0] | undefined;
  vi.spyOn(api, 'startGeneration').mockImplementation(async (body) => {
    sent = body;
    return { batch: { ...batch, id: body.batch_id!, generate_node_id: body.generate_node_id }, tasks: [{ ...task('varied', 1, 'new'), batch_id: body.batch_id! }] };
  });
  expect(await s().vary(old, 'old', '', 'batch', 'one')).toBe(true);
  const nodes = sent!.graph!.nodes;
  const generate = nodes.find((n) => n.id === sent!.generate_node_id)!;
  const originals = sent!.graph!.edges.filter((e) => e.target === generate.id && e.targetHandle === 'original').map((e) => e.source);
  expect(originals).toHaveLength(3); // the varied image, the original and the second original
  expect(originals[0]).toBe(old);
  expect(generate.data.primaryOriginalNodeId).toBe(old); // the varied image stays image 1
  expect(nodes.filter((n) => originals.slice(1).includes(n.id)).map((n) => n.data.assetId).sort()).toEqual(['original', 'second']);
});

it('a retry does not carry the original image along', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old', generationId: 'batch', taskId: 'one' });
  g().placeInlineResult(old, 'old', 'Make it pink', 'b2', {}, undefined, undefined, undefined, ['original']);
  expect(g().nodes.find((n) => n.id === old)!.data.inlineGeneration?.contextAssetIds).toEqual(['original']);
  g().placeInlineResult(old, 'old', 'Make it blue', 'b3', {}, { slot_index: 0, attempt_number: 2 }); // a retry passes no context
  expect(g().nodes.find((n) => n.id === old)!.data.inlineGeneration?.contextAssetIds).toBeUndefined();
});

it('variationContext lists the originals of a result, without the result itself or duplicates', () => {
  const made = { ...task('one', 1, 'old'), request: { ...task('one', 1, 'old').request, original_asset_id: 'a', extra_original_asset_ids: ['b', 'a', 'old', ''] } };
  expect(variationContext(made, 'old')).toEqual(['a', 'b']);
  expect(variationContext(undefined, 'old')).toEqual([]);
  expect(variationContext({ ...made, request: { ...made.request, original_asset_id: null, extra_original_asset_ids: undefined } }, 'old')).toEqual([]);
});

it('removes the empty variation result when submission fails', async () => {
  const old = g().addNode('output', { x: 0, y: 0 }, { assetId: 'old' });
  vi.spyOn(api, 'updateProject').mockResolvedValue(undefined as never);
  vi.spyOn(api, 'startGeneration').mockRejectedValue(new Error('Provider offline'));
  expect(await s().vary(old, 'old', 'Change the flowers')).toBe(false);
  expect(g().nodes).toHaveLength(1);
  expect(g().edges).toHaveLength(0);
  expect(g().toast?.message).toBe('Provider offline');
  expect(s().starting).toEqual({});
});

it('protects running result receivers from every deletion path and releases them when done', () => {
  const generate = g().addNode('generate', { x: 0, y: 0 });
  useGenerationStore.setState({ batches: { batch: { ...batch, generate_node_id: generate, status: 'running' } } });
  // Also covers receivers loaded/added after the running batch is known.
  g().placeResultNode(generate, 'batch', 1);
  const result = g().nodes.find((n) => n.type === 'output')!;
  const edge = g().edges[0]!;
  expect(g().nodes.find((n) => n.id === result.id)?.deletable).toBe(false);
  g().undo();
  expect(g().nodes.some((n) => n.id === result.id)).toBe(true);
  g().onNodesChange([{ type: 'remove', id: result.id }]);
  g().onEdgesChange([{ type: 'remove', id: edge.id }]);
  useGraphStore.setState({ nodes: g().nodes.map((n) => ({ ...n, selected: n.id === result.id })),
    edges: g().edges.map((e) => ({ ...e, selected: true })) });
  g().deleteSelected();
  g().eraseItems({ nodeIds: [result.id], edgeIds: [edge.id] });
  expect(g().nodes.some((n) => n.id === result.id)).toBe(true);
  expect(g().edges).toHaveLength(1);
  useGenerationStore.setState({ batches: { batch: { ...batch, generate_node_id: generate, status: 'completed' } } });
  expect(g().nodes.find((n) => n.id === result.id)?.deletable).toBe(true);
  g().deleteSelected();
  expect(g().nodes.some((n) => n.id === result.id)).toBe(false);
});

it('protects an output collection while its batch runs', () => {
  const generate = g().addNode('generate', { x: 0, y: 0 });
  g().placeResultNode(generate, 'batch', 2);
  useGenerationStore.setState({ batches: { batch: { ...batch, generate_node_id: generate, status: 'queued' } } });
  const collection = g().nodes.find((n) => n.type === 'collection')!;
  expect(collection.deletable).toBe(false);
  g().onNodesChange([{ type: 'remove', id: collection.id }]);
  expect(g().nodes.some((n) => n.id === collection.id)).toBe(true);
});

it('groups the latest failed attempts by their real error message', () => {
  const failed = (id: string, slot: number, attempt: number, message: string | null, status: GenerationTask['status'] = 'failed'): GenerationTask =>
    ({ ...task(id, attempt, ''), slot_index: slot, status, error_code: 'NETWORK_ERROR', error_message: message, output_asset_id: null });
  const reasons = failureReasons([
    failed('a', 0, 1, 'Network error while contacting ChatGPT. Result unknown.'),
    failed('b', 1, 1, 'Network error while contacting ChatGPT. Result unknown.'),
    failed('c', 2, 1, 'Your request was rejected by the safety system.'),
    failed('d', 3, 1, 'Old error'), failed('e', 3, 2, null, 'completed'), // retried and succeeded: no longer a failure
    failed('f', 4, 1, null), // no message: falls back to the code
    { ...task('g', 1, 'x'), slot_index: 5 }, // completed
  ]);
  expect(reasons).toEqual([
    { message: 'Network error while contacting ChatGPT. Result unknown.', count: 2 },
    { message: 'Your request was rejected by the safety system.', count: 1 },
    { message: 'NETWORK_ERROR', count: 1 },
  ]);
  expect(failureReasons(undefined)).toEqual([]);
});

