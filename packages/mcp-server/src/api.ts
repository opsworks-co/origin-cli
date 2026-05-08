import { loadConfig } from './config.js';

export async function originRequest(path: string, opts: RequestInit = {}) {
  const config = loadConfig();
  if (!config) throw new Error('Origin not configured. Run: origin login && origin enable');

  const res = await fetch(`${config.apiUrl}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
      ...(opts.headers as Record<string, string> || {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchPolicies() {
  return originRequest('/api/mcp/policies');
}

export async function startSession(data: { machineId: string; prompt: string; model: string; repoPath: string }) {
  return originRequest('/api/mcp/session/start', { method: 'POST', body: JSON.stringify(data) });
}

export async function endSession(data: {
  sessionId: string;
  summary: string;
  tokensUsed: number;
  toolCalls: number;
  linesAdded?: number;
  linesRemoved?: number;
  costUsd?: number;
  filesChanged?: string;
  durationMs?: number;
  // Full conversation transcript — JSON string of [{role, content}, …]. Without
  // this the Session tab only shows the synthesized prompt-only fallback,
  // which is why MCP-driven Gemini sessions historically rendered as a
  // single user prompt + diff with no assistant text.
  transcript?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}) {
  return originRequest('/api/mcp/session/end', { method: 'POST', body: JSON.stringify(data) });
}

// PATCH /session/:id — incremental update during an active session. Use this
// to stream transcript additions, token counts, and file changes mid-flight
// so the dashboard shows live state instead of waiting for end_session.
export async function updateSession(sessionId: string, data: {
  prompt?: string;
  transcript?: string;
  filesChanged?: string[];
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolCalls?: number;
  linesAdded?: number;
  linesRemoved?: number;
  model?: string;
  durationMs?: number;
  costUsd?: number;
  branch?: string;
  status?: string;
}) {
  return originRequest(`/api/mcp/session/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function reportViolation(data: { machineId: string; policyId: string; description: string; filepath: string }) {
  return originRequest('/api/mcp/violations', { method: 'POST', body: JSON.stringify(data) });
}

export async function logToolCall(data: { sessionId: string; tool: string; args: string; result: string }) {
  return originRequest('/api/mcp/session/tool-call', { method: 'POST', body: JSON.stringify(data) });
}

// Sessions
export async function listSessions(params?: Record<string, string>) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return originRequest(`/api/sessions${q}`);
}

export async function getSession(id: string) {
  return originRequest(`/api/sessions/${id}`);
}

export async function reviewSession(id: string, status: string, note?: string) {
  return originRequest(`/api/sessions/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ status, note }),
  });
}

// Agents
export async function listAgents() {
  return originRequest('/api/agents');
}

// Repos
export async function listRepos() {
  return originRequest('/api/repos');
}

// Stats
export async function getStats() {
  return originRequest('/api/stats');
}

// Audit
export async function listAuditLogs(params?: Record<string, string>) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return originRequest(`/api/audit${q}`);
}

// Versioning
export async function getPolicyVersions(id: string) {
  return originRequest(`/api/policies/${id}/versions`);
}

export async function getAgentVersions(id: string) {
  return originRequest(`/api/agents/${id}/versions`);
}

// Notifications
export async function listNotifications(params?: Record<string, string>) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  return originRequest(`/api/notifications${q}`);
}

export async function getUnreadCount() {
  return originRequest('/api/notifications/unread-count');
}

// Users / Team
export async function listUsers() {
  return originRequest('/api/users');
}
