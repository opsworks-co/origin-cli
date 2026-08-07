import fs from 'fs';
import path from 'path';
import { git, gitOrNull } from './utils/exec.js';
import { getGitRoot } from './session-state.js';
import { isRepoIgnored } from './ignore-repos.js';
import { loadConfig } from './config.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SessionMemoryEntry {
  sessionId: string;
  agentSlug: string;
  model: string;
  startedAt: string;
  endedAt: string;
  branch: string | null;
  summary: string;
  filesChanged: string[];
  promptCount: number;
  linesAdded: number;
  linesRemoved: number;
  openTodos: string[];
}

const MEMORY_REF = 'refs/notes/origin-memory';
const MEMORY_TAG = 'origin-memory-index';
const MAX_ENTRIES = 20; // Keep last 20 session summaries

// ─── When to write memory (config.memoryUpdate) ──────────────────────────────
//
// 'session-end' (default) — write once, at session end (historical behavior).
// 'commit'                 — write/refresh on every commit. Captures commit-and-go
//                            sessions that never reach a clean session end.
// 'both'                   — on every commit AND at session end (the authoritative
//                            final state upserts over the last commit's).
export type MemoryUpdateTrigger = 'session-end' | 'commit' | 'both';

export function memoryUpdateTrigger(): MemoryUpdateTrigger {
  const v = loadConfig()?.memoryUpdate;
  return v === 'commit' || v === 'both' ? v : 'session-end';
}
export function shouldWriteMemoryOnCommit(t: MemoryUpdateTrigger): boolean {
  return t === 'commit' || t === 'both';
}
export function shouldWriteMemoryOnSessionEnd(t: MemoryUpdateTrigger): boolean {
  return t === 'session-end' || t === 'both';
}

// ─── What NOT to remember / inject ───────────────────────────────────────────

// A bake-off arm is a throwaway benchmark run — its "prompts" are trivial tasks
// ("print the word hello", "say hello in one word") and its repo is a sandbox.
// Remembering them fills a shared repo's memory with noise that then gets
// injected into every real session (observed: origin-demo-1's memory was 100%
// bake-off prompts). Arms run in `<repo>-bakeoff-<id>-<agent>` worktrees (each
// carrying a BAKEOFF_PROMPT.md) or under ~/.origin/bakeoff-repos/.
export function isBakeoffRepo(repoPath: string | undefined | null): boolean {
  if (!repoPath) return false;
  const p = String(repoPath).replace(/\\/g, '/');
  if (p.includes('-bakeoff-')) return true;
  if (p.includes('/.origin/bakeoff-repos/')) return true;
  try { if (fs.existsSync(path.join(repoPath, 'BAKEOFF_PROMPT.md'))) return true; } catch { /* ignore */ }
  return false;
}

// Distinctive benchmark / smoke-test prompts that carry no durable signal for a
// future agent. High-precision so real short prompts ("fix the login bug") are
// kept — we only drop the obvious throwaways.
const BENCHMARK_PROMPT = /^\s*(say hello|reply with|print the word|respond with|output the|in (one|two|three) sentences?\b|in one word\b|what (is|are|kind)\b|describe (what|the)\b|create (a|one) (file|files)\s+\S+\s+(with|containing)\s+(one|two|three|\d+|the|a single)\b|add \d+ (more|rows?|lines?)\b|remove \d+\b)/i;

// Files this session actually touched IN THIS repo. Capture stores repo-relative
// paths, so an ABSOLUTE path — or one under another agent's / bake-off arm's
// worktree — is foreign work that leaked into this repo's shared memory (e.g. a
// bake-off arm committing to `.../copilot-worktrees/<repo>/.../data.txt`), not
// something a future session here should be told about.
export function repoRelativeFiles(files: string[] | undefined | null): string[] {
  return (files || []).filter((f) => {
    if (!f) return false;
    // path.isAbsolute is platform-correct: on Windows it catches both `C:\…`
    // and a leading-slash `/…`, so foreign absolute paths are dropped either way.
    if (path.isAbsolute(f)) return false;
    // Normalize separators before the marker checks so a Windows backslash path
    // (`…\.origin\bakeoff-repos\…`, `…\-bakeoff-…`) matches too — same as
    // isBakeoffRepo does.
    const norm = f.replace(/\\/g, '/');
    return (
      !norm.includes('-bakeoff-') &&
      !norm.includes('copilot-worktrees') &&
      !norm.includes('/.origin/bakeoff-repos/')
    );
  });
}

/**
 * True when a remembered session represents real, durable work in THIS repo
 * worth injecting into a future session — as opposed to a benchmark smoke-test,
 * a chat-only turn, or a bake-off arm's foreign-worktree work. Pure + exported
 * for testing.
 */
export function isSubstantiveMemory(e: SessionMemoryEntry): boolean {
  const s = (e?.summary || '').trim();
  if (!s) return false;
  if (BENCHMARK_PROMPT.test(s)) return false;
  // Must have touched real, repo-relative files. This is the reliable signal:
  // benchmark Q&A touches nothing, and bake-off / other-agent work records
  // foreign absolute paths — both leave zero repo-relative files.
  if (repoRelativeFiles(e.filesChanged).length === 0) return false;
  return true;
}

// ─── Write Memory ──────────────────────────────────────────────────────────

