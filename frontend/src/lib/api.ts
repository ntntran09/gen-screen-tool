import type { CanvasEdge, CanvasNode, DetectedAsset } from '../graph/types';
import { getDefinition } from '../graph/registry';
import type { BaseNodeData } from '../graph/types';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';
let graphSaver: ((projectId: string) => Promise<void>) | null = null;
export const setGraphSaver = (save: typeof graphSaver) => { graphSaver = save; };
export function projectSyncUrl(projectId: string, clientId: string) {
  const url = new URL(`${BASE}/projects/${encodeURIComponent(projectId)}/sync`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client_id', clientId);
  return url.href;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Every validation problem, when the backend reports more than one. */
  readonly errors: string[];
  constructor(status: number, code: string, message: string, errors: string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors.length ? errors : [message];
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-nodecanvas-csrf'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the local backend. Is it running?');
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN_ERROR',
      err?.message ?? `Request failed (${res.status}).`,
      Array.isArray(err?.errors) ? err.errors : [],
    );
  }
  return json as T;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface GraphPayload {
  nodes: { id: string; type: string; position: { x: number; y: number }; width?: number | null; height?: number | null; data: Record<string, unknown> }[];
  edges: { id: string; source: string; sourceHandle: string | null; target: string; targetHandle: string | null }[];
  viewport: Viewport;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  graph_revision?: number;
}

export interface ProjectDetail extends ProjectSummary {
  graph: GraphPayload;
}

export interface ProviderInfo {
  id: string;
  name: string;
  experimental: boolean;
  may_consume_quota: boolean;
  auth_state: string;
}

export function toGraphPayload(nodes: CanvasNode[], edges: CanvasEdge[], viewport: Viewport): GraphPayload {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type!,
      position: { x: n.position.x, y: n.position.y },
      // Only explicit (user-resized) sizes are persisted; measured sizes stay automatic.
      width: n.width ?? null,
      height: n.type === 'text' ? null : n.height ?? null,
      data: n.data,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? null,
      target: e.target,
      targetHandle: e.targetHandle ?? null,
    })),
    viewport,
  };
}

/** Inline controls are expanded only in the immutable provider snapshot, never on the canvas. */
export function toInlineGenerationPayload(graph: GraphPayload, sourceId: string): GraphPayload {
  const source = graph.nodes.find((n) => n.id === sourceId);
  const inline = (source?.data as BaseNodeData | undefined)?.inlineGeneration;
  if (!source || !inline) throw new Error('The inline generation is missing.');
  const promptId = `${inline.id}:prompt`;
  const direct = ['output', 'image'].includes(source.type) && source.data.assetId === inline.assetId;
  const originalId = direct ? source.id : `${inline.id}:image`;
  return { ...graph, nodes: [...graph.nodes,
    { id: promptId, type: 'prompt', position: source.position, data: { ...getDefinition('prompt').defaultData(), text: inline.prompt } },
    { id: inline.id, type: 'generate', position: source.position, data: {
      ...getDefinition('generate').defaultData(), ...inline.settings, title: inline.settings.title ?? 'Edit result',
      editResult: true, mode: 'manual', outputCount: 1, aspectRatio: 'match', primaryOriginalNodeId: null,
    } },
    ...(!direct ? [{ id: originalId, type: 'image', position: source.position,
      data: { ...getDefinition('image').defaultData(), assetId: inline.assetId } }] : []),
  ], edges: [...graph.edges,
    { id: `${inline.id}:original`, source: originalId, sourceHandle: 'out', target: inline.id, targetHandle: 'original' },
    { id: `${inline.id}:request`, source: promptId, sourceHandle: 'out', target: inline.id, targetHandle: 'prompt' },
  ] };
}

