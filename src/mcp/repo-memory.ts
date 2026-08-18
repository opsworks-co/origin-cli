// Pull-based repo memory for the MCP server.
//
// Origin already accumulates a repo-level memory in refs/notes/origin-memory:
// per-session rollups (what was done, which files, decisions, open TODOs) and an
// immutable per-commit log. Until now it was PUSH only — injected into an
// agent's context at session start, and readable by a human via
// `origin context memory`. An agent forty turns deep had no way to ask.
//
// That's the same gap get_file_context closed for files, one level up:
//   get_file_context  → "what happened in THIS FILE, and did it stick?"
//   get_repo_memory   → "what is the state of THIS PROJECT right now?"
//
// Offline like its sibling — reads local git notes, no account, no network.
//
// Token discipline matters more here than for file context: memory is
// repo-wide, so a naive dump is the largest single thing an agent could pull.
// Default output is a compact digest (summary line, counts, file list capped);
// full decisions/TODOs/fileNotes only on include_detail.
import {
  readAllSessionMemory,
  readAllCommitMemory,
  sortByDateAsc,
  type SessionMemoryEntry,
  type CommitMemoryEntry,
} from '../memory.js';

export interface RepoMemoryOptions {
  repoPath: string;
  /** Most recent sessions to return (default 5, max 20). */
  sessionLimit?: number;
  /** Most recent commits to return (default 10, max 50). */
  commitLimit?: number;
  /** Pull decisions, open TODOs and per-file notes. Default false. */
  includeDetail?: boolean;
  /** Only entries touching one of these repo-relative paths. */
  paths?: string[];
}

export interface RepoMemoryResult {
  repoPath: string;
  sessionCount: number;
  commitCount: number;
  sessions: Array<Record<string, unknown>>;
  commits: Array<Record<string, unknown>>;
  /** Set when the notes ref exists but nothing matched the filter. */
  note?: string;
}

const clamp = (n: number | undefined, dflt: number, max: number): number => {
  if (!Number.isFinite(n as number)) return dflt;
  return Math.max(1, Math.min(Math.floor(n as number), max));
};

// Suffix match, so "auth.ts" finds "src/auth.ts" — the agent rarely knows the
// full repo-relative path of a file it hasn't opened yet.
function touchesAny(files: string[] | undefined, wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.some((f) => wanted.some((w) => f === w || f.endsWith(w) || w.endsWith(f)));
}

const FILE_CAP = 8;
const SUMMARY_CAP = 400;

function digestSession(e: SessionMemoryEntry, detail: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sessionId: e.sessionId.slice(0, 8),
    agent: e.agentSlug,
    model: e.model,
    endedAt: e.endedAt,
    branch: e.branch,
    summary: (e.summary || '').slice(0, SUMMARY_CAP),
    files: (e.filesChanged || []).slice(0, FILE_CAP),
    fileCount: (e.filesChanged || []).length,
    lines: { added: e.linesAdded, removed: e.linesRemoved },
    // Counts are the triage signal: an agent decides from these whether the
    // detail is worth the tokens.
    decisionCount: (e.decisions || []).length,
    openTodoCount: (e.openTodos || []).length,
  };
  if (detail) {
    out.decisions = e.decisions || [];
    out.openTodos = e.openTodos || [];
    if (e.fileNotes) out.fileNotes = e.fileNotes;
  }
  return out;
}

function digestCommit(c: CommitMemoryEntry, detail: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sha: c.commitSha.slice(0, 8),
    agent: c.agentSlug,
    committedAt: c.committedAt,
    message: (c.message || '').slice(0, SUMMARY_CAP),
    files: (c.filesChanged || []).slice(0, FILE_CAP),
    fileCount: (c.filesChanged || []).length,
    lines: { added: c.linesAdded, removed: c.linesRemoved },
    decisionCount: (c.decisions || []).length,
  };
  if (detail) {
    out.decisions = c.decisions || [];
    if (c.fileNotes) out.fileNotes = c.fileNotes;
  }
  return out;
}

/**
 * Read this repo's accumulated memory, newest last (chronological — a history
 * reads forwards). Never throws: a repo with no memory ref returns empty lists
 * rather than an error, because "nothing recorded yet" is a normal answer and
 * an agent should not have to distinguish it from a failure.
 */
export function getRepoMemory(opts: RepoMemoryOptions): RepoMemoryResult {
  const { repoPath } = opts;
  const sessionLimit = clamp(opts.sessionLimit, 5, 20);
  const commitLimit = clamp(opts.commitLimit, 10, 50);
  const detail = !!opts.includeDetail;
  const paths = (opts.paths || []).filter((p) => typeof p === 'string' && p.trim().length > 0);

  let sessions: SessionMemoryEntry[] = [];
  let commits: CommitMemoryEntry[] = [];
  try { sessions = readAllSessionMemory(repoPath) || []; } catch { sessions = []; }
  try { commits = readAllCommitMemory(repoPath) || []; } catch { commits = []; }

  const totalSessions = sessions.length;
  const totalCommits = commits.length;

  const matchedSessions = sessions.filter((e) => touchesAny(e.filesChanged, paths));
  const matchedCommits = commits.filter((c) => touchesAny(c.filesChanged, paths));

  const result: RepoMemoryResult = {
    repoPath,
    sessionCount: totalSessions,
    commitCount: totalCommits,
    sessions: sortByDateAsc(matchedSessions, (e) => e.endedAt)
      .slice(-sessionLimit)
      .map((e) => digestSession(e, detail)),
    commits: sortByDateAsc(matchedCommits, (c) => c.committedAt)
      .slice(-commitLimit)
      .map((c) => digestCommit(c, detail)),
  };

  if (totalSessions + totalCommits === 0) {
    result.note = 'No memory recorded for this repo yet.';
  } else if (paths.length > 0 && result.sessions.length === 0 && result.commits.length === 0) {
    result.note = `No memory entries touch: ${paths.join(', ')}`;
  }
  return result;
}