export function writeSessionMemory(repoPath: string, entry: SessionMemoryEntry): void {
  try {
    // Don't accumulate memory for bake-off arms or repos the user excluded —
    // it only pollutes the shared repo's memory with benchmark noise.
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return;
    const existing = readAllSessionMemory(repoPath);
    // UPSERT by sessionId — a session may write memory more than once (at each
    // commit AND at session end, per `memoryUpdate`), and we want ONE entry per
    // session that reflects its latest state, not a duplicate per write.
    const idx = existing.findIndex((e) => e.sessionId === entry.sessionId);
    if (idx >= 0) existing[idx] = entry;
    else existing.push(entry);

    // Keep only the last MAX_ENTRIES
    const trimmed = existing.slice(-MAX_ENTRIES);
    const payload = JSON.stringify({ version: 1, sessions: trimmed }, null, 2);

    // Write to a blob in git notes using a well-known tag
    const opts = { cwd: repoPath, timeoutMs: 10_000 };

    // Get HEAD commit to attach note to (or use a fixed ref)
    const head = gitOrNull(['rev-parse', 'HEAD'], opts);
    if (!head) return;

    // Write the memory index as a note on a well-known ref
    // We use the root commit as anchor so it doesn't move with HEAD
    const rootRaw = gitOrNull(['rev-list', '--max-parents=0', 'HEAD'], opts);
    const rootCommit = rootRaw ? rootRaw.split('\n')[0] : head;
    if (!/^[a-fA-F0-9]+$/.test(rootCommit)) return;

    git(['notes', '--ref=origin-memory', 'add', '-f', '-m', payload, rootCommit], opts);
  } catch {
    // Non-fatal — memory is nice-to-have
  }
}

// ─── Read Memory ───────────────────────────────────────────────────────────

export function readAllSessionMemory(repoPath: string): SessionMemoryEntry[] {
  try {
    const opts = { cwd: repoPath, timeoutMs: 10_000 };
    const rootRaw = gitOrNull(['rev-list', '--max-parents=0', 'HEAD'], opts);
    if (!rootRaw) return [];
    const rootCommit = rootRaw.split('\n')[0];
    if (!/^[a-fA-F0-9]+$/.test(rootCommit)) return [];

    const raw = git(['notes', '--ref=origin-memory', 'show', rootCommit], opts).trim();
    const data = JSON.parse(raw);
    if (data.version === 1 && Array.isArray(data.sessions)) {
      return data.sessions;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Read last N session memory entries for context injection.
 */
export function readRecentMemory(repoPath: string, count: number = 3): SessionMemoryEntry[] {
  const all = readAllSessionMemory(repoPath);
  return all.slice(-count);
}

// ─── Build Memory Context for System Prompt ────────────────────────────────

/**
 * Build the cross-session context injected into a NEW session's system prompt.
 * Returns null when there's nothing worth injecting.
 *
 * This used to dump the last 3 prompts verbatim, which — in a bake-off sandbox
 * or any repo with throwaway turns — injected pure noise ("say hello in one
 * word") into every real session. Now it: (a) never fires for bake-off/ignored
 * repos, (b) keeps only substantive sessions, and (c) DISTILLS them into a short
 * brief (session count + agents, the most recent real change, frequently-touched
 * files, open TODOs) instead of a raw prompt log.
 */
export function buildMemoryContext(repoPath: string): string | null {
  // (a) Never inject for bake-off arms or repos the user excluded.
  if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return null;

  // (b) Keep only sessions that did real work.
  const substantive = readAllSessionMemory(repoPath).filter(isSubstantiveMemory);
  if (substantive.length === 0) return null;

  // (c) Distill rather than dump.
  const parts: string[] = [];
  const agents = Array.from(new Set(substantive.map((e) => e.agentSlug).filter(Boolean)));
  parts.push(
    `Prior work in this repo — ${substantive.length} session${substantive.length !== 1 ? 's' : ''}` +
    (agents.length ? ` (${agents.join(', ')})` : '') + ':',
  );

  // The most recent substantive session's focus + its files (repo-relative,
  // basenamed so no absolute worktree paths leak into the prompt).
  const last = substantive[substantive.length - 1];
  const ago = formatAge(Date.now() - new Date(last.endedAt).getTime());
  parts.push(`- Most recent: [${ago} ago] ${last.summary.slice(0, 160)}`);
  const lastFiles = repoRelativeFiles(last.filesChanged).map((f) => path.basename(f));
  if (lastFiles.length) {
    parts.push(`  Files: ${lastFiles.slice(0, 8).join(', ')}${lastFiles.length > 8 ? ' …' : ''}`);
  }

  // Files touched across MULTIPLE substantive sessions — the repo's hot spots.
  const fileFreq = new Map<string, number>();
  for (const e of substantive) for (const f of repoRelativeFiles(e.filesChanged)) fileFreq.set(path.basename(f), (fileFreq.get(path.basename(f)) || 0) + 1);
  const hotFiles = Array.from(fileFreq.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([f]) => f);
  if (hotFiles.length) parts.push(`- Frequently touched: ${hotFiles.join(', ')}`);

  // Open TODOs carried across substantive sessions.
  const todos: string[] = [];
  for (const e of substantive) for (const t of e.openTodos || []) if (!todos.includes(t)) todos.push(t);
  if (todos.length) {
    parts.push('Open TODOs from previous sessions:');
    for (const t of todos.slice(0, 5)) parts.push(`  - ${t}`);
  }

  return parts.join('\n');
}

// ─── Clear Memory ──────────────────────────────────────────────────────────

export function clearSessionMemory(repoPath: string): boolean {
  try {
    const opts = { cwd: repoPath, timeoutMs: 10_000 };
    const rootRaw = gitOrNull(['rev-list', '--max-parents=0', 'HEAD'], opts);
    if (!rootRaw) return false;
    const rootCommit = rootRaw.split('\n')[0];
    if (!/^[a-fA-F0-9]+$/.test(rootCommit)) return false;
    git(['notes', '--ref=origin-memory', 'remove', rootCommit], opts);
    return true;
  } catch {
    return false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
