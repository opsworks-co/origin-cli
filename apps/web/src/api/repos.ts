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
  promptChanges: Array<{
    promptIndex: number;
    promptText: string;
    filesChanged: string[];
    diff: string;
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
