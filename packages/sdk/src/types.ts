// ─── Core Models ──────────────────────────────────────────────────────────

export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
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

export interface Agent {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  description: string | null;
  model: string;
  status: string;
  createdAt: string;
  _count?: { sessions: number };
}

export interface Policy {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  type: string;
  active: boolean;
  createdAt: string;
  rules: PolicyRule[];
}

export interface PolicyRule {
  id: string;
  policyId: string;
  agentId: string | null;
  condition: string;
  action: string;
  severity: string;
}

export interface Repo {
  id: string;
  orgId: string;
  name: string;
  path: string;
  provider: string;
  syncedAt: string | null;
  createdAt: string;
  _count?: { commits: number };
}

export interface Commit {
  id: string;
  repoId: string;
  sha: string;
  message: string;
  author: string;
  committedAt: string;
  createdAt: string;
}

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

export interface AuditEntry {
  id: string;
  orgId: string;
  userId: string | null;
  action: string;
  resource: string | null;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface Machine {
  id: string;
  orgId: string;
  hostname: string;
  machineId: string;
  detectedTools: string[];
  lastSeenAt: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  orgId: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  readAt: string | null;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  snapshot: Record<string, any>;
  changedBy: string | null;
  changeType: string;
  createdAt: string;
}

export interface PolicyVersion {
  id: string;
  policyId: string;
  version: number;
  snapshot: Record<string, any>;
  changedBy: string | null;
  changeType: string;
  createdAt: string;
}

// ─── Stats ──────────────────────────────────────────────────────────────

export interface Stats {
  activeAgents: number;
  totalCommits: number;
  totalSessions: number;
  sessionsThisWeek: number;
  aiPercentage: number;
  tokensUsed: number;
  costUsd: number;
  linesAdded: number;
  linesRemoved: number;
  costThisMonth: number;
  linesWrittenThisMonth: number;
  unreviewedSessions: number;
  modelBreakdown: Record<string, number>;
  costByModel: Record<string, number>;
  sessionsByDay: Array<{ date: string; count: number }>;
  sessionsByRepo: Array<{ name: string; count: number }>;
  topAgents: Array<{ name: string; sessions: number }>;
  topEngineers: Array<{ name: string; sessions: number }>;
  policyViolations: number;
}

// ─── Request Params ─────────────────────────────────────────────────────

export interface SessionListParams {
  status?: 'unreviewed' | 'reviewed' | 'approved' | 'rejected' | 'flagged';
  model?: string;
  agentId?: string;
  repoId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditListParams {
  action?: string;
  limit?: number;
  offset?: number;
}

export interface CreateAgentParams {
  name: string;
  slug: string;
  model: string;
  description?: string;
}

export interface UpdateAgentParams {
  name?: string;
  description?: string;
  model?: string;
  status?: string;
}

export interface CreatePolicyParams {
  name: string;
  type: string;
  description?: string;
}

export interface UpdatePolicyParams {
  name?: string;
  description?: string;
  type?: string;
  active?: boolean;
}

export interface CreatePolicyRuleParams {
  condition: string;
  action: string;
  severity?: string;
  agentId?: string;
}

export interface CreateRepoParams {
  name: string;
  path: string;
  provider?: string;
}

export interface NotificationListParams {
  unread?: boolean;
  limit?: number;
  offset?: number;
}

// ─── Response Wrappers ──────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  total: number;
}

export interface SessionListResponse extends PaginatedResponse<Session> {
  sessions: Session[];
}

export interface AuditListResponse extends PaginatedResponse<AuditEntry> {
  entries: AuditEntry[];
}

export interface NotificationListResponse extends PaginatedResponse<Notification> {
  notifications: Notification[];
}