export const api = {
  health: () => request<{ status: string; result_edit?: boolean; inline_result_edit?: boolean; retry_prompt?: boolean }>('GET', '/health'),
  listProjects: () => request<ProjectSummary[]>('GET', '/projects'),
  createProject: (name: string) => request<ProjectDetail>('POST', '/projects', { name }),
  getProject: (id: string) => request<ProjectDetail>('GET', `/projects/${encodeURIComponent(id)}`),
  updateProject: async (id: string, body: { name?: string; graph?: GraphPayload; graph_revision?: number }) => {
    if (body.graph && graphSaver) {
      await graphSaver(id);
      if (body.name !== undefined) return request<ProjectSummary>('PUT', `/projects/${encodeURIComponent(id)}`, { name: body.name });
      return request<ProjectSummary>('GET', `/projects/${encodeURIComponent(id)}`);
    }
    return request<ProjectSummary>('PUT', `/projects/${encodeURIComponent(id)}`, body);
  },
  deleteProject: (id: string) => request<void>('DELETE', `/projects/${encodeURIComponent(id)}`),
  listProviders: () => request<ProviderInfo[]>('GET', '/providers'),
  listAssets: (projectId: string) => request<AssetInfo[]>('GET', `/projects/${encodeURIComponent(projectId)}/assets`),
  deleteAssets: (projectId: string, assetIds: string[]) =>
    request<{ deleted: string[] }>('POST', `/projects/${encodeURIComponent(projectId)}/assets/delete`, { asset_ids: assetIds }),
  assetPalette: (id: string, count: number) =>
    request<{ colors: { hex: string; share: number }[] }>('GET', `/assets/${encodeURIComponent(id)}/palette?count=${count}`),
  detectAssets: (assetId: string, providerId: string, hint: string, model = '') =>
    request<DetectResult>('POST', `/assets/${encodeURIComponent(assetId)}/detect`, { provider_id: providerId, hint, model }),
  cropAssets: (assetId: string, boxes: Pick<DetectedAsset, 'name' | 'x' | 'y' | 'w' | 'h'>[]) =>
    request<{ assets: AssetInfo[] }>('POST', `/assets/${encodeURIComponent(assetId)}/crop`, { boxes }),
  assetOriginPrompts: (id: string) =>
    request<{ prompts: string[] }>('GET', `/assets/${encodeURIComponent(id)}/origin-prompt`),
  getAsset: (id: string) => request<AssetInfo>('GET', `/assets/${encodeURIComponent(id)}`),
  renameAsset: (id: string, name: string) => request<AssetInfo>('PATCH', `/assets/${encodeURIComponent(id)}`, { name }),
  importAssets: async (projectId: string, files: File[]): Promise<ImportResult> => {
    const form = new FormData();
    form.append('project_id', projectId);
    for (const f of files) form.append('files', f, f.name || 'image');
    let res: Response;
    try {
      res = await fetch(`${BASE}/assets/import`, { method: 'POST', headers: { 'x-nodecanvas-csrf': '1' }, body: form });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the local backend. Is it running?');
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError(res.status, json?.error?.code ?? 'UNKNOWN_ERROR', json?.error?.message ?? 'Import failed.');
    }
    return json as ImportResult;
  },
  authStatus: (providerId = 'codex') =>
    request<AuthStatus>('GET', `/auth/status?provider_id=${encodeURIComponent(providerId)}`),
  connect: (method: 'device_code' | 'import_codex_cli', providerId = 'codex') =>
    request<AuthStatus>('POST', '/auth/connect', { provider_id: providerId, method }),
  cancelLogin: (providerId = 'codex') => request<AuthStatus>('POST', '/auth/cancel', { provider_id: providerId }),
  disconnect: (providerId = 'codex') => request<AuthStatus>('POST', '/auth/disconnect', { provider_id: providerId }),
  testProvider: (providerId: string, body: { confirm_quota_use: boolean; prompt?: string }) =>
    request<ProviderTestResult>('POST', `/providers/${encodeURIComponent(providerId)}/test`, body),
  previewGeneration: (body: GenerationBody) => request<GenerationPreview>('POST', '/generations/preview', body),
  startGeneration: (body: GenerationBody) =>
    request<{ batch: GenerationBatch; tasks: GenerationTask[] }>('POST', '/generations', body),
  listGenerations: (projectId: string) =>
    request<GenerationBatch[]>('GET', `/generations?project_id=${encodeURIComponent(projectId)}`),
  generationTasks: (batchId: string) => request<GenerationTask[]>('GET', `/generations/${encodeURIComponent(batchId)}/tasks`),
  cancelGeneration: (batchId: string) =>
    request<{ batch: GenerationBatch; note: string | null }>('POST', `/generations/${encodeURIComponent(batchId)}/cancel`),
  retryGeneration: (batchId: string, taskIds?: string[], prompt?: string) =>
    request<{ batch: GenerationBatch; retried: number }>('POST', `/generations/${encodeURIComponent(batchId)}/retry`, {
      task_ids: taskIds ?? null,
      ...(prompt !== undefined ? { prompt } : {}),
    }),
  resumeGeneration: (batchId: string) =>
    request<{ batch: GenerationBatch }>('POST', `/generations/${encodeURIComponent(batchId)}/resume`),
};

