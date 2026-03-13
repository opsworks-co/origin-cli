import { loadConfig } from './config.js';

function getConfig() {
  const config = loadConfig();
  if (!config) throw new Error('Not logged in. Run: origin login');
  return config;
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
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.error ?? res.statusText);
  }
  return res.json();
}

export const api = {
  getPolicies: () => request('/api/mcp/policies'),
  registerMachine: (data: any) => request('/api/machines', { method: 'POST', body: JSON.stringify(data) }),
  getMachines: () => request('/api/machines'),
  syncRepo: (id: string) => request(`/api/repos/${id}/sync`, { method: 'POST' }),
  getRepos: () => request('/api/repos'),
  getMe: () => request('/api/auth/me'),

  // Session lifecycle (MCP API — used by hooks)
  startSession: (data: any) =>
    request('/api/mcp/session/start', { method: 'POST', body: JSON.stringify(data) }),
  updateSession: (id: string, data: any) =>
    request(`/api/mcp/session/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  resumeSession: (id: string) =>
    request(`/api/mcp/session/${id}/resume`, { method: 'POST' }),
  endSession: (data: any) =>
    request('/api/mcp/session/end', { method: 'POST', body: JSON.stringify(data) }),

  // Sessions (web API)
  getSessions: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/sessions${q ? `?${q}` : ''}`);
  },
  getSession: (id: string) => request(`/api/sessions/${id}`),
  reviewSession: (id: string, status: string, note?: string) =>
    request(`/api/sessions/${id}/review`, { method: 'POST', body: JSON.stringify({ status, note }) }),

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

  // Audit
  getAuditLogs: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/audit${q ? `?${q}` : ''}`);
  },

  // Stats
  getStats: () => request('/api/stats'),

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
};
