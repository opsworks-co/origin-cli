// ── Sessions API ────────────────────────────────────────────────────────
import { request } from './_client.js';

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

// PullRequestInfo lives in the legacy ../api.ts barrel; we use a minimal
// structural type here to avoid a circular import while we finish the split.
type SessionPullRequestInfo = {
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  baseBranch: string;
  headBranch: string;
  [key: string]: any;
};

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
  repoNames: string[];
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
  agentSessionId?: string | null;
  parentSessionId?: string | null;
  createdAt: string;
  review: SessionReview | null;
  pullRequests?: SessionPullRequestInfo[];
  sessionDiff?: SessionDiff | null;
  promptChanges?: PromptChange[];
  chainSessions?: Array<{
    id: string;
    startedAt: string | null;
    endedAt: string | null;
    costUsd: number;
    tokensUsed: number;
    durationMs: number;
    status: string;
    model: string;
  }>;
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

// ── AI blame (line-level attribution) ──────────────────────────────────

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
