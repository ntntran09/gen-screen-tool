import { beforeEach, describe, expect, it } from 'vitest';
import { OUT } from '../graph/registry';
import { useGraphStore } from './graphStore';

const s = () => useGraphStore.getState();

function select(ids: string[]) {
  useGraphStore.setState({ nodes: s().nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })) });
}

beforeEach(() => {
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

describe('generating flags', () => {
  it('are transient: not part of undo history or saved revisions', () => {
    const g = s().addNode('generate', { x: 0, y: 0 });
    const rev = s().revision;
    const past = s().past.length;
    s().setGenerating(g, true);
    expect(s().generatingNodeIds[g]).toBe(true);
    expect(s().revision).toBe(rev);
    expect(s().past.length).toBe(past);
    s().setGenerating(g, false);
    expect(s().generatingNodeIds[g]).toBeUndefined();
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

  it('convertNode keeps the asset and drops connections that no longer fit', () => {
    const img = s().addNode('image', { x: 0, y: 0 }, { assetId: 'a1' });
    const g = s().addNode('generate', { x: 300, y: 0 });
    s().connect({ source: img, sourceHandle: OUT, target: g, targetHandle: 'reference' });
    expect(s().edges).toHaveLength(1);
    s().convertNode(img, 'theme');
    const node = s().nodes.find((n) => n.id === img)!;
    expect(node.type).toBe('theme');
    expect(node.data).toMatchObject({ assetId: 'a1', title: 'Theme Image', roles: ['artStyle'] });
    expect(s().edges).toHaveLength(0);
    s().undo();
    expect(s().nodes.find((n) => n.id === img)!.type).toBe('image');
    expect(s().edges).toHaveLength(1);
  });

  it('groups image nodes into a collection, moving Original edges and undoing as one step', () => {
    const a = s().addNode('original', { x: 200, y: 0 }, { assetId: 'asset-a', instructions: 'keep the hat' });
    const b = s().addNode('image', { x: 0, y: 0 }, { assetId: 'asset-b' });
    const empty = s().addNode('image', { x: 400, y: 0 });
    const t = s().addNode('theme', { x: 0, y: 300 }, { assetId: 'asset-t', locked: true });
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
    expect(items[1].promptOverride).toBe('keep the hat');
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

  it('ungroups an input collection into connected Original nodes', () => {
    const c = s().addNode('collection', { x: 0, y: 0 }, {
      items: [
        { id: '1', assetId: 'a1', enabled: true, promptOverride: 'red' },
        { id: '2', assetId: 'a2', enabled: false, promptOverride: '' },
      ],
    });
    const g = s().addNode('generate', { x: 800, y: 0 });
    s().connect({ source: c, sourceHandle: OUT, target: g, targetHandle: 'original' });
    s().ungroupCollection(c);
    const originals = s().nodes.filter((n) => n.type === 'original');
    expect(originals.map((n) => n.data.assetId)).toEqual(['a1', 'a2']);
    expect(originals[0].data.instructions).toBe('red');
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
