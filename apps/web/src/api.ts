// ---------------------------------------------------------------------------
// Origin v2 — typed API client
// All requests go through the Vite dev-server proxy so base URL is empty.
// ---------------------------------------------------------------------------

const BASE = '';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('origin_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(opts.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as any)?.error ?? (body as any)?.message ?? res.statusText;
    throw new Error(msg);
  }

  // 204 No Content
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ---- Auth ----------------------------------------------------------------

export interface AuthResponse {
  token: string;
  user: User;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
}

export function login(email: string, password: string) {
  return request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register(
  email: string,
  password: string,
  name: string,
  orgName: string,
  orgSlug: string,
) {
  return request<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, orgName, orgSlug }),
  });
}

export function getMe() {
  return request<User>('/api/auth/me');
}

// ---- Repos ---------------------------------------------------------------

export interface Repo {
  id: string;
  name: string;
  provider: string;
  remoteUrl: string;
  defaultBranch: string;
  createdAt: string;
}

export interface Commit {
  id: string;
  sha: string;
  message: string;
  author: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  aiAuthored: boolean;
  createdAt: string;
}

export function getRepos() {
  return request<Repo[]>('/api/repos');
}

export function createRepo(data: { name: string; remoteUrl: string; provider?: string }) {
  return request<Repo>('/api/repos', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function syncRepo(id: string) {
  return request<{ message: string }>(`/api/repos/${id}/sync`, { method: 'POST' });
}

export function getRepoCommits(id: string) {
  return request<Commit[]>(`/api/repos/${id}/commits`);
}

// ---- Sessions ------------------------------------------------------------

export interface Session {
  id: string;
  agentId: string;
  agentName?: string;
  repoId?: string;
  repoName?: string;
  model: string;
  status: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  toolCalls: number;
  commitSha?: string;
  commitMessage?: string;
  durationMs: number;
  transcript: { role: string; content: string }[];
  review?: SessionReview;
  createdAt: string;
  endedAt?: string;
}

export interface SessionReview {
  id: string;
  status: string;
  note?: string;
  reviewerName?: string;
  createdAt: string;
}

export interface SessionListParams {
  model?: string;
  status?: string;
  agentId?: string;
  repoId?: string;
  limit?: number;
  offset?: number;
}

export function getSessions(params?: SessionListParams) {
  const q = new URLSearchParams();
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') q.set(k, String(v));
    });
  }
  const qs = q.toString();
  return request<{ sessions: Session[]; total: number }>(`/api/sessions${qs ? `?${qs}` : ''}`);
}

export function getSession(id: string) {
  return request<Session>(`/api/sessions/${id}`);
}

export function reviewSession(id: string, status: string, note?: string) {
  return request<SessionReview>(`/api/sessions/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ status, note }),
  });
}

// ---- Agents --------------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  model: string;
  provider: string;
  apiKeyPrefix?: string;
  totalSessions: number;
  totalCost: number;
  lastActiveAt?: string;
  createdAt: string;
}

export function getAgents() {
  return request<Agent[]>('/api/agents');
}

export function createAgent(data: { name: string; model: string; provider?: string }) {
  return request<Agent>('/api/agents', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getAgent(id: string) {
  return request<Agent>(`/api/agents/${id}`);
}

export function updateAgent(id: string, data: Partial<Agent>) {
  return request<Agent>(`/api/agents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ---- Policies ------------------------------------------------------------

export interface PolicyRule {
  id: string;
  field: string;
  operator: string;
  value: string;
}

export interface Policy {
  id: string;
  name: string;
  type: string;
  description?: string;
  active: boolean;
  rules: PolicyRule[];
  createdAt: string;
}

export function getPolicies() {
  return request<Policy[]>('/api/policies');
}

export function createPolicy(data: { name: string; type: string; description?: string }) {
  return request<Policy>('/api/policies', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updatePolicy(id: string, data: Partial<Policy>) {
  return request<Policy>(`/api/policies/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deletePolicy(id: string) {
  return request<void>(`/api/policies/${id}`, { method: 'DELETE' });
}

export function createPolicyRule(policyId: string, data: { field: string; operator: string; value: string }) {
  return request<PolicyRule>(`/api/policies/${policyId}/rules`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ---- Audit ---------------------------------------------------------------

export interface AuditEntry {
  id: string;
  userId: string;
  userName?: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditParams {
  action?: string;
  limit?: number;
  offset?: number;
}

export function getAuditLogs(params?: AuditParams) {
  const q = new URLSearchParams();
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') q.set(k, String(v));
    });
  }
  const qs = q.toString();
  return request<{ entries: AuditEntry[]; total: number }>(`/api/audit${qs ? `?${qs}` : ''}`);
}

// ---- Stats / Insights ----------------------------------------------------

export interface Stats {
  activeAgents: number;
  sessionsThisWeek: number;
  unreviewed: number;
  policyViolations: number;
  estimatedCostThisMonth: number;
  linesWrittenThisMonth: number;
  costByModel: { model: string; cost: number }[];
  sessionsByRepo: { repo: string; count: number }[];
  aiAuthorshipOverTime: { date: string; percent: number }[];
  topEngineers: { name: string; sessions: number }[];
}

export function getStats() {
  return request<Stats>('/api/stats');
}