export const generationEventsUrl = (projectId: string) =>
  `${BASE}/generations/events?project_id=${encodeURIComponent(projectId)}`;

export interface GenerationBody {
  project_id: string;
  generate_node_id: string;
  graph: GraphPayload;
  /** Client-chosen id for a new batch (so its result node can be saved first). */
  batch_id?: string;
}

export type BatchStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled';

export type TaskStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted';

export interface GenerationBatch {
  id: string;
  project_id: string;
  generate_node_id: string;
  name: string;
  provider_id: string;
  mode: 'manual' | 'match';
  status: BatchStatus;
  status_reason: string | null;
  expected_count: number;
  completed_count: number;
  failed_count: number;
  cancelled_count: number;
  active_count: number;
  cancel_requested: boolean;
  created_at: string;
  finished_at: string | null;
}

export interface GenerationTask {
  prompt_parts?: { prefix: string; user_prompt: string; suffix: string };
  id: string;
  batch_id: string;
  project_id: string;
  slot_index: number;
  attempt_number: number;
  variant_index: number;
  source_asset_id: string | null;
  source_name: string | null;
  status: TaskStatus;
  prompt: string;
  request: {
    operation: 'generate' | 'edit';
    original_asset_id: string | null;
    theme_asset_ids: string[];
    reference_asset_ids: string[];
    settings: Record<string, string | number>;
  };
  output_asset_id: string | null;
  result: {
    width: number;
    height: number;
    mime_type: string;
    has_alpha: boolean;
    file_size: number;
    reported_model: string | null;
    reported_settings: Record<string, unknown>;
  } | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface GenerationPreview {
  ok: boolean;
  errors: string[];
  provider?: {
    id: string;
    name: string;
    experimental: boolean;
    auth_state: AuthState;
    capabilities: Record<string, unknown>;
  } | null;
  mode?: 'manual' | 'match';
  settings?: Record<string, string | number>;
  theme_asset_ids?: string[];
  reference_asset_ids?: string[];
  palette?: { hex: string; role: string; ratio: number | null }[];
  total_tasks: number;
  tasks: {
    slot_index: number;
    variant_index: number;
    source_asset_id: string | null;
    extra_original_asset_ids?: string[];
    source_name: string | null;
    operation: 'generate' | 'edit';
    prompt: string;
  }[];
}

export type AuthState =
  | 'not_connected'
  | 'connecting'
  | 'connected'
  | 'expired'
  | 'permission_error'
  | 'provider_unavailable';

export interface AuthStatus {
  state: AuthState;
  email: string | null;
  plan: string | null;
  account_id: string | null;
  expires_at: number | null;
  source: 'device-code' | 'codex-cli' | null;
  pending: { user_code: string; verification_url: string } | null;
  error: string | null;
  codex_cli_login_found: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  elapsed_seconds: number;
  requested: Record<string, unknown>;
  reported_model: string | null;
  reported_settings: Record<string, unknown>;
  actual: { width: number; height: number; mime_type: string; has_alpha: boolean; bytes: number };
  saved_as: string;
  preview: string;
}

export interface AssetInfo {
  id: string;
  project_id: string;
  name: string;
  original_filename: string;
  mime_type: string;
  format: string;
  width: number;
  height: number;
  file_size: number;
  sha256: string;
  origin: string;
  created_at: string;
  missing: boolean;
  /** Removed from the library; the file was moved to backups. */
  deleted?: boolean;
}

export interface DetectResult {
  asset_id: string;
  model: string | null;
  elapsed_seconds: number;
  assets: { name: string; description: string; x: number; y: number; w: number; h: number }[];
}

export interface ImportResult {
  imported: (AssetInfo & { index: number; has_alpha: boolean })[];
  errors: { index: number; filename: string | null; code: string; message: string }[];
}

export const assetUrls = {
  selected: (projectId: string, ids: string[]) => `${BASE}/projects/${encodeURIComponent(projectId)}/assets/download?${new URLSearchParams(ids.map((id) => ['ids', id]))}`,
  thumbnail: (id: string) => `${BASE}/assets/${encodeURIComponent(id)}/thumbnail`,
  file: (id: string) => `${BASE}/assets/${encodeURIComponent(id)}/file`,
  download: (id: string) => `${BASE}/assets/${encodeURIComponent(id)}/download`,
};
