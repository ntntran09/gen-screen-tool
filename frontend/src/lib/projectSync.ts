import { projectSyncUrl, setGraphSaver, toGraphPayload } from './api';
import { applyGraphOps, graphDiff, GraphSyncModel, type SyncEvent } from './graphSync';
import { uuid } from './uuid';
import { useGraphStore } from '../store/graphStore';
import { useAssetStore } from '../store/assetStore';
import { usedAssetIds } from '../graph/collections';

const currentGraph = () => {
  const s = useGraphStore.getState();
  return toGraphPayload(s.nodes, s.edges, s.viewport);
};

class ProjectConnection {
  readonly model: GraphSyncModel;
  private socket: WebSocket | null = null;
  private ready = false;
  private disposed = false;
  private deleted = false;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private cacheTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 300;
  private lastMessage = Date.now();
  private lastSent = 0;
  private observed = currentGraph();
  private resumeId: string | null = null;
  private fetchingAssets = new Set<string>();
  private waiters: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private heartbeat: ReturnType<typeof setInterval>;

  readonly projectId: string;
  constructor(projectId: string) {
    this.projectId = projectId;
    try {
      const viewport = JSON.parse(sessionStorage.getItem(`nodecanvas:viewport:${projectId}`) ?? 'null');
      if (viewport && ['x', 'y', 'zoom'].every((key) => Number.isFinite(viewport[key])) && viewport.zoom > 0) {
        useGraphStore.setState({ viewport });
      }
    } catch { /* viewport recovery is optional */ }
    this.model = new GraphSyncModel(currentGraph(), uuid());
    try {
      const cached = JSON.parse(sessionStorage.getItem(this.cacheKey) ?? 'null');
      if (cached?.base?.nodes && cached?.draft?.nodes && typeof cached.clientId === 'string') {
        this.model.base = cached.base;
        this.model.draft = cached.draft;
        this.model.pending = cached.pending ?? null;
        this.resumeId = cached.clientId;
        useGraphStore.getState().applySyncedGraph(this.model.draft);
      }
    } catch { /* storage unavailable; the in-memory queue still works */ }
    this.observed = currentGraph();
    this.connect();
    this.heartbeat = setInterval(() => {
      if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
        // Hidden tabs get throttled timers (about 1/min), so a silent socket there is not proof of a dead one.
        if (document.visibilityState === 'visible' && Date.now() - this.lastMessage > 45_000) this.socket.close();
        else this.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15_000);
  }
  private get cacheKey() { return `nodecanvas:sync:${this.projectId}`; }
  persist = () => {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = undefined;
    try {
      sessionStorage.setItem(`nodecanvas:viewport:${this.projectId}`, JSON.stringify(this.observed.viewport));
      if (!this.model.dirty) sessionStorage.removeItem(this.cacheKey);
      else sessionStorage.setItem(this.cacheKey, JSON.stringify({ clientId: this.model.clientId,
        base: this.model.base, draft: this.model.draft, pending: this.model.pending }));
    } catch { /* do not break editing if the browser storage is full */ }
  };
  capture() {
    const next = currentGraph();
    this.model.draft = applyGraphOps(this.model.draft, graphDiff(this.observed, next));
    this.observed = next;
    if (!this.cacheTimer) this.cacheTimer = setTimeout(this.persist, 800);
    if (!this.sendTimer) this.sendTimer = setTimeout(() => { this.sendTimer = undefined; this.send(); }, 100);
  }
  private connect() {
    let url = projectSyncUrl(this.projectId, this.model.clientId);
    if (this.resumeId) url += `&resume_client_id=${encodeURIComponent(this.resumeId)}`;
    const socket = this.socket = new WebSocket(url);
    socket.onmessage = (message) => {
      if (this.disposed || socket !== this.socket) return;
      this.lastMessage = Date.now();
      try {
        const event = JSON.parse(message.data) as SyncEvent | { type: 'name'; name: string } | { type: 'pong' } | { type: 'deleted' };
        if (event.type === 'name') { useGraphStore.getState().setProjectName(event.name); return; }
        if (event.type === 'pong') return;
        if (event.type === 'deleted') {
          this.deleted = true; this.ready = false;
          const error = new Error('This project was deleted. Open another project.');
          useGraphStore.getState().setSaveStatus('error', error.message);
          useGraphStore.getState().showToast(error.message, 'error');
          this.finishWaiters(error); socket.close(); return;
        }
        if (event.type === 'snapshot' && this.resumeId) {
          // New page, new client ID: recover a lost acknowledgement from the old page.
          event.ack_seq = (event as typeof event & { resume_ack_seq?: number }).resume_ack_seq ?? 0;
          this.model.receive(event);
          this.model.ackSeq = 0;
          if (this.model.pending) this.model.pending.seq = 1;
          this.resumeId = null;
        } else this.model.receive(event);
        this.ready = true;
        this.retryDelay = 300;
        useGraphStore.getState().applySyncedGraph(this.model.draft);
        this.observed = currentGraph();
        const assets = useAssetStore.getState();
        if (assets.projectId === this.projectId) for (const id of usedAssetIds(useGraphStore.getState().nodes).keys()) {
          if (!assets.assets[id] && !this.fetchingAssets.has(id)) {
            this.fetchingAssets.add(id);
            void assets.refresh(id).finally(() => this.fetchingAssets.delete(id));
          }
        }
        if (event.type !== 'edit') useGraphStore.getState().setProjectName(event.name);
        if (event.type === 'rejected') {
          const error = new Error(event.message ?? 'Canvas edit rejected.');
          useGraphStore.getState().showToast(error.message, 'error');
          this.finishWaiters(error);
        }
        this.status();
        if (event.type === 'snapshot' && this.model.pending) this.transmit(this.model.pending);
        else this.send();
      } catch { socket.close(); }
    };
    socket.onclose = () => {
      if (this.disposed || this.deleted || socket !== this.socket) return;
      this.ready = false;
      if (this.model.dirty) useGraphStore.getState().setSaveStatus('error', 'Disconnected. Edits will sync after reconnecting.');
      this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    };
    socket.onerror = () => socket.close();
  }
  private transmit(edit: { seq: number; ops: unknown[] }) {
    this.lastSent = Date.now();
    this.socket!.send(JSON.stringify({ type: 'edit', ...edit }));
  }
  private send(force = false) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    const delay = 100 - (Date.now() - this.lastSent);
    if (!force && delay > 0) {
      if (!this.sendTimer) this.sendTimer = setTimeout(() => { this.sendTimer = undefined; this.send(); }, delay);
      return;
    }
    const batch = this.model.prepare();
    if (batch) this.transmit(batch);
    this.status();
  }
  private status() {
    useGraphStore.getState().setSaveStatus(this.model.dirty ? 'saving' : 'saved');
    if (!this.model.dirty) { this.persist(); this.finishWaiters(); }
  }
  private finishWaiters(error?: Error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error); else waiter.resolve();
    }
  }
  flush(): Promise<void> {
    if (this.deleted) return Promise.resolve(); // allow leaving the deleted project
    this.capture();
    if (this.ready && !this.model.dirty) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        const error = new Error('Cannot sync this project yet. Your edits are kept in this tab.');
        useGraphStore.getState().setSaveStatus('error', error.message);
        reject(error);
      }, 10_000) };
      this.waiters.push(waiter);
      this.send(true);
    });
  }
  dispose() {
    this.persist();
    this.disposed = true;
    clearTimeout(this.sendTimer); clearTimeout(this.retryTimer); clearTimeout(this.cacheTimer);
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.finishWaiters(new Error('Project closed before syncing finished.'));
  }
}

let active: ProjectConnection | null = null;
export async function flushProjectSync(projectId?: string) {
  if (!active || (projectId && projectId !== active.projectId)) {
    if (useGraphStore.getState().projectId) throw new Error('Project sync is not connected.');
    return;
  }
  await active.flush();
}

export function startProjectSync() {
  const select = () => {
    const id = useGraphStore.getState().projectId;
    if (id === active?.projectId) return;
    active?.dispose();
    active = id ? new ProjectConnection(id) : null;
  };
  select();
  setGraphSaver(flushProjectSync);
  const unsubscribe = useGraphStore.subscribe((state, prev) => {
    if (state.projectId !== prev.projectId) select();
    else if (state.revision !== prev.revision) active?.capture();
  });
  const flushOnHide = () => {
    active?.capture(); active?.persist();
    void active?.flush().catch(() => {});
  };
  window.addEventListener('pagehide', flushOnHide);
  const visibility = () => { if (document.visibilityState === 'hidden') flushOnHide(); };
  document.addEventListener('visibilitychange', visibility);
  return () => {
    unsubscribe(); setGraphSaver(null);
    window.removeEventListener('pagehide', flushOnHide);
    document.removeEventListener('visibilitychange', visibility);
    active?.dispose(); active = null;
  };
}
