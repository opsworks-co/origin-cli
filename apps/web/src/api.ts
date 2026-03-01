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
  path: string;
  provider: string;
  syncedAt: string | null;
  createdAt: string;
  _count?: { commits: number };
}

export function getRepos() {
  return request<Repo[]>('/api/repos');
}

export function createRepo(data: { name: string; path: string; provider?: string }) {
  return request<Repo>('/api/repos', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function syncRepo(id: string) {
  return request<{ synced: number; total: number }>(`/api/repos/${id}/sync`, { method: 'POST' });
}

export function getRepoCommits(id: string) {
  return request<any[]>(`/api/repos/${id}/commits`);
}

// ---- Sessions ------------------------------------------------------------

export interface Session {
  id: string;
  commitId: string;
  agentId: string | null;
  agentName: string | null;
  repoId: string | null;
  repoName: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  committedAt: string | null;
  model: string;
  prompt: string;
  transcript: string;
  filesChanged: string;
  tokensUsed: number;
  toolCalls: number;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  costUsd: number;
  createdAt: string;
  review: SessionReview | null;
}

export interface SessionReview {
  id: string;
  status: string;
  note: string | null;
  reviewerName: string | null;
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
  return request<any>(`/api/sessions/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ status, note }),
  });
}

// ---- Agents --------------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  model: string;
  status: string;
  createdAt: string;
  _count?: { sessions: number };
  sessions?: any[];
}

export function getAgents() {
  return request<Agent[]>('/api/agents');
}

export function createAgent(data: { name: string; slug: string; model: string; description?: string }) {
  return request<Agent>('/api/agents', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getAgent(id: string) {
  return request<Agent>(`/api/agents/${id}`);
}

export function updateAgent(id: string, data: Partial<{ name: string; description: string; model: string; status: string }>) {
  return request<Agent>(`/api/agents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ---- Policies ------------------------------------------------------------

export interface PolicyRule {
  id: string;
  policyId: string;
  agentId: string | null;
  condition: string;
  action: string;
  severity: string;
  agent?: { name: string } | null;
}

export interface Policy {
  id: string;
  name: string;
  type: string;
  description: string | null;
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

export function updatePolicy(id: string, data: Partial<{ name: string; description: string; type: string; active: boolean }>) {
  return request<Policy>(`/api/policies/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deletePolicy(id: string) {
  return request<void>(`/api/policies/${id}`, { method: 'DELETE' });
}

export function createPolicyRule(policyId: string, data: { condition: string; action: string; severity?: string; agentId?: string }) {
  return request<PolicyRule>(`/api/policies/${policyId}/rules`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ---- Audit ---------------------------------------------------------------

export interface AuditEntry {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  resource: string | null;
  metadata: string;
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
  totalSessions: number;
  activeAgents: number;
  sessionsThisWeek: number;
  aiPercentage: number;
  tokensUsed: number;
  costUsd: number;
  estimatedCostThisMonth: number;
  linesWrittenThisMonth: number;
  unreviewed: number;
  modelBreakdown: Record<string, number>;
  costByModel: { model: string; cost: number; count: number }[];
  sessionsByDay: { date: string; count: number }[];
  sessionsByRepo: { repo: string; count: number }[];
  aiAuthorshipOverTime: { date: string; percent: number }[];
  topAgents: { id: string; name: string; model: string; count: number }[];
  topEngineers: { name: string; sessions: number }[];
  policyViolations: number;
  linesAdded: number;
  linesRemoved: number;
}

export function getStats() {
  return request<Stats>('/api/stats');
}

// ---- Machines ---------------------------------------------------------------

export interface Machine {
  id: string;
  hostname: string;
  machineId: string;
  detectedTools: string; // JSON array
  lastSeenAt: string;
  createdAt: string;
}

export function getMachines() {
  return request<Machine[]>('/api/machines');
}

// ---- API Key Management -----------------------------------------------------

export function createApiKey(data: { name: string }) {
  return request<{ id: string; key: string; keyPrefix: string }>('/api/auth/api-keys', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getApiKeys() {
  return request<Array<{ id: string; name: string; keyPrefix: string; createdAt: string }>>('/api/auth/api-keys');
}

export function deleteApiKey(id: string) {
  return request<void>(`/api/auth/api-keys/${id}`, { method: 'DELETE' });
}

// ---- Delete Operations -------------------------------------------------------

export function deleteRepo(id: string) {
  return request<void>(`/api/repos/${id}`, { method: 'DELETE' });
}

export function updateRepo(id: string, data: Partial<{ name: string; path: string; provider: string }>) {
  return request<Repo>(`/api/repos/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteAgent(id: string) {
  return request<void>(`/api/agents/${id}`, { method: 'DELETE' });
}

export function deletePolicyRule(policyId: string, ruleId: string) {
  return request<void>(`/api/policies/${policyId}/rules/${ruleId}`, { method: 'DELETE' });
}

// ---- Bulk Operations ---------------------------------------------------------

export function bulkReviewSessions(sessionIds: string[], status: string, note?: string) {
  return Promise.all(
    sessionIds.map((id) => reviewSession(id, status, note))
  );
}
