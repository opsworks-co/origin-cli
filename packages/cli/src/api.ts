import { loadConfig, type Profile } from './config.js';

function getConfig() {
  const config = loadConfig();
  if (!config) throw new Error('Not logged in. Run: origin login');
  return config;
}

// Default HTTP timeout for CLI→API calls. Without this, a stalled or
// unresponsive Origin API would hang every CLI command indefinitely
// (git hooks, session start/end, PR reviews). 30s is long enough for
// slow networks but short enough that users get a real error instead
// of an invisible hang. Override via ORIGIN_HTTP_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = Number(process.env.ORIGIN_HTTP_TIMEOUT_MS) || 30_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Retry wrapper: exponential backoff on 5xx + network errors. 4xx responses
// are NOT retried — those indicate client-side issues (bad auth, invalid
// body, missing resource) that retrying won't fix. Transient 5xx + fetch
// failures (DNS, connection refused, reset) get up to 2 retries with
// jittered delays of ~200ms, ~500ms. Keeps hook commands responsive on
// flaky networks without hammering a genuinely broken API.
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 200;
async function fetchWithRetry(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);
      // Retry server errors (5xx). Don't retry 4xx — those are deterministic.
      if (res.status >= 500 && res.status <= 599 && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      // Don't retry AbortError/timeouts — the user's command already waited
      // the full budget; retrying just doubles the pain.
      const msg = (err as Error).message || '';
      if (msg.includes('timed out')) throw err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function request(path: string, opts: RequestInit = {}) {
  const config = getConfig();
  const res = await fetchWithRetry(`${config.apiUrl}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
      ...opts.headers as Record<string, string>,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    const err = new Error(body?.message || body?.error || res.statusText) as any;
    err.status = res.status;
    err.serverError = body?.error;
    err.serverMessage = body?.message;
    throw err;
  }
  return res.json();
}

/** Make an API request using a specific profile (for multi-account) */
export async function requestWithProfile(profile: Profile, path: string, opts: RequestInit = {}) {
  const res = await fetchWithRetry(`${profile.apiUrl}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': profile.apiKey,
      ...opts.headers as Record<string, string>,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    throw new Error(body?.message || body?.error || res.statusText);
  }
  return res.json();
}

export const api = {
  request,
  getWhoami: () => request('/api/mcp/whoami'),
  getPolicies: () => request('/api/mcp/policies'),
  registerMachine: (data: any) => request('/api/machines', { method: 'POST', body: JSON.stringify(data) }),
  getMachines: () => request('/api/machines'),
  syncRepo: (id: string) => request(`/api/repos/${id}/sync`, { method: 'POST' }),
  getRepos: () => request('/api/repos'),
  getMe: () => request('/api/auth/me'),

  // Session lifecycle (MCP API — used by hooks)
  startSession: (data: {
    machineId: string;
    prompt: string;
    model: string;
    repoPath: string;
    repoUrl?: string;
    agentSlug?: string;
    branch?: string;
    hostname?: string;
    agentSessionId?: string;
  }) =>
    request('/api/mcp/session/start', { method: 'POST', body: JSON.stringify(data) }),
  updateSession: (id: string, data: any) =>
    request(`/api/mcp/session/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  resumeSession: (id: string) =>
    request(`/api/mcp/session/${id}/resume`, { method: 'POST' }),
  endSession: (data: any) =>
    request('/api/mcp/session/end', { method: 'POST', body: JSON.stringify(data) }),
  pingSession: (id: string) =>
    request(`/api/mcp/session/${id}/ping`, { method: 'POST' }),

  // Sessions (web API)
  getSessions: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/sessions${q ? `?${q}` : ''}`);
  },
  getSession: (id: string) => request(`/api/sessions/${id}`),
  reviewSession: (id: string, status: string, note?: string) =>
    request(`/api/sessions/${id}/review`, { method: 'POST', body: JSON.stringify({ status, note }) }),
  shareSession: (id: string) =>
    request(`/api/sessions/${id}/share`, { method: 'POST' }),
  endSessionById: (id: string) =>
    request(`/api/sessions/${id}/end`, { method: 'POST' }),

  // Agents
  getMyAgents: () => request('/api/agents/my'),
  getAgents: () => request('/api/agents'),
  getAgent: (id: string) => request(`/api/agents/${id}`),
  createAgent: (data: any) => request('/api/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: any) => request(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => request(`/api/agents/${id}`, { method: 'DELETE' }),

  // Repos
  createRepo: (data: any) => request('/api/repos', { method: 'POST', body: JSON.stringify(data) }),
  deleteRepo: (id: string) => request(`/api/repos/${id}`, { method: 'DELETE' }),

  // Policies (CRUD)
  createPolicy: (data: any) => request('/api/policies', { method: 'POST', body: JSON.stringify(data) }),
  deletePolicy: (id: string) => request(`/api/policies/${id}`, { method: 'DELETE' }),

  // PR Review (CLI)
  reviewPR: (url: string) => request(`/api/pull-requests/review?url=${encodeURIComponent(url)}`),

  // Audit
  getAuditLogs: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/audit${q ? `?${q}` : ''}`);
  },

  // Stats
  getStats: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/stats${q ? `?${q}` : ''}`);
  },

  // Versioning
  getPolicyVersions: (id: string) => request(`/api/policies/${id}/versions`),
  getAgentVersions: (id: string) => request(`/api/agents/${id}/versions`),

  // Notifications
  getNotifications: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/notifications${q ? `?${q}` : ''}`);
  },
  getUnreadCount: () => request('/api/notifications/unread-count'),
  markAllRead: () => request('/api/notifications/read-all', { method: 'PUT' }),

  // Users / Team
  getUsers: () => request('/api/users'),
  getUser: (id: string) => request(`/api/users/${id}`),

  // Pricing
  getPricing: () => request('/api/pricing'),

  // Secret findings (pre-commit hook)
  reportSecrets: (sessionId: string, findings: any[]) =>
    request(`/api/sessions/${sessionId}/secrets`, {
      method: 'POST',
      body: JSON.stringify({ findings, source: 'pre-commit' }),
    }),

  reportViolation: (data: { machineId: string; policyId: string; description: string; filepath?: string }) =>
    request('/api/mcp/violations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
