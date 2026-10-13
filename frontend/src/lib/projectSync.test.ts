import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushProjectSync, startProjectSync } from './projectSync';
import { useGraphStore } from '../store/graphStore';
import type { GraphPayload } from './api';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: { type: string; seq: number; ops: unknown[] }[] = [];
  url: string;
  constructor(url: string) { this.url = url; Socket.instances.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const graph = (): GraphPayload => ({ nodes: [
  { id: 'a', type: 'prompt', position: { x: 0, y: 0 }, data: { text: 'old' } },
  { id: 'b', type: 'prompt', position: { x: 300, y: 0 }, data: { text: 'other' } },
], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
const snapshot = (extra = {}) => ({ type: 'snapshot', graph: graph(), name: 'Test', revision: 0, ack_seq: 0, ...extra });
const socket = () => Socket.instances.at(-1)!;
let stop: (() => void) | undefined;
let storage: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers(); Socket.instances = []; storage = new Map();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' }, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  useGraphStore.getState().loadProject({ id: 'p', name: 'Test', description: '', created_at: '', updated_at: '', graph: graph() });
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

it('sends a small coalesced property edit, waits for ack, and keeps remote edits out of local autosave', async () => {
  stop = startProjectSync();
  socket().receive(snapshot());
  useGraphStore.getState().updateNodeData('a', { text: 'one' });
  useGraphStore.getState().updateNodeData('a', { text: 'two' });
  expect(socket().sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(socket().sent[0].ops).toEqual([{ kind: 'node_patch', id: 'a', patch: { data: { text: 'two' } } }]);
  const synced = flushProjectSync();
  const clientId = new URL(socket().url).searchParams.get('client_id');
  socket().receive({ type: 'edit', client_id: clientId, seq: 1, revision: 1, ops: socket().sent[0].ops });
  await synced;
  const before = useGraphStore.getState().nodes.find((n) => n.id === 'a');
  socket().receive({ type: 'edit', client_id: 'other', seq: 1, revision: 2,
    ops: [{ kind: 'node_patch', id: 'b', patch: { data: { text: 'remote' } } }] });
  expect(useGraphStore.getState().nodes.find((n) => n.id === 'a')).toBe(before);
  await vi.advanceTimersByTimeAsync(200);
  expect(socket().sent).toHaveLength(1);
  expect(useGraphStore.getState().saveStatus).toBe('saved');
});

it('recovers from a dropped ack without overwriting a newer server edit', async () => {
  stop = startProjectSync(); socket().receive(snapshot());
  useGraphStore.getState().updateNodeData('a', { text: 'mine' });
  await vi.advanceTimersByTimeAsync(100);
  socket().close();
  await vi.advanceTimersByTimeAsync(300);
  const newer = graph(); newer.nodes[0].data.text = 'newer remote';
  socket().receive(snapshot({ graph: newer, revision: 2, ack_seq: 1 }));
  await vi.advanceTimersByTimeAsync(100);
  expect(socket().sent).toEqual([]);
  expect(useGraphStore.getState().nodes[0].data.text).toBe('newer remote');
});

it('recovers a pending edit after reload using a fresh client identity and old receipt', async () => {
  stop = startProjectSync(); socket().receive(snapshot());
  const oldId = new URL(socket().url).searchParams.get('client_id');
  useGraphStore.getState().updateNodeData('a', { text: 'mine' });
  await vi.advanceTimersByTimeAsync(100);
  stop(); stop = undefined;
  expect(storage.has('nodecanvas:sync:p')).toBe(true);
  stop = startProjectSync();
  const url = new URL(socket().url);
  expect(url.searchParams.get('client_id')).not.toBe(oldId);
  expect(url.searchParams.get('resume_client_id')).toBe(oldId);
  const newer = graph(); newer.nodes[0].data.text = 'newer remote';
  socket().receive(snapshot({ graph: newer, revision: 2, resume_ack_seq: 1 }));
  await vi.advanceTimersByTimeAsync(100);
  expect(socket().sent).toEqual([]);
  expect(useGraphStore.getState().nodes[0].data.text).toBe('newer remote');
});

it('awaits the first snapshot before allowing a project switch or Generate', async () => {
  stop = startProjectSync();
  let resolved = false;
  const pending = flushProjectSync().then(() => { resolved = true; });
  await Promise.resolve(); expect(resolved).toBe(false);
  socket().receive(snapshot());
  await pending; expect(resolved).toBe(true);
});

it('preserves remote edits when undoing a local edit', () => {
  stop = startProjectSync(); socket().receive(snapshot());
  useGraphStore.getState().updateNodeData('a', { text: 'local' });
  socket().receive({ type: 'edit', client_id: 'other', seq: 1, revision: 1,
    ops: [{ kind: 'node_patch', id: 'b', patch: { data: { text: 'remote' } } }] });
  useGraphStore.getState().undo();
  expect(useGraphStore.getState().nodes.find((n) => n.id === 'a')?.data.text).toBe('old');
  expect(useGraphStore.getState().nodes.find((n) => n.id === 'b')?.data.text).toBe('remote');
});

it('keeps viewport local and restores it for this tab', async () => {
  stop = startProjectSync(); socket().receive(snapshot());
  useGraphStore.getState().setViewport({ x: 42, y: 99, zoom: 2 });
  await vi.advanceTimersByTimeAsync(100);
  expect(socket().sent).toEqual([]);
  stop(); stop = undefined;
  useGraphStore.setState({ viewport: { x: 0, y: 0, zoom: 1 } });
  stop = startProjectSync(); socket().receive(snapshot());
  expect(useGraphStore.getState().viewport).toEqual({ x: 42, y: 99, zoom: 2 });
});
