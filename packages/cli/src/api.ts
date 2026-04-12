import { loadConfig } from './config.js';

function getConfig() {
  const config = loadConfig();
  if (!config) throw new Error('Not logged in. Run: origin login');
  return config;
}

/** Ensure a parsed API response is a non-null object. */
function assertObj(res: unknown, label: string): asserts res is Record<string, unknown> {
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    throw new Error(`Invalid API response for ${label}: expected object, got ${res === null ? 'null' : typeof res}`);
  }
}

/** Ensure a parsed API response is a non-null object with specific required fields. */
function assertFields(res: unknown, label: string, fields: string[]): asserts res is Record<string, unknown> {
  assertObj(res, label);
  for (const f of fields) {
    if ((res as Record<string, unknown>)[f] === undefined) {
      throw new Error(`Invalid API response for ${label}: missing required field '${f}'`);
    }
  }
}

async function request(path: string, opts: RequestInit = {}) {
  const config = getConfig();
  const res = await fetch(`${config.apiUrl}${path}`, {
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

export const api = {
  getPolicies: () => request('/api/mcp/policies'),
  registerMachine: (data: any) => request('/api/machines', { method: 'POST', body: JSON.stringify(data) }),
  getMachines: () => request('/api/machines'),
  syncRepo: (id: string) => request(`/api/repos/${id}/sync`, { method: 'POST' }),
  getRepos: () => request('/api/repos'),
  getWhoami: () => request('/api/mcp/whoami'),
  getMe: async () => {
    const res = await request('/api/auth/me');
    assertObj(res, 'getMe');
    return res;
  },

  // Session lifecycle (MCP API — used by hooks)
  startSession: async (data: {
    machineId: string;
    prompt: string;
    model: string;
    repoPath: string;
    repoUrl?: string;
    agentSlug?: string;
    branch?: string;
    hostname?: string;
    additionalRepoPaths?: string[];
    agentSessionId?: string;
  }) => {
    const res = await request('/api/mcp/session/start', { method: 'POST', body: JSON.stringify(data) });
    assertFields(res, 'startSession', ['sessionId']);
    return res;
  },
  updateSession: async (id: string, data: any) => {
    const res = await request(`/api/mcp/session/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    assertObj(res, 'updateSession');
    return res;
  },
  resumeSession: async (id: string) => {
    const res = await request(`/api/mcp/session/${id}/resume`, { method: 'POST' });
    assertObj(res, 'resumeSession');
    return res;
  },
  endSession: async (data: any) => {
    const res = await request('/api/mcp/session/end', { method: 'POST', body: JSON.stringify(data) });
    assertObj(res, 'endSession');
    return res;
  },
  pingSession: (id: string) =>
    request(`/api/mcp/session/${id}/ping`, { method: 'POST' }),

  // Sessions (web API)
  getSessions: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/sessions${q ? `?${q}` : ''}`);
  },
  getSession: async (id: string) => {
    const res = await request(`/api/sessions/${id}`);
    assertObj(res, 'getSession');
    return res;
  },
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
  getStats: async (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    const res = await request(`/api/stats${q ? `?${q}` : ''}`);
    assertObj(res, 'getStats');
    return res;
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
  getPricing: async () => {
    const res = await request('/api/pricing');
    assertObj(res, 'getPricing');
    return res;
  },

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
