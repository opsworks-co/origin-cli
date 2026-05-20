// ── Repos API ───────────────────────────────────────────────────────────
import { request } from './_client.js';

export interface Repo {
  id: string;
  name: string;
  path: string;
  provider: string;
  /**
   * Server-computed provider after considering integration connectivity.
   * A repo stored as provider='github' but whose org has no GitHub
   * integration will come back with effectiveProvider='local' — the UI
   * should use this for grouping, icons, and sync semantics.
   */
  effectiveProvider?: 'github' | 'gitlab' | 'local';
  /** Original provider column (for "reconnect to restore" hints) */
  declaredProvider?: string;
  archived: boolean;
  verboseCapture?: boolean;
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

export function backfillRepoFiles(id: string) {
  return request<{ scanned: number; updated: number; failed: number; truncated: boolean }>(
    `/api/repos/${id}/backfill-files`,
    { method: 'POST' },
  );
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

export interface RepoFileEntry {
  path: string;
  blobSha: string;
  size: number;
  totalCommits: number;
  aiCommits: number;
  humanCommits: number;
  aiPct: number;
  topAgent: { slug: string; name: string; count: number } | null;
  topUser: { id: string; name: string; email: string | null } | null;
  sessionCount: number;
  lastCommittedAt: string | null;
  lastSha: string | null;
  lastMessage: string;
  lastAuthor: string;
}

export interface RepoFilesSummary {
  aiCommits: number;
  humanCommits: number;
  totalCommits: number;
  aiPct: number;
}

export function getRepoFiles(id: string, branch?: string) {
  const q = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  return request<{ files: RepoFileEntry[]; totalFiles: number; ref: string; truncated: boolean; summary?: RepoFilesSummary }>(
    `/api/repos/${id}/files${q}`,
  );
}

export interface RepoFileLine {
  lineNumber: number;
  content: string;
  sha: string | null;
  isAi: boolean;
  agentSlug: string | null;
  agentName: string | null;
  userName: string | null;
  sessionId: string | null;
  // Prompt-level attribution derived server-side by content-matching
  // this line against every `+` line in the session's PromptChange diffs.
  // null when GitHub blame attributed the line to a commit/session whose
  // per-prompt diffs don't contain the line's exact content (e.g. lines
  // modified by a later commit/session whose work is now attributed to
  // a different SHA, or lines from sessions with no captured pc.diff).
  promptIndex: number | null;
  promptText: string | null;
}

export interface RepoFileBlame {
  path: string;
  ref: string;
  size: number;
  lineCount: number;
  lines: RepoFileLine[];
}

export function getRepoFile(id: string, path: string, ref?: string) {
  const params = new URLSearchParams({ path });
  if (ref) params.set('ref', ref);
  return request<RepoFileBlame>(`/api/repos/${id}/file?${params.toString()}`);
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

export interface CommitDetail {
  sha: string;
  message: string;
  author: string;
  branch: string | null;
  committedAt: string;
  aiToolDetected: string | null;
  aiDetectionMethod: string | null;
  // Session-anchor row that never got replaced with a real commit. The UI
  // renders a banner explaining this so users don't see "No files in this
  // commit" with no context (common when Cursor turns edit files without
  // committing).
  isPlaceholder?: boolean;
  stats: { additions: number; deletions: number; total: number };
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch: string;
    previousFilename: string | null;
    promptIndexes: number[];
  }>;
  session: null | {
    id: string;
    model: string;
    agentId?: string | null;
    agent?: { id: string; name: string; icon?: string | null } | null;
    user?: { id: string; name: string | null; email: string } | null;
    tokensUsed: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    linesAdded: number;
    linesRemoved: number;
    startedAt: string | null;
    endedAt: string | null;
    status: string;
    branch: string | null;
    filesChanged: string[];
    review?: { status: string } | null;
  };
  // Where the per-file `patch` strings came from. "commit.patch" is the only
  // per-commit-scoped source; other values mean the patches aggregate across
  // multiple commits in the same session, so siblings will all look identical
  // and may include lines that landed elsewhere.
  diffSource?: 'commit.patch' | 'sessionDiff' | 'promptChanges' | 'remote' | 'none';
  promptChanges: Array<{
    promptIndex: number;
    promptText: string;
    filesChanged: string[];
    diff: string;
  }>;
  // Other commits in the same session (excluding this one and placeholders).
  // Lets the commit-detail page show "N more commits in this session" so
  // users see related work without guessing — the session/commit data
  // model is many-to-one and this is the easy escape hatch.
  sessionCommits?: Array<{
    sha: string;
    message: string;
    committedAt: string;
    additions: number | null;
    deletions: number | null;
    fileCount: number | null;
  }>;
  repo: { id: string; name: string; provider: string; path: string };
}

export function getCommitDetail(repoId: string, sha: string) {
  return request<CommitDetail>(`/api/repos/${repoId}/commit/${sha}`);
}

// ── GitHub auto-discovery ──────────────────────────────────────────────

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

// ── GitLab auto-discovery ──────────────────────────────────────────────

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

// ── Repo Member Access ─────────────────────────────────────────────────

export type RepoLevel = 'read' | 'write' | 'admin';

export interface RepoMember {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  level: RepoLevel;
  inherited: boolean;
  orgRole?: string;
  grantedAt?: string;
}

export function getRepoMembers(repoId: string) {
  return request<{ members: RepoMember[] }>(`/api/repos/${repoId}/members`);
}

export function setRepoMember(repoId: string, userId: string, level: RepoLevel) {
  return request<{ userId: string; repoId: string; level: RepoLevel }>(
    `/api/repos/${repoId}/members/${userId}`,
    {
      method: 'PUT',
      body: JSON.stringify({ level }),
    },
  );
}

export function removeRepoMember(repoId: string, userId: string) {
  return request<{ success: boolean }>(`/api/repos/${repoId}/members/${userId}`, {
    method: 'DELETE',
  });
}

// ── Agent Member Access ────────────────────────────────────────────────

export type AgentLevel = 'use' | 'admin';

export interface AgentMember {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  level: AgentLevel;
  inherited: boolean;
  orgRole?: string;
  grantedAt?: string;
}

export function getAgentMembers(agentId: string) {
  return request<{ members: AgentMember[] }>(`/api/agents/${agentId}/members`);
}

export function setAgentMember(agentId: string, userId: string, level: AgentLevel) {
  return request<{ userId: string; agentId: string; level: AgentLevel }>(
    `/api/agents/${agentId}/members/${userId}`,
    {
      method: 'PUT',
      body: JSON.stringify({ level }),
    },
  );
}

export function removeAgentMember(agentId: string, userId: string) {
  return request<{ success: boolean }>(`/api/agents/${agentId}/members/${userId}`, {
    method: 'DELETE',
  });
}

// ── User Access Matrix ─────────────────────────────────────────────────

export interface UserAccessRepo {
  id: string;
  name: string;
  path: string;
  provider: string;
  level: RepoLevel | null;
  inherited: boolean;
}

export interface UserAccessAgent {
  id: string;
  name: string;
  slug: string;
  model: string;
  level: AgentLevel | null;
  inherited: boolean;
}

export interface UserAccessSummary {
  orgRole: string;
  inheritsAll: boolean;
  repos: UserAccessRepo[];
  agents: UserAccessAgent[];
}

export function getUserAccess(userId: string) {
  return request<UserAccessSummary>(`/api/users/${userId}/access`);
}
