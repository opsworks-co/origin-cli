// ---------------------------------------------------------------------------
// Origin v2 — typed API client (legacy barrel)
//
// This file is being incrementally split into apps/web/src/api/*.ts modules.
// Already-split domains:
//   • api/auth.ts      — login, register, OAuth, profile, password
//   • api/repos.ts     — repos CRUD, sync, commits, GitHub/GitLab discovery
//   • api/sessions.ts  — sessions, AI blame, review
//
// Existing imports of the form `import * as api from './api'` continue to
// work because everything is re-exported from this barrel.
//
// New code should import directly from the domain modules:
//   import { getRepos } from './api/repos';
// ---------------------------------------------------------------------------

import { request } from './api/_client.js';
import type { Repo } from './api/repos.js';
import type { Session } from './api/sessions.js';
import type { AuthResponse } from './api/auth.js';
import { reviewSession } from './api/sessions.js';

export { request } from './api/_client.js';
export * from './api/auth.js';
export * from './api/repos.js';
export * from './api/sessions.js';

// ---- Annotations ----------------------------------------------------------

export interface SessionAnnotation {
  id: string;
  sessionId: string;
  turnIndex: number;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

export function getAnnotations(sessionId: string) {
  return request<SessionAnnotation[]>(`/api/sessions/${sessionId}/annotations`);
}

export function createAnnotation(sessionId: string, data: { turnIndex: number; text: string }) {
  return request<SessionAnnotation>(`/api/sessions/${sessionId}/annotations`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteAnnotation(sessionId: string, annotationId: string) {
  return request<void>(`/api/sessions/${sessionId}/annotations/${annotationId}`, {
    method: 'DELETE',
  });
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
  // Catalog model: catalog rows are seeded for every org and only get
  // toggled on/off; custom rows are user-created and deletable. The list
  // endpoint also surfaces month-to-date session count + spend so the
  // Agents page can render activity inline without per-card fetches.
  isEnabled: boolean;
  isCustom: boolean;
  sessionsThisMonth?: number;
  costThisMonth?: number;
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

export interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
  defaultModel: string;
  allowedModels: string[];
  iconKey: 'claude-code' | 'cursor' | 'gemini' | 'codex';
  docsUrl: string;
}

export function getAgents() {
  return request<Agent[]>('/api/agents');
}

export function getAgentCatalog() {
  return request<CatalogEntry[]>('/api/agents/catalog');
}

export function toggleAgent(id: string, enabled: boolean) {
  return request<{ id: string; isEnabled: boolean }>(`/api/agents/${id}/toggle`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
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

// ---- Agent per-model budget overrides -----------------------------------

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

export interface AgentModel {
  id: string;
  agentId: string;
  model: string;
  monthlyLimit: number | null;
  tokenLimit: number | null;
  maxCostPerSession: number | null;
  maxTokensPerSession: number | null;
  period: BudgetPeriod;
  autoDetected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserModelLimit {
  id: string;
  userId: string;
  model: string;
  monthlyLimit: number | null;
  tokenLimit: number | null;
  maxCostPerSession: number | null;
  maxTokensPerSession: number | null;
  period: BudgetPeriod;
  createdAt: string;
  updatedAt: string;
}

export interface RepoModelLimit {
  id: string;
  repoId: string;
  model: string;
  monthlyLimit: number | null;
  tokenLimit: number | null;
  maxCostPerSession: number | null;
  maxTokensPerSession: number | null;
  period: BudgetPeriod;
  createdAt: string;
  updatedAt: string;
}

export function getAgentModels(agentId: string) {
  return request<AgentModel[]>(`/api/agents/${agentId}/models`);
}

export function createAgentModel(agentId: string, data: {
  model: string;
  monthlyLimit?: number | null;
  tokenLimit?: number | null;
  maxCostPerSession?: number | null;
  maxTokensPerSession?: number | null;
  period?: BudgetPeriod;
}) {
  return request<AgentModel>(`/api/agents/${agentId}/models`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateAgentModel(agentId: string, model: string, data: Partial<{
  monthlyLimit: number | null;
  tokenLimit: number | null;
  maxCostPerSession: number | null;
  maxTokensPerSession: number | null;
  period: BudgetPeriod;
}>) {
  return request<AgentModel>(`/api/agents/${agentId}/models/${encodeURIComponent(model)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteAgentModel(agentId: string, model: string) {
  return request<{ ok: boolean }>(`/api/agents/${agentId}/models/${encodeURIComponent(model)}`, {
    method: 'DELETE',
  });
}

// ---- Per-(user, model) budget overrides ---------------------------------

export function getUserModels(userId: string) {
  return request<UserModelLimit[]>(`/api/users/${userId}/models`);
}
export function createUserModel(userId: string, data: {
  model: string;
  monthlyLimit?: number | null;
  tokenLimit?: number | null;
  maxCostPerSession?: number | null;
  maxTokensPerSession?: number | null;
  period?: BudgetPeriod;
}) {
  return request<UserModelLimit>(`/api/users/${userId}/models`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
export function updateUserModel(userId: string, model: string, data: Partial<{
  monthlyLimit: number | null;
  tokenLimit: number | null;
  maxCostPerSession: number | null;
  maxTokensPerSession: number | null;
  period: BudgetPeriod;
}>) {
  return request<UserModelLimit>(`/api/users/${userId}/models/${encodeURIComponent(model)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
export function deleteUserModel(userId: string, model: string) {
  return request<{ ok: boolean }>(`/api/users/${userId}/models/${encodeURIComponent(model)}`, {
    method: 'DELETE',
  });
}

// ---- Per-(repo, model) budget overrides ---------------------------------

export function getRepoModels(repoId: string) {
  return request<RepoModelLimit[]>(`/api/repos/${repoId}/models`);
}
export function createRepoModel(repoId: string, data: {
  model: string;
  monthlyLimit?: number | null;
  tokenLimit?: number | null;
  maxCostPerSession?: number | null;
  maxTokensPerSession?: number | null;
  period?: BudgetPeriod;
}) {
  return request<RepoModelLimit>(`/api/repos/${repoId}/models`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
export function updateRepoModel(repoId: string, model: string, data: Partial<{
  monthlyLimit: number | null;
  tokenLimit: number | null;
  maxCostPerSession: number | null;
  maxTokensPerSession: number | null;
  period: BudgetPeriod;
}>) {
  return request<RepoModelLimit>(`/api/repos/${repoId}/models/${encodeURIComponent(model)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
export function deleteRepoModel(repoId: string, model: string) {
  return request<{ ok: boolean }>(`/api/repos/${repoId}/models/${encodeURIComponent(model)}`, {
    method: 'DELETE',
  });
}

// ---- Per-repo flat dollar cap (no model dimension) ----------------------
// Mirrors getBudgetAgents / updateAgentBudget. Storage is the
// `budget_repo_limits` IntegrationConfig blob keyed by repo UUID.

export interface RepoBudgetRow {
  repoId: string;
  repoName: string;
  monthlyLimit: number;
  period: BudgetPeriod;
  currentSpend: number;
  sessions: number;
}

export function getRepoBudgets() {
  return request<RepoBudgetRow[]>('/api/budget/repos');
}

export function updateRepoBudget(repoId: string, data: { monthlyLimit: number; period?: BudgetPeriod }) {
  return request<{ ok: boolean }>(`/api/budget/repos/${repoId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
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
  costByModel: { model: string; cost: number; count: number; tokens?: number }[];
  tokensByAgent?: { agentId: string; name: string; model: string; tokens: number; cost: number; count: number }[];
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

// ── Team-scoped views (org-wide) ──────────────────────────────────────────

export interface TeamPromptEntry {
  sessionId: string;
  agentName: string;
  userId: string | null;
  userName: string;
  repoId: string | null;
  repoName: string | null;
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  createdAt: string;
}

export function getTeamPrompts(opts: { q?: string; userId?: string; agentId?: string; repoId?: string; model?: string; limit?: number; offset?: number } = {}) {
  const p = new URLSearchParams();
  if (opts.q) p.set('q', opts.q);
  if (opts.userId) p.set('userId', opts.userId);
  if (opts.agentId) p.set('agentId', opts.agentId);
  if (opts.repoId) p.set('repoId', opts.repoId);
  if (opts.model) p.set('model', opts.model);
  if (opts.limit !== undefined) p.set('limit', String(opts.limit));
  if (opts.offset !== undefined) p.set('offset', String(opts.offset));
  const qs = p.toString();
  return request<{ prompts: TeamPromptEntry[]; total: number }>(`/api/stats/team/prompts${qs ? `?${qs}` : ''}`);
}

export interface TeamEfficiency {
  tokensPerLine: number;
  costPerSession: number;
  costPerCommit: number;
  avgLinesPerSession: number;
  avgFilesPerCommit: number;
  commitsPerSession: number;
  totalSessions: number;
  totalCommits: number;
  totalCost: number;
  byEngineer: Array<{
    userId: string;
    name: string;
    sessions: number;
    cost: number;
    tokensPerLine: number;
    costPerSession: number;
  }>;
}

export function getTeamEfficiency() {
  return request<TeamEfficiency>('/api/stats/team/efficiency');
}

export interface TeamAdoption {
  totalEngineers: number;
  activeThisWeek: number;
  activeLastWeek: number;
  newAdopters: number;
  adoptionPct: number;
}

export function getTeamAdoption() {
  return request<TeamAdoption>('/api/stats/team/adoption');
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

export function createApiKey(data: { name: string; role?: string; repoIds?: string[]; agentIds?: string[]; targetUserId?: string }) {
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

export function updateRepo(
  id: string,
  data: Partial<{ name: string; path: string; provider: string; verboseCapture: boolean }>,
) {
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

export function getGitHubAppInstallUrl(opts?: { from?: string; flavor?: string }) {
  const params = new URLSearchParams();
  if (opts?.from) params.set('from', opts.from);
  if (opts?.flavor) params.set('flavor', opts.flavor);
  const q = params.toString() ? `?${params.toString()}` : '';
  return request<{ installUrl: string }>(`/api/github-app/install${q}`);
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

export function getGitLabOAuthInstallUrl(opts?: { from?: string; flavor?: string }) {
  const params = new URLSearchParams();
  if (opts?.from) params.set('from', opts.from);
  if (opts?.flavor) params.set('flavor', opts.flavor);
  const q = params.toString() ? `?${params.toString()}` : '';
  return request<{ authorizeUrl: string }>(`/api/gitlab-oauth/install${q}`);
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

export interface PeriodCap {
  limit: number;
  block: boolean;
}

export interface BudgetConfig {
  monthlyLimit: number;          // legacy single-cap mirror (= dominant cap)
  period: BudgetPeriod;          // legacy mirror
  alertThresholds: number[];
  blockOnExceed: boolean;        // legacy mirror
  alertedAt: number[];
  // Multi-tier caps. Any of daily/weekly/monthly may be set independently.
  // Empty/missing entry = no cap for that window.
  caps?: Partial<Record<BudgetPeriod, PeriodCap>>;
}

export interface BudgetSpend {
  monthly: number; // legacy: spend for the active period; equals byPeriod[config.period]
  percentage: number;
  period: BudgetPeriod;
  byPeriod: { daily: number; weekly: number; monthly: number };
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

// ---- Federated personal view (/api/me/*) -------------------------------------
// These endpoints aggregate the authenticated user's activity across every
// org they're a member of, so a single team API key powers the personal
// dashboard with no client-side dual-writes. See apps/api/src/routes/me.ts.

export interface MeOrg {
  id: string;
  name: string;
}

// Mirrors the dashboard's `Session` shape (apps/web/src/pages/MyDashboard/utils.ts)
// with one addition: `org` so the federated list can show org context inline.
export interface MeSession {
  id: string;
  org: MeOrg | null;
  repoId: string | null;
  repoName: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  model: string;
  agentName: string | null;
  prompt: string | null;
  aiTitle: string | null;
  durationMs: number;
  costUsd: number;
  tokensUsed: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: string;
  toolCalls: number;
  status: string;
  review: { status: string; score: number | null } | null;
  mergedFrom: string[] | null;
  mergedInto: string | null;
  parentSessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface MeRepo {
  id: string;
  name: string;
  path: string;
  provider: string;
  org: MeOrg | null;
  archived: boolean;
  syncedAt: string | null;
  commitCount: number;
}

export interface MeSpend {
  byPeriod: { daily: number; weekly: number; monthly: number };
  byOrg: Array<{ orgId: string; orgName: string; cost: number; sessions: number }>;
  dailySpend: Array<{ date: string; cost: number }>;
}

export function getMeSessions(params?: { limit?: number; offset?: number; orgId?: string; repoId?: string; model?: string; archived?: boolean }) {
  const q = new URLSearchParams();
  if (params?.limit !== undefined) q.set('limit', String(params.limit));
  if (params?.offset !== undefined) q.set('offset', String(params.offset));
  if (params?.orgId) q.set('orgId', params.orgId);
  if (params?.repoId) q.set('repoId', params.repoId);
  if (params?.model) q.set('model', params.model);
  if (params?.archived) q.set('archived', 'true');
  return request<{ sessions: MeSession[]; total: number }>(`/api/me/sessions${q.toString() ? `?${q}` : ''}`);
}

export function getMeRepos() {
  return request<{ repos: MeRepo[] }>('/api/me/repos');
}

export function getMeSpend() {
  return request<MeSpend>('/api/me/spend');
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

// ---- Spend Quality (Insights) ---------------------------------------------

export type InsightsRange = '7d' | '30d' | '90d' | 'custom';

export interface InsightsConfig {
  reworkWindowDays: number;
  reworkRateAmber: number;
  reworkRateRed: number;
  expensiveSessionMultiplier: number;
  modelFit: {
    opusCheap: { maxCostUsd: number; maxPrompts: number; maxFilesChanged: number; savingsRatio: number };
    sonnetLong: { minPrompts: number; savingsRatio: number };
  };
  wastedPromptWindowMinutes: number;
  cacheRatioOutlierMultiplier: number;
  topSessions: { default: number; max: number };
  defaultRangeDays: number;
}

export interface SpendQualityRow {
  userId: string;
  name: string;
  email: string;
  spendUsd: number;
  sessionCount: number;
  aiAuthorship: number;       // 0..1
  reworkRate: number;          // 0..1
  costPerMergedPr: number | null;
  mergedPrCount: number;
}

export interface TopSessionRow {
  sessionId: string;
  userName: string;
  durationSec: number;
  costUsd: number;
  promptCount: number;
  branch: string | null;
  commitCount: number;
  flags: ('zero-commit' | 'cost-outlier')[];
  cliPath: string;
  // ISO timestamp of session start. Used by the heatmap-pick filter on
  // the Spend Quality page to narrow rows to a specific hour-of-week.
  startedAtIso: string;
}

export interface ModelFitWarning {
  sessionId: string;
  userName: string;
  modelUsed: string;
  suggestedModel: string;
  reason: 'oversized-for-cheap-task' | 'undersized-for-long-session';
  estimatedSavingsUsd: number;
}

export interface HeatmapCell {
  day: number; hour: number; costUsd: number; sessionCount: number;
}

export interface TokenBreakdownRow {
  userId: string; name: string;
  generatedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheReadRatio: number;
  isOutlier: boolean;
}

// Per-agent rollup — same shape as TokenBreakdownRow but keyed by agentId.
export interface TokenBreakdownAgentRow {
  agentId: string;
  name: string;
  slug: string;
  generatedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheReadRatio: number;
  isOutlier: boolean;
}

// Per-model rollup — keyed on the raw model string (e.g. "claude-opus-4-7").
export interface TokenBreakdownModelRow {
  model: string;
  name: string;
  generatedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheReadRatio: number;
  isOutlier: boolean;
}

export interface RangeMeta { from: string; to: string }

function rangeQuery(params: { from?: Date; to?: Date; range?: string }): string {
  const sp = new URLSearchParams();
  if (params.from && params.to) {
    sp.set('from', params.from.toISOString());
    sp.set('to', params.to.toISOString());
  } else if (params.range) {
    sp.set('range', params.range);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function getInsightsConfig() {
  return request<InsightsConfig>('/api/insights/config');
}
// Per-org override write — partial shape, the backend merges with defaults.
// Empty/undefined fields fall back to the global INSIGHTS_CONFIG defaults.
export function updateInsightsConfig(overrides: Partial<{
  reworkWindowDays: number;
  reworkRateAmber: number;
  reworkRateRed: number;
  expensiveSessionMultiplier: number;
  modelFit: Partial<{
    opusCheap: Partial<{ maxPrompts: number; maxCostUsd: number; maxFilesChanged: number }>;
    sonnetLong: Partial<{ minPrompts: number }>;
  }>;
}>) {
  return request<InsightsConfig>('/api/insights/config', {
    method: 'PUT',
    body: JSON.stringify(overrides),
  });
}
export function getSpendQuality(p: { from?: Date; to?: Date; range?: string }) {
  return request<{ rows: SpendQualityRow[]; range: RangeMeta }>('/api/insights/spend-quality' + rangeQuery(p));
}
export function getTopSessions(p: { from?: Date; to?: Date; range?: string; limit?: number }) {
  const q = rangeQuery(p);
  const limit = p.limit ? `${q ? '&' : '?'}limit=${p.limit}` : '';
  return request<{ sessions: TopSessionRow[]; range: RangeMeta }>('/api/insights/top-sessions' + q + limit);
}
export function getModelFitWarnings(p: { from?: Date; to?: Date; range?: string }) {
  return request<{ warnings: ModelFitWarning[]; range: RangeMeta }>('/api/insights/model-fit-warnings' + rangeQuery(p));
}
export function getSpendHeatmap(p: { from?: Date; to?: Date; range?: string }) {
  return request<{ cells: HeatmapCell[]; range: RangeMeta }>('/api/insights/spend-heatmap' + rangeQuery(p));
}
export function getWastedPrompts(p: { from?: Date; to?: Date; range?: string }) {
  return request<{ perDev: Array<{ userId: string; name: string; wastedCount: number; wastedUsd: number }>;
                   topPrompts: Array<{ promptId: string; userName: string; preview: string; costUsd: number; restoredAt: string; fileContext: string[] }>;
                   degraded: boolean; degradedReason?: string;
                   range: RangeMeta }>('/api/insights/wasted-prompts' + rangeQuery(p));
}
export function getTokenBreakdown(p: { from?: Date; to?: Date; range?: string }) {
  return request<{
    rows: TokenBreakdownRow[];
    byAgent: TokenBreakdownAgentRow[];
    byModel: TokenBreakdownModelRow[];
    range: RangeMeta;
  }>('/api/insights/token-breakdown' + rangeQuery(p));
}

// ---- Org-wide per-model spend caps -----------------------------------------

export interface ModelBudget {
  model: string;
  monthlyLimit: number;
  period: BudgetPeriod;
  currentSpend: number;
  sessions: number;
}

export function getModelBudgets() {
  return request<ModelBudget[]>('/api/budget/models');
}

export function updateModelBudget(model: string, data: { monthlyLimit: number; period?: BudgetPeriod }) {
  return request<{ ok: boolean }>(`/api/budget/models/${encodeURIComponent(model)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

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
  repoGrants?: number;
  agentGrants?: number;
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

export function removeUser(id: string, opts?: { purgeData?: boolean }) {
  // DELETE with a body is unusual but Express + the route handler read
  // the JSON body fine. Defaults to no purge — old call sites that omit
  // opts keep historical behavior (Membership + ApiKey removal only).
  return request<{ success: boolean; purged: { sessions: number; reviews: number; repoGrants: number; agentGrants: number } | null }>(
    `/api/users/${id}`,
    {
      method: 'DELETE',
      body: opts ? JSON.stringify({ purgeData: !!opts.purgeData }) : undefined,
    },
  );
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

export interface InvitePendingGrants {
  repos?: Array<{ id: string; level: 'read' | 'write' | 'admin' }>;
  agents?: Array<{ id: string; level: 'use' | 'admin' }>;
}

export type CreateInviteResponse =
  | { added?: false; id: string; token: string; role: string; email: string | null; expiresAt: string; emailSent?: boolean; emailError?: string }
  | { added: true; userId: string; role: string; email: string | null; emailSent?: boolean; emailError?: string };

export function createInvite(data: { email?: string; role: string; pendingGrants?: InvitePendingGrants }) {
  return request<CreateInviteResponse>('/api/users/invite', { method: 'POST', body: JSON.stringify(data) });
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
  type: 'connected' | 'session:started' | 'session:updated' | 'session:ended' | 'session:reviewed'
    | 'session:prompt' | 'session:metrics' | 'session:files' | 'session:commit' | 'session:output';
  sessionId?: string;
  orgId?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

export function createSessionStream(onEvent: (event: SessionStreamEvent) => void): EventSource {
  // Same-origin EventSource attaches cookies automatically, so the httpOnly
  // `origin_auth` cookie carries auth here — no query-token leak into server
  // access logs anymore.
  const es = new EventSource('/api/sessions/stream', { withCredentials: true });
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
  return fetch(`/api/share/${slug}`).then((r) => {
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

// ---- Issues ---------------------------------------------------------------

export interface IssueSession {
  sessionId: string;
  model: string;
  costUsd: number;
  tokensUsed: number;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  createdAt: string;
}

export interface Issue {
  id: string;
  repoId: string;
  shortId: string;
  title: string;
  description?: string;
  type: string;
  priority: number;
  status: string;
  labels: string[];
  deps: string[];
  sessions: IssueSession[];
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueStats {
  counts: { open: number; inProgress: number; blocked: number; closed: number; total: number };
  cost: { totalCost: number; totalTokens: number; totalSessions: number; totalDurationMs: number };
  topIssuesByCost: { id: string; title: string; cost: number; sessions: number }[];
}

export function getIssues(repoId: string, params?: { status?: string; priority?: string; type?: string }) {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.priority) q.set('priority', params.priority);
  if (params?.type) q.set('type', params.type);
  const qs = q.toString();
  return request<Issue[]>(`/api/repos/${repoId}/issues${qs ? `?${qs}` : ''}`);
}

export function getIssueStats(repoId: string) {
  return request<IssueStats>(`/api/repos/${repoId}/issues/stats`);
}

export function getReadyIssues(repoId: string) {
  return request<Issue[]>(`/api/repos/${repoId}/issues/ready`);
}

export function getIssue(repoId: string, shortId: string) {
  return request<Issue>(`/api/repos/${repoId}/issues/${shortId}`);
}

export function createIssue(repoId: string, data: { shortId: string; title: string; description?: string; type?: string; priority?: number; labels?: string[]; deps?: string[] }) {
  return request<Issue>(`/api/repos/${repoId}/issues`, { method: 'POST', body: JSON.stringify(data) });
}

export function updateIssue(repoId: string, shortId: string, data: Partial<{ title: string; description: string; type: string; priority: number; status: string; labels: string[]; deps: string[] }>) {
  return request<Issue>(`/api/repos/${repoId}/issues/${shortId}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function deleteIssue(repoId: string, shortId: string) {
  return request<void>(`/api/repos/${repoId}/issues/${shortId}`, { method: 'DELETE' });
}

export function linkIssueSession(repoId: string, shortId: string, sessionId: string) {
  return request<{ ok: boolean }>(`/api/repos/${repoId}/issues/${shortId}/link`, { method: 'POST', body: JSON.stringify({ sessionId }) });
}
