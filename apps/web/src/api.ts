// ---------------------------------------------------------------------------
// Origin v2 — typed API client
// All requests go through the Vite dev-server proxy so base URL is empty.
// ---------------------------------------------------------------------------

const BASE = '';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('origin_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
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
  apiKey?: string; // Auto-generated for solo developer accounts
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  accountType: 'org' | 'developer';
  avatarUrl: string | null;
  orgId: string;
  orgName: string;
  orgSlug: string;
}

export function updateProfile(data: { name?: string; email?: string; avatarUrl?: string }) {
  return request<User>('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
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

export function registerDeveloper(email: string, password: string, name: string) {
  return request<AuthResponse>('/api/auth/register/developer', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });
}

export function getOAuthUrl(provider: 'github' | 'gitlab' | 'google') {
  return request<{ url: string }>(`/api/auth/oauth/${provider}`);
}

export function oauthCallback(provider: string, code: string, accountType?: string) {
  return request<AuthResponse>(`/api/auth/oauth/${provider}/callback`, {
    method: 'POST',
    body: JSON.stringify({ code, accountType }),
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
  archived: boolean;
  syncedAt: string | null;
  createdAt: string;
  _count?: { commits: number; sessions?: number };
}

export function getRepos(params?: { archived?: boolean }) {
  const q = new URLSearchParams();
  if (params?.archived) q.set('archived', 'true');
  const qs = q.toString();
  return request<Repo[]>(`/api/repos${qs ? `?${qs}` : ''}`);
}

export function archiveRepo(id: string, archived: boolean) {
  return request<Repo>(`/api/repos/${id}/archive`, {
    method: 'PATCH',
    body: JSON.stringify({ archived }),
  });
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

export function rescanRepoCommits(id: string) {
  return request<{ total: number; updated: number; githubMessages: number }>(`/api/repos/${id}/rescan`, { method: 'POST' });
}

export function importSessionsFromBranch(id: string) {
  return request<{ imported: number; skipped: number; total: number }>(`/api/repos/${id}/import-sessions`, { method: 'POST' });
}

export function getRepoCommits(id: string, branch?: string) {
  const q = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  return request<any[]>(`/api/repos/${id}/commits${q}`);
}

export function getRepoBranches(id: string) {
  return request<{ branches: string[] }>(`/api/repos/${id}/branches`);
}

export interface CommitDiff {
  sha: string;
  message: string;
  author: string;
  date: string;
  stats: { additions: number; deletions: number; total: number };
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch: string;
    previousFilename: string | null;
  }>;
  htmlUrl: string | null;
}

export function getCommitDiff(repoId: string, sha: string) {
  return request<CommitDiff>(`/api/repos/${repoId}/commits/${sha}/diff`);
}

// ---- GitHub Auto-Discovery -----------------------------------------------

export interface GitHubDiscoveredRepo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  url: string;
  defaultBranch: string;
  alreadyImported: boolean;
  originRepoId?: string;
}

export interface ImportResult {
  fullName: string;
  success: boolean;
  repoId?: string;
  error?: string;
}

export function discoverGitHubRepos() {
  return request<{ repos: GitHubDiscoveredRepo[] }>('/api/repos/github/discover');
}

export function importGitHubRepos(repos: Array<{ fullName: string; name?: string }>) {
  return request<{ results: ImportResult[] }>('/api/repos/github/import', {
    method: 'POST',
    body: JSON.stringify({ repos, originBaseUrl: window.location.origin }),
  });
}

// ---- GitLab Auto-Discovery -----------------------------------------------

export interface GitLabDiscoveredRepo {
  id: number;
  name: string;
  fullPath: string;
  private: boolean;
  url: string;
  defaultBranch: string;
  alreadyImported: boolean;
  originRepoId?: string;
}

export interface GitLabImportResult {
  fullPath: string;
  success: boolean;
  repoId?: string;
  error?: string;
}

export function discoverGitLabRepos() {
  return request<{ repos: GitLabDiscoveredRepo[] }>('/api/repos/gitlab/discover');
}

export function importGitLabRepos(repos: Array<{ fullPath: string; name?: string }>) {
  return request<{ results: GitLabImportResult[] }>('/api/repos/gitlab/import', {
    method: 'POST',
    body: JSON.stringify({ repos, originBaseUrl: window.location.origin }),
  });
}

// ---- Sessions ------------------------------------------------------------

export interface SessionDiff {
  headBefore: string;
  headAfter: string;
  commitShas: string[];
  diff: string;
  diffTruncated: boolean;
  linesAdded: number;
  linesRemoved: number;
}

export interface PromptChange {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  diff: string;
  uncommittedDiff?: string;
  createdAt?: string;
}

export interface Session {
  id: string;
  commitId: string;
  agentId: string | null;
  agentName: string | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
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
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  costUsd: number;
  branch: string | null;
  status: string;
  archived: boolean;
  startedAt: string | null;
  endedAt: string | null;
  agentSystemPrompt: string | null;
  agentVersion: number | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  createdAt: string;
  review: SessionReview | null;
  pullRequests?: PullRequestInfo[];
  sessionDiff?: SessionDiff | null;
  promptChanges?: PromptChange[];
}

export interface SessionReview {
  id: string;
  status: string;
  note: string | null;
  score: number | null;
  riskLevel: string | null;
  concerns: string[];
  suggestions: string[];
  categories: { security: number; scope: number; quality: number; cost: number } | null;
  isAutoReview: boolean;
  reviewerName: string | null;
  createdAt: string;
}

export interface SessionListParams {
  model?: string;
  status?: string;
  agentId?: string;
  repoId?: string;
  branch?: string;
  userId?: string;
  archived?: string;
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
  return request<{ sessions: Session[]; total: number; aggregates?: { totalCost: number; totalTokens: number; totalDuration: number; totalTools: number; avgCost: number; avgDuration: number; avgScore: number | null; flaggedCount: number } }>(`/api/sessions${qs ? `?${qs}` : ''}`);
}

export function getSession(id: string) {
  return request<Session>(`/api/sessions/${id}`);
}

export function getActiveSessions() {
  return request<{ sessions: Session[] }>('/api/sessions/active');
}

export function reviewSession(id: string, status: string, note?: string) {
  return request<any>(`/api/sessions/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ status, note }),
  });
}

export function triggerAIReview(id: string) {
  return request<any>(`/api/sessions/${id}/ai-review`, { method: 'POST' });
}

export function getSessionDiff(id: string) {
  return request<SessionDiff | { diff: null }>(`/api/sessions/${id}/diff`);
}

// ---- AI Blame (line-level attribution) ------------------------------------

export interface BlameAttribution {
  promptIndex: number;
  promptText: string;
  type: 'added' | 'modified';
}

export interface BlameLine {
  lineNumber: number;
  content: string;
  attribution: BlameAttribution | null;
  isGap?: boolean;
}

export interface BlamePromptInfo {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
}

export interface BlameResult {
  file: string;
  sessionId: string;
  model: string;
  totalAttributedLines: number;
  lines: BlameLine[];
  prompts: BlamePromptInfo[];
}

export function getSessionBlame(sessionId: string, file: string) {
  return request<BlameResult>(`/api/sessions/${sessionId}/blame?file=${encodeURIComponent(file)}`);
}

// ---- Ask the Author -------------------------------------------------------

export function askSessionAuthor(
  sessionId: string,
  data: {
    question?: string;
    context?: { file?: string; promptIndex?: number };
    messages?: Array<{ role: string; content: string }>;
  },
) {
  return request<{ answer: string }>(`/api/sessions/${sessionId}/ask`, {
    method: 'POST',
    body: JSON.stringify(data),
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
  systemPrompt: string | null;
  securityRulesEnabled: boolean;
  securityRules: string | null;
  allowedTools: string;        // JSON array string
  maxCostPerSession: number | null;
  maxTokensPerSession: number | null;
  permissions: string;         // JSON object string
  createdAt: string;
  updatedAt: string;
  _count?: { sessions: number; versions: number };
  sessions?: any[];
}

export function getAgents() {
  return request<Agent[]>('/api/agents');
}

export interface AgentCreateData {
  name: string;
  slug: string;
  model: string;
  description?: string;
  systemPrompt?: string;
  securityRulesEnabled?: boolean;
  securityRules?: string;
  allowedTools?: string[];
  maxCostPerSession?: number;
  maxTokensPerSession?: number;
  permissions?: Record<string, any>;
}

export interface AgentUpdateData {
  name?: string;
  description?: string;
  model?: string;
  status?: string;
  systemPrompt?: string;
  securityRulesEnabled?: boolean;
  securityRules?: string;
  allowedTools?: string[];
  maxCostPerSession?: number | null;
  maxTokensPerSession?: number | null;
  permissions?: Record<string, any>;
}

export function createAgent(data: AgentCreateData) {
  return request<Agent>('/api/agents', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getAgent(id: string) {
  return request<Agent>(`/api/agents/${id}`);
}

export function updateAgent(id: string, data: AgentUpdateData) {
  return request<Agent>(`/api/agents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteAgent(id: string) {
  return request<{ success: boolean }>(`/api/agents/${id}`, { method: 'DELETE' });
}

export function restoreAgentVersion(agentId: string, versionId: string) {
  return request<Agent>(`/api/agents/${agentId}/restore/${versionId}`, { method: 'POST' });
}

// ---- Policies ------------------------------------------------------------

export interface PolicyRule {
  id: string;
  policyId: string;
  agentId: string | null;
  machineId: string | null;
  repoId: string | null;
  condition: string;
  action: string;
  severity: string;
  agent?: { name: string } | null;
  machine?: { hostname: string } | null;
  repo?: { name: string } | null;
}

export interface PolicyAssignment {
  id: string;
  policyId: string;
  agentId: string;
  agent: { id: string; name: string; slug: string };
}

export interface Policy {
  id: string;
  name: string;
  type: string;
  description: string | null;
  active: boolean;
  rules: PolicyRule[];
  assignments?: PolicyAssignment[];
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

export function createPolicyRule(policyId: string, data: { condition: string; action: string; severity?: string; agentId?: string; machineId?: string; repoId?: string }) {
  return request<PolicyRule>(`/api/policies/${policyId}/rules`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function createPolicyFromNaturalLanguage(prompt: string) {
  return request<{ policies: Policy[]; parsed: any[]; message: string }>('/api/policies/from-natural-language', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
}

export function updatePolicyAssignments(policyId: string, agentIds: string[]) {
  return request<{ assignments: PolicyAssignment[] }>(`/api/policies/${policyId}/assignments`, {
    method: 'PUT',
    body: JSON.stringify({ agentIds }),
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
  activeSessions: number;
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
  // Enriched fields
  costByDay: { date: string; cost: number }[];
  tokensByDay: { date: string; tokens: number }[];
  durationBuckets: { bucket: string; count: number }[];
  topContributors: { id: string; name: string; sessions: number; cost: number; lines: number }[];
  qualityMetrics: { approved: number; rejected: number; flagged: number; pending: number };
  violationsByType: { type: string; count: number }[];
  avgSessionCost: number;
  avgSessionDuration: number;
  avgSessionTokens: number;
  costByUser: { userId: string; name: string; cost: number }[];
  // Enhanced analytics fields
  costByRepo: { repo: string; cost: number; sessions: number }[];
  linesByDay: { date: string; added: number; removed: number }[];
  sessionsByHour: { hour: number; count: number }[];
  secretsByType: { type: string; count: number }[];
  totalSecretFindings: number;
  // Cost forecasting
  projectedMonthlyCost?: number;
  dailyCostTrend?: number;
  daysInMonth?: number;
  daysElapsed?: number;
  // Onboarding
  totalRepos?: number;
  totalUsers?: number;
}

export function getStats(from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return request<Stats>(`/api/stats${qs ? `?${qs}` : ''}`);
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

export function deleteMachine(id: string) {
  return request<{ success: boolean }>(`/api/machines/${id}`, { method: 'DELETE' });
}

export interface MachineDetail extends Machine {
  policyRules: Array<PolicyRule & {
    policy: { id: string; name: string; type: string; active: boolean };
  }>;
}

export function getMachine(id: string) {
  return request<MachineDetail>(`/api/machines/${id}`);
}

// ---- API Key Management -----------------------------------------------------

export function createApiKey(data: { name: string; role?: string; repoIds?: string[]; agentIds?: string[] }) {
  return request<{ id: string; key: string; keyPrefix: string; role: string | null; repoScopes: { repoId: string; repoName: string }[]; agentScopes: { agentId: string; agentName: string; agentSlug: string }[] }>('/api/settings/api-keys', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getApiKeys() {
  return request<Array<{
    id: string; name: string; keyPrefix: string; createdAt: string;
    userId: string | null; role: string | null;
    user: { name: string; email: string } | null;
    repoScopes: { repoId: string; repoName: string }[];
    agentScopes: { agentId: string; agentName: string; agentSlug: string }[];
  }>>('/api/settings/api-keys');
}

export function updateApiKey(id: string, data: { agentIds?: string[]; repoIds?: string[] }) {
  return request<{ id: string; repoScopes: { repoId: string; repoName: string }[]; agentScopes: { agentId: string; agentName: string; agentSlug: string }[] }>(`/api/settings/api-keys/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteApiKey(id: string) {
  return request<void>(`/api/settings/api-keys/${id}`, { method: 'DELETE' });
}

// ---- Delete Operations -------------------------------------------------------

export function deleteSession(id: string) {
  return request<void>(`/api/sessions/${id}`, { method: 'DELETE' });
}

export function endSession(id: string) {
  return request<{ success: boolean }>(`/api/sessions/${id}/end`, { method: 'POST' });
}

export function archiveSession(id: string, archived = true) {
  return request<{ success: boolean }>(`/api/sessions/${id}/archive`, {
    method: 'PATCH',
    body: JSON.stringify({ archived }),
  });
}

export function bulkArchiveSessions(sessionIds: string[], archived = true) {
  return request<{ success: boolean; count: number }>(`/api/sessions/bulk/archive`, {
    method: 'PATCH',
    body: JSON.stringify({ sessionIds, archived }),
  });
}

export function deleteRepo(id: string) {
  return request<void>(`/api/repos/${id}`, { method: 'DELETE' });
}

export function updateRepo(id: string, data: Partial<{ name: string; path: string; provider: string }>) {
  return request<Repo>(`/api/repos/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
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

// ---- Versioning --------------------------------------------------------------

export interface PolicyVersion {
  id: string;
  policyId: string;
  version: number;
  snapshot: any;
  changedBy: string | null;
  changeType: string;
  createdAt: string;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  snapshot: any;
  changedBy: string | null;
  changeType: string;
  createdAt: string;
}

export function getPolicyVersions(policyId: string) {
  return request<{ versions: PolicyVersion[]; total: number }>(`/api/policies/${policyId}/versions`);
}

export function getAgentVersions(agentId: string) {
  return request<{ versions: AgentVersion[]; total: number }>(`/api/agents/${agentId}/versions`);
}

// ---- Notifications -----------------------------------------------------------

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  readAt: string | null;
  metadata: any;
  createdAt: string;
}

export function getNotifications(params?: { unread?: boolean; limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (params?.unread) q.set('unread', 'true');
  if (params?.limit) q.set('limit', String(params.limit));
  if (params?.offset) q.set('offset', String(params.offset));
  const qs = q.toString();
  return request<{ notifications: Notification[]; total: number }>(`/api/notifications${qs ? `?${qs}` : ''}`);
}

export function getUnreadCount() {
  return request<{ count: number }>('/api/notifications/unread-count');
}

export function markNotificationRead(id: string) {
  return request<Notification>(`/api/notifications/${id}/read`, { method: 'PUT' });
}

export function markAllNotificationsRead() {
  return request<{ success: boolean }>('/api/notifications/read-all', { method: 'PUT' });
}

// ---- Webhooks ----------------------------------------------------------------

export interface Webhook {
  id: string;
  repoId: string;
  active: boolean;
  webhookUrl: string;
  events?: string;
  createdAt: string;
}

export function getRepoWebhooks(repoId: string) {
  return request<Webhook[]>(`/api/repos/${repoId}/webhooks`);
}

export function createRepoWebhook(repoId: string) {
  return request<Webhook & { secret: string }>(`/api/repos/${repoId}/webhooks`, { method: 'POST' });
}

export function deleteRepoWebhook(repoId: string, webhookId: string) {
  return request<void>(`/api/repos/${repoId}/webhooks/${webhookId}`, { method: 'DELETE' });
}

// ---- Integrations ------------------------------------------------------------

export interface IntegrationConfig {
  id: string;
  provider: string;
  baseUrl: string;
  settings: Record<string, any>;
  hasToken: boolean;
  authType: 'pat' | 'github_app';
  createdAt: string;
  updatedAt: string;
}

export function getIntegrations() {
  return request<IntegrationConfig[]>('/api/integrations');
}

export function createIntegration(data: {
  provider: string;
  token: string;
  baseUrl?: string;
  settings?: Record<string, any>;
}) {
  return request<IntegrationConfig>('/api/integrations', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateIntegration(
  id: string,
  data: {
    token?: string;
    baseUrl?: string;
    settings?: Record<string, any>;
  },
) {
  return request<IntegrationConfig>(`/api/integrations/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteIntegration(id: string) {
  return request<void>(`/api/integrations/${id}`, { method: 'DELETE' });
}

export function testIntegration(id: string) {
  return request<{ success: boolean; login?: string; error?: string }>(
    `/api/integrations/${id}/test`,
    { method: 'POST' },
  );
}

// ---- GitHub App ---------------------------------------------------------------

export function getGitHubAppInstallUrl() {
  return request<{ installUrl: string }>('/api/github-app/install');
}

export function getGitHubAppStatus() {
  return request<{
    installed: boolean;
    serverConfigured: boolean;
    installationId?: string;
    appSlug?: string;
  }>('/api/github-app/status');
}

export function detectGitHubApp(opts?: { installationId?: string; githubAccount?: string }) {
  return request<{
    linked: boolean;
    installationId?: string;
    account?: string;
    message?: string;
    hasUnclaimedInstallations?: boolean;
  }>('/api/github-app/detect', {
    method: 'POST',
    body: JSON.stringify(opts || {}),
  });
}

export function testGitHubApp() {
  return request<{
    success: boolean;
    appSlug?: string;
    account?: string;
    permissions?: Record<string, string>;
    error?: string;
  }>('/api/github-app/test', { method: 'POST' });
}

// ---- GitLab OAuth -----------------------------------------------------------

export function getGitLabOAuthConfig() {
  return request<{
    configured: boolean;
    source: 'environment' | 'database' | 'none';
    clientId?: string;
    redirectUri?: string;
  }>('/api/gitlab-oauth/config');
}

export function saveGitLabOAuthConfig(data: { clientId: string; clientSecret: string; redirectUri: string }) {
  return request<{ success: boolean }>('/api/gitlab-oauth/config', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteGitLabOAuthConfig() {
  return request<{ success: boolean }>('/api/gitlab-oauth/config', { method: 'DELETE' });
}

export function getGitLabOAuthInstallUrl() {
  return request<{ authorizeUrl: string }>('/api/gitlab-oauth/install');
}

export function getGitLabOAuthStatus() {
  return request<{
    connected: boolean;
    authType: string | null;
    serverConfigured: boolean;
    username?: string;
  }>('/api/gitlab-oauth/status');
}

export function testGitLabOAuth() {
  return request<{
    success: boolean;
    login?: string;
    error?: string;
  }>('/api/gitlab-oauth/test', { method: 'POST' });
}

export function disconnectGitLabOAuth() {
  return request<{ success: boolean }>('/api/gitlab-oauth/disconnect', { method: 'POST' });
}

// ---- Pull Requests -----------------------------------------------------------

export interface PullRequestInfo {
  id: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  checkStatus: string;
  checkDescription: string;
  sessionsCount: number;
  sessionsApproved: number;
  sessionsFlagged: number;
  sessionsRejected: number;
  sessionsPending: number;
  commitCount: number;
  createdAt: string;
  updatedAt: string;
}

export function getPullRequests(params?: { repoId?: string; status?: string; state?: string }) {
  const q = new URLSearchParams();
  if (params?.repoId) q.set('repoId', params.repoId);
  if (params?.status) q.set('status', params.status);
  if (params?.state) q.set('state', params.state);
  const qs = q.toString();
  return request<PullRequestInfo[]>(`/api/pull-requests${qs ? `?${qs}` : ''}`);
}

export function recheckPR(id: string) {
  return request<{ success: boolean; checkStatus: string; checkDescription: string; sessionsCount: number }>(
    `/api/pull-requests/${id}/recheck`,
    { method: 'POST' },
  );
}

// ---- Budget / Cost Controls --------------------------------------------------

export interface BudgetConfig {
  monthlyLimit: number;
  alertThresholds: number[];
  blockOnExceed: boolean;
  alertedAt: number[];
}

export interface BudgetSpend {
  monthly: number;
  percentage: number;
  dailySpend: Array<{ date: string; cost: number }>;
  byModel: Array<{ model: string; cost: number; sessions: number }>;
  byUser: Array<{ userId: string; name: string; cost: number; sessions: number }>;
}

export interface BudgetData {
  config: BudgetConfig;
  currentSpend: BudgetSpend;
}

export function getBudget() {
  return request<BudgetData>('/api/settings/budget');
}

export function updateBudget(data: Partial<BudgetConfig>) {
  return request<BudgetConfig>('/api/settings/budget', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ---- Cost Forecast -----------------------------------------------------------

export interface ForecastData {
  projectedMonthly: number;
  trend: 'up' | 'down' | 'flat';
  confidence: number;
  daily: Array<{ date: string; actual: number | null; projected: number | null }>;
  byModel: Array<{ model: string; currentMonthly: number; projectedMonthly: number; trend: 'up' | 'down' | 'flat' }>;
}

export function getForecast() {
  return request<ForecastData>('/api/forecast');
}

// ---- Email Report Settings ---------------------------------------------------

export interface EmailSettings {
  enabled: boolean;
  recipients: string[];
  sendDay: string;
}

export function getEmailSettings() {
  return request<EmailSettings>('/api/settings/email');
}

export function updateEmailSettings(data: Partial<EmailSettings>) {
  return request<EmailSettings>('/api/settings/email', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function testEmail(to?: string) {
  return request<{ success: boolean; error?: string }>('/api/settings/email/test', {
    method: 'POST',
    body: JSON.stringify({ to }),
  });
}

// ---- Weekly Digest -----------------------------------------------------------

export function sendDigest() {
  return request<{ success: boolean; html: string; error?: string }>('/api/settings/send-digest', { method: 'POST' });
}

export function getDigestPreview() {
  return request<{ html: string }>('/api/settings/digest-preview?format=json');
}

// ---- Organization Settings ---------------------------------------------------

export interface OrgSettings {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  _count: { users: number; repos: number; agents: number; policies: number };
}

export function getOrgSettings() {
  return request<{ org: OrgSettings }>('/api/settings/org');
}

export function updateOrgSettings(data: { name?: string; slug?: string }) {
  return request<{ org: OrgSettings }>('/api/settings/org', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ---- Team / Users ------------------------------------------------------------

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  sessions: number;
  reviews: number;
  totalCost: number;
  linesAdded: number;
  lastActive: string;
  keyPrefix: string | null;
}

export interface UserDetail {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    createdAt: string;
    stats: {
      sessions: number;
      reviews: number;
      totalCost: number;
      linesAdded: number;
      linesRemoved: number;
      tokensUsed: number;
    };
  };
  sessions: Array<{
    id: string;
    model: string;
    repoName: string | null;
    commitMessage: string | null;
    costUsd: number;
    tokensUsed: number;
    linesAdded: number;
    createdAt: string;
    review: { status: string; note: string | null } | null;
  }>;
  reviews: Array<{
    id: string;
    sessionId: string;
    status: string;
    note: string | null;
    repoName: string | null;
    commitMessage: string | null;
    createdAt: string;
  }>;
  audit: Array<{
    id: string;
    action: string;
    resource: string | null;
    createdAt: string;
  }>;
}

export function getUsers() {
  return request<{ users: TeamMember[] }>('/api/users');
}

export function getUser(id: string) {
  return request<UserDetail>(`/api/users/${id}`);
}

// ---- Team Management ----------------------------------------------------------

export function updateUserRole(id: string, role: string) {
  return request<{ success: boolean }>(`/api/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
}

export function removeUser(id: string) {
  return request<{ success: boolean }>(`/api/users/${id}`, { method: 'DELETE' });
}

export function addMember(data: { name: string; email: string; role?: string; repoIds?: string[]; agentIds?: string[] }) {
  return request<{ user: { id: string; name: string; email: string; role: string; createdAt: string }; apiKey: string; keyPrefix: string }>('/api/users/add-member', { method: 'POST', body: JSON.stringify(data) });
}

export function regenerateKey(id: string) {
  return request<{ apiKey: string; keyPrefix: string }>(`/api/users/${id}/regenerate-key`, { method: 'POST' });
}

export function revokeKey(id: string) {
  return request<{ success: boolean }>(`/api/users/${id}/revoke-key`, { method: 'POST' });
}

export interface Invitation {
  id: string;
  token: string;
  email: string | null;
  role: string;
  createdAt: string;
  expiresAt: string;
}

export function createInvite(data: { email?: string; role: string }) {
  return request<{ id: string; token: string; role: string; email: string | null; expiresAt: string }>('/api/users/invite', { method: 'POST', body: JSON.stringify(data) });
}

export function getInvites() {
  return request<{ invites: Invitation[] }>('/api/users/invites');
}

export function cancelInvite(id: string) {
  return request<{ success: boolean }>(`/api/users/invites/${id}`, { method: 'DELETE' });
}

export function getInviteInfo(token: string) {
  return request<{ orgName: string; role: string; email: string | null }>(`/api/auth/invite/${token}`);
}

export function acceptInvite(data: { token: string; name: string; email: string; password: string }) {
  return request<AuthResponse>('/api/auth/accept-invite', { method: 'POST', body: JSON.stringify(data) });
}

// ---- PR-Grouped Sessions -----------------------------------------------------

export interface PRSessionGroup {
  pr: {
    id: string;
    number: number;
    title: string;
    url: string;
    state: string;
    author: string;
    baseBranch: string;
    headBranch: string;
    checkStatus: string | null;
    repoName: string;
    createdAt: string;
  };
  sessions: Session[];
  stats: {
    sessionCount: number;
    totalCost: number;
    totalTokens: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    reviewStatus: string;
  };
}

export function getSessionsByPR() {
  return request<{ groups: PRSessionGroup[] }>('/api/sessions/by-pr');
}

// ---- Real-Time Session Stream ------------------------------------------------

export interface SessionStreamEvent {
  type: 'connected' | 'session:started' | 'session:updated' | 'session:ended' | 'session:reviewed';
  sessionId?: string;
  orgId?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

export function createSessionStream(onEvent: (event: SessionStreamEvent) => void): EventSource {
  const token = localStorage.getItem('origin_token');
  const es = new EventSource(`/api/sessions/stream?token=${encodeURIComponent(token || '')}`);
  es.onmessage = (e) => {
    try {
      const event: SessionStreamEvent = JSON.parse(e.data);
      onEvent(event);
    } catch {
      // ignore parse errors
    }
  };
  return es;
}

// ---- Secret/PII Scanning -----------------------------------------------------

export interface SecretFinding {
  id: string;
  sessionId: string;
  type: string;
  severity: string;
  filePath: string;
  lineNumber: number;
  match: string;
  ruleName: string;
  createdAt: string;
  session?: {
    id: string;
    model: string;
    createdAt: string;
    commit: { repo: { name: string } };
  };
}

export interface ScanningStats {
  total: number;
  byType: { type: string; count: number }[];
  bySeverity: { severity: string; count: number }[];
}

export function getSessionFindings(sessionId: string) {
  return request<SecretFinding[]>(`/api/scanning/session/${sessionId}`);
}

export function getAllFindings(params?: { severity?: string; type?: string }) {
  const qs = new URLSearchParams();
  if (params?.severity) qs.set('severity', params.severity);
  if (params?.type) qs.set('type', params.type);
  const q = qs.toString();
  return request<SecretFinding[]>(`/api/scanning${q ? `?${q}` : ''}`);
}

export function getScanningStats() {
  return request<ScanningStats>('/api/scanning/stats');
}

// ---- Compliance Reports -------------------------------------------------------

export interface ComplianceReport {
  period: { from: string; to: string };
  complianceScore: number;
  summary: {
    totalSessions: number;
    totalCost: number;
    totalViolations: number;
    reviewRate: number;
    secretFindings: number;
  };
  sessionActivity: { date: string; count: number }[];
  violations: { type: string; count: number }[];
  securityFindings: { type: string; count: number }[];
  reviewCoverage: { reviewed: number; unreviewed: number };
  modelUsage: { model: string; sessions: number; cost: number }[];
  unreviewedAging?: { lessThan1d: number; from1to3d: number; from3to7d: number; moreThan7d: number };
  policyCoverage?: { repo: string; repoId: string; policies: string[] }[];
  complianceTrend?: { week: string; score: number }[];
}

export function getComplianceReport(from: string, to: string) {
  return request<ComplianceReport>(`/api/reports/compliance?from=${from}&to=${to}`);
}

export function getComplianceScore() {
  return request<{ score: number }>('/api/reports/compliance/summary');
}

// ---- Trails (Feature Tracking) -----------------------------------------------

export interface Trail {
  id: string;
  name: string;
  description: string | null;
  branch: string | null;
  status: string;
  priority: string;
  labels: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
  totalCost: number;
}

export interface TrailSessionEntry {
  id: string;
  addedAt: string;
  sessionId: string;
  model: string;
  prompt: string;
  costUsd: number;
  linesAdded: number;
  linesRemoved: number;
  status: string;
  createdAt: string;
  reviewStatus: string | null;
  repoName: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  userName: string | null;
}

export interface TrailDetail extends Trail {
  sessions: TrailSessionEntry[];
  pullRequests: PullRequestInfo[];
}

export function getTrails(params?: { status?: string; label?: string; limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, String(v)); });
  const qs = q.toString();
  return request<{ trails: Trail[]; total: number }>(`/api/trails${qs ? `?${qs}` : ''}`);
}

export function createTrail(data: { name: string; description?: string; branch?: string; priority?: string; labels?: string[] }) {
  return request<Trail>('/api/trails', { method: 'POST', body: JSON.stringify(data) });
}

export function getTrail(id: string) {
  return request<TrailDetail>(`/api/trails/${id}`);
}

export function updateTrail(id: string, data: { name?: string; description?: string; status?: string; priority?: string; labels?: string[] }) {
  return request<Trail>(`/api/trails/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteTrail(id: string) {
  return request<void>(`/api/trails/${id}`, { method: 'DELETE' });
}

export function addTrailSessions(trailId: string, sessionIds: string[]) {
  return request<{ added: string[]; skipped: string[] }>(`/api/trails/${trailId}/sessions`, { method: 'POST', body: JSON.stringify({ sessionIds }) });
}

export function removeTrailSession(trailId: string, sessionId: string) {
  return request<void>(`/api/trails/${trailId}/sessions/${sessionId}`, { method: 'DELETE' });
}

// ---- Leaderboard -------------------------------------------------------------

export interface LeaderboardEntry {
  userId: string;
  name: string;
  email: string;
  sessions: number;
  lines: number;
  cost: number;
  approvalRate: number;
  qualityScore: number;
  activityGrid: { date: string; count: number }[];
}

export function getLeaderboard(params?: { period?: string; sortBy?: string }) {
  const q = new URLSearchParams();
  if (params?.period) q.set('period', params.period);
  if (params?.sortBy) q.set('sortBy', params.sortBy);
  const qs = q.toString();
  return request<{ entries: LeaderboardEntry[] }>(`/api/leaderboard${qs ? `?${qs}` : ''}`);
}

// ---- Prompts Library ---------------------------------------------------------

export interface PromptEntry {
  id: string;
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  createdAt: string;
  sessionId: string;
  model: string;
  userName: string | null;
  costUsd: number;
  reviewStatus: string | null;
  repoName: string | null;
}

export interface PromptPattern {
  category: string;
  count: number;
  approvalRate: number;
}

export function searchPrompts(params?: { q?: string; model?: string; repoId?: string; userId?: string; file?: string; limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, String(v)); });
  const qs = q.toString();
  return request<{ prompts: PromptEntry[]; total: number }>(`/api/prompts${qs ? `?${qs}` : ''}`);
}

export function getPromptPatterns() {
  return request<{ patterns: PromptPattern[] }>('/api/prompts/patterns');
}

// ---- Model Comparison --------------------------------------------------------

export interface ModelStats {
  model: string;
  sessions: number;
  avgCost: number;
  totalCost: number;
  avgDuration: number;
  avgTokens: number;
  avgLines: number;
  approvalRate: number;
}

export interface ModelTrend {
  week: string;
  models: Record<string, number>;
}

export function getModelComparison() {
  return request<{ models: ModelStats[]; trend: ModelTrend[] }>('/api/models/comparison');
}

// ---- Repo Health -------------------------------------------------------------

export interface RepoHealth {
  repoId: string;
  repoName: string;
  healthScore: number;
  aiPercentage: number;
  sessionCount: number;
  reviewCoverage: number;
  violations: number;
  lastSession: string | null;
  totalCommits: number;
}

export function getRepoHealth(id: string) {
  return request<RepoHealth>(`/api/repos/${id}/health`);
}

// ---- Sharing ----------------------------------------------------------------

export function shareSession(id: string) {
  return request<{ url: string; slug: string; expiresAt: string | null }>(`/api/sessions/${id}/share`, { method: 'POST' });
}

export function unshareSession(id: string) {
  return request<{ ok: boolean }>(`/api/sessions/${id}/share`, { method: 'DELETE' });
}

export function getSharedSession(slug: string) {
  // No auth needed — public endpoint
  return fetch(`${BASE}/api/share/${slug}`).then((r) => {
    if (!r.ok) throw new Error(r.status === 410 ? 'This shared session link has expired' : 'Shared session not found');
    return r.json();
  });
}

// ---- Super-Admin --------------------------------------------------------

export function adminUpdateOrg(id: string, data: { name: string }) {
  return request<{ id: string; name: string; slug: string }>(`/api/admin/orgs/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function adminDeleteOrg(id: string) {
  return request<void>(`/api/admin/orgs/${id}`, { method: 'DELETE' });
}

export function adminUpdateUserRole(id: string, role: string) {
  return request<{ id: string; name: string; email: string; role: string }>(`/api/admin/users/${id}/role`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });
}

export function adminDeleteUser(id: string) {
  return request<void>(`/api/admin/users/${id}`, { method: 'DELETE' });
}
