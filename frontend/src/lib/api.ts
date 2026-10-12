import type { CanvasEdge, CanvasNode } from '../graph/types';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN_ERROR', err?.message ?? `Request failed (${res.status}).`);
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
      height: n.height ?? null,
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

export const api = {
  listProjects: () => request<ProjectSummary[]>('GET', '/projects'),
  createProject: (name: string) => request<ProjectDetail>('POST', '/projects', { name }),
  getProject: (id: string) => request<ProjectDetail>('GET', `/projects/${encodeURIComponent(id)}`),
  updateProject: (id: string, body: { name?: string; graph?: GraphPayload }) =>
    request<ProjectSummary>('PUT', `/projects/${encodeURIComponent(id)}`, body),
  deleteProject: (id: string) => request<void>('DELETE', `/projects/${encodeURIComponent(id)}`),
  listProviders: () => request<ProviderInfo[]>('GET', '/providers'),
  listAssets: (projectId: string) => request<AssetInfo[]>('GET', `/projects/${encodeURIComponent(projectId)}/assets`),
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
};

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
}

export interface ImportResult {
  imported: (AssetInfo & { index: number; has_alpha: boolean })[];
  errors: { index: number; filename: string | null; code: string; message: string }[];
}

export const assetUrls = {
  thumbnail: (id: string) => `${BASE}/assets/${encodeURIComponent(id)}/thumbnail`,
  file: (id: string) => `${BASE}/assets/${encodeURIComponent(id)}/file`,
  download: (id: string) => `${BASE}/assets/${encodeURIComponent(id)}/download`,
};
