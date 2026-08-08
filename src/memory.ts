import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
  // path → one-line "what changed in this file", so a future agent knows a
  // recently-changed file's change without re-reading the diff. Optional (only
  // the LLM/org-key summary path fills it).
  fileNotes?: Record<string, string>;
  // Notable decisions/trade-offs made this session (choice + why) — from
  // explicit [Origin: Decision] markers and/or the LLM summary. The "why" a
  // future agent can't recover from code alone.
  decisions?: string[];
}

// An IMMUTABLE record of a single commit — frozen when the commit lands and
// never regenerated (unlike the per-session rollup above, which evolves). This
// is the granular history: what each commit did, in its own right.
export interface CommitMemoryEntry {
  commitSha: string;
  sessionId: string;
  agentSlug: string;
  message: string;                 // the commit subject (the immutable summary)
  filesChanged: string[];          // THIS commit's files (not the session's union)
  fileNotes?: Record<string, string>;
  decisions?: string[];            // decisions evident in THIS commit
  linesAdded: number;
  linesRemoved: number;
  branch: string | null;
  committedAt: string;
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

// The full memory payload stored in the origin-memory note. `sessions` are the
// mutable per-session ROLLUPS (upserted, regenerated); `commits` are IMMUTABLE
// per-commit records (frozen once written). Read/written together so one never
// clobbers the other.
interface MemoryPayload {
  version: number;
  sessions: SessionMemoryEntry[];
  commits: CommitMemoryEntry[];
}

function memoryRootCommit(repoPath: string): string | null {
  const raw = gitOrNull(['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
  const c = raw ? raw.split('\n')[0] : null;
  return c && /^[a-fA-F0-9]+$/.test(c) ? c : null;
}

function readMemoryPayload(repoPath: string): MemoryPayload {
  try {
    const root = memoryRootCommit(repoPath);
    if (!root) return { version: 2, sessions: [], commits: [] };
    const raw = git(['notes', '--ref=origin-memory', 'show', root], { cwd: repoPath, timeoutMs: 10_000 }).trim();
    const data = JSON.parse(raw);
    return {
      version: typeof data.version === 'number' ? data.version : 1,
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      commits: Array.isArray(data.commits) ? data.commits : [], // absent in v1 payloads
    };
  } catch {
    return { version: 2, sessions: [], commits: [] };
  }
}

function writeMemoryPayload(repoPath: string, sessions: SessionMemoryEntry[], commits: CommitMemoryEntry[]): void {
  const root = memoryRootCommit(repoPath);
  if (!root) return;
  const payload = JSON.stringify({ version: 2, sessions, commits }, null, 2);
  git(['notes', '--ref=origin-memory', 'add', '-f', '-m', payload, root], { cwd: repoPath, timeoutMs: 10_000 });
}

export function writeSessionMemory(repoPath: string, entry: SessionMemoryEntry): void {
  try {
    // Don't accumulate memory for bake-off arms or repos the user excluded —
    // it only pollutes the shared repo's memory with benchmark noise.
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return;
    const { sessions, commits } = readMemoryPayload(repoPath);
    // UPSERT by sessionId — a session may write memory more than once (at each
    // commit AND at session end, per `memoryUpdate`), and we want ONE entry per
    // session that reflects its latest state, not a duplicate per write.
    const idx = sessions.findIndex((e) => e.sessionId === entry.sessionId);
    if (idx >= 0) sessions[idx] = entry;
    else sessions.push(entry);
    const trimmed = sessions.slice(-MAX_ENTRIES);
    // Prune commit records whose session dropped out of the retained window.
    const keep = new Set(trimmed.map((s) => s.sessionId));
    writeMemoryPayload(repoPath, trimmed, commits.filter((c) => keep.has(c.sessionId)));
  } catch {
    // Non-fatal — memory is nice-to-have
  }
}

// Record an IMMUTABLE per-commit memory entry. Add-once by SHA: if a record for
// this commit already exists, it is left untouched (frozen). Pruned to commits
// whose session is still in the retained session window.
export function writeCommitMemory(repoPath: string, entry: CommitMemoryEntry): void {
  try {
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return;
    if (!entry.commitSha) return;
    const { sessions, commits } = readMemoryPayload(repoPath);
    if (commits.some((c) => c.commitSha === entry.commitSha)) return; // frozen — never overwrite
    commits.push(entry);
    // Keep only commits belonging to sessions still in memory (bounded window).
    const keep = new Set(sessions.map((s) => s.sessionId));
    // A commit whose session isn't recorded yet (write ordering) is kept too.
    const pruned = commits.filter((c) => keep.size === 0 || keep.has(c.sessionId) || c.sessionId === entry.sessionId);
    writeMemoryPayload(repoPath, sessions, pruned);
  } catch {
    // Non-fatal
  }
}

// ─── Read Memory ───────────────────────────────────────────────────────────

export function readAllSessionMemory(repoPath: string): SessionMemoryEntry[] {
  return readMemoryPayload(repoPath).sessions;
}

// The immutable per-commit records, oldest→newest.
export function readAllCommitMemory(repoPath: string): CommitMemoryEntry[] {
  return readMemoryPayload(repoPath).commits;
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
  // Per-file "what changed" for the most recent session — lets a future agent
  // know each file's recent change without re-reading the diff.
  const lastNotes = Object.entries(last.fileNotes || {}).slice(0, 6);
  if (lastNotes.length) {
    parts.push('  Recent changes:');
    for (const [file, note] of lastNotes) parts.push(`    - ${path.basename(file)}: ${note}`);
  }

  // Files touched across MULTIPLE substantive sessions — the repo's hot spots.
  const fileFreq = new Map<string, number>();
  for (const e of substantive) for (const f of repoRelativeFiles(e.filesChanged)) fileFreq.set(path.basename(f), (fileFreq.get(path.basename(f)) || 0) + 1);
  const hotFiles = Array.from(fileFreq.entries())
    .filter(([, n]) => n >= 2)
    // Prefer files with a real extension. Extensionless names (`oneoneone`,
    // `gandon`, `stvol`) are almost always throwaway scratch; real source and
    // config carry an extension. This DE-PRIORITIZES rather than excludes, so a
    // genuine extensionless file (Makefile, LICENSE) still surfaces if nothing
    // better competes — safe for real repos, quieter in scratch ones.
    .sort((a, b) => (hasFileExtension(b[0]) ? 1 : 0) - (hasFileExtension(a[0]) ? 1 : 0) || b[1] - a[1])
    .slice(0, 6)
    .map(([f]) => f);
  if (hotFiles.length) parts.push(`- Frequently touched: ${hotFiles.join(', ')}`);

  // Decisions/trade-offs carried across substantive sessions — the "why" a fresh
  // agent can't recover from code alone. Most recent first.
  const decisions: string[] = [];
  for (const e of [...substantive].reverse()) for (const d of e.decisions || []) if (!decisions.includes(d)) decisions.push(d);
  if (decisions.length) {
    parts.push('Key decisions from previous sessions:');
    for (const d of decisions.slice(0, 5)) parts.push(`  - ${d}`);
  }

  // Open TODOs carried across substantive sessions.
  const todos: string[] = [];
  for (const e of substantive) for (const t of e.openTodos || []) if (!todos.includes(t)) todos.push(t);
  if (todos.length) {
    parts.push('Open TODOs from previous sessions:');
    for (const t of todos.slice(0, 5)) parts.push(`  - ${t}`);
  }

  // The immutable per-commit log — the granular "what each commit did", distinct
  // from the evolving session rollup above. Most recent few, bounded.
  const commits = readAllCommitMemory(repoPath);
  if (commits.length) {
    parts.push('Recent commits (newest first):');
    for (const c of commits.slice(-5).reverse()) {
      const files = repoRelativeFiles(c.filesChanged).map((f) => path.basename(f)).slice(0, 4).join(', ');
      parts.push(`  - ${c.commitSha.slice(0, 7)} ${c.message.slice(0, 80)}${files ? ` (${files})` : ''}`);
    }
  }

  return parts.join('\n');
}

// ─── Memory continuation brief (LLM, cached in a git note) ───────────────────
//
// A handoff brief for the NEXT agent, synthesized across recent sessions with
// the org LLM key (generated server-side at session end, see hooks.ts). Cached
// on the root commit like the repo brief and injected cache-only at session
// start — the deterministic buildMemoryContext above is the offline fallback.

const MEMORY_BRIEF_REF_NAME = 'origin-memory-brief';

export interface MemoryBrief {
  version: 1;
  brief: string;
  signature: string; // over the substantive entries it was generated from
  generatedAt: string;
}

// Fingerprint of the substantive memory, so the brief is only regenerated when
// the underlying sessions actually change (not on every session-end).
export function memoryBriefSignature(entries: SessionMemoryEntry[]): string {
  const basis = (entries || []).filter(isSubstantiveMemory).map((e) => ({
    id: e.sessionId, s: e.summary, f: (e.filesChanged || []).slice().sort(), t: e.openTodos || [], at: e.endedAt,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 16);
}

function briefRootCommit(repoPath: string): string | null {
  const raw = gitOrNull(['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
  const c = raw ? raw.split('\n')[0] : null;
  return c && /^[a-fA-F0-9]+$/.test(c) ? c : null;
}

export function writeMemoryBrief(repoPath: string, brief: MemoryBrief): void {
  try {
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return;
    const root = briefRootCommit(repoPath);
    if (!root) return;
    git(['notes', `--ref=${MEMORY_BRIEF_REF_NAME}`, 'add', '-f', '-m', JSON.stringify(brief, null, 2), root], { cwd: repoPath, timeoutMs: 10_000 });
  } catch { /* non-fatal */ }
}

export function readMemoryBrief(repoPath: string): MemoryBrief | null {
  try {
    const root = briefRootCommit(repoPath);
    if (!root) return null;
    const raw = git(['notes', `--ref=${MEMORY_BRIEF_REF_NAME}`, 'show', root], { cwd: repoPath, timeoutMs: 10_000 }).trim();
    const data = JSON.parse(raw);
    if (data && data.version === 1 && typeof data.brief === 'string') return data as MemoryBrief;
    return null;
  } catch {
    return null;
  }
}

/**
 * Inject the cached LLM continuation brief — cache-only, never generates here.
 * Returns null for bake-off/ignored repos or when there is no cached brief (the
 * caller then falls back to the deterministic buildMemoryContext).
 */
export function buildMemoryBriefContext(repoPath: string): string | null {
  if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return null;
  const cached = readMemoryBrief(repoPath);
  const brief = cached?.brief?.trim();
  if (!brief) return null;
  return `Prior work in this repo (recent sessions):\n${brief}`;
}

// ─── Clear Memory ──────────────────────────────────────────────────────────

export function clearSessionMemory(repoPath: string): boolean {
  try {
    const opts = { cwd: repoPath, timeoutMs: 10_000 };
    const rootRaw = gitOrNull(['rev-list', '--max-parents=0', 'HEAD'], opts);
    if (!rootRaw) return false;
    const rootCommit = rootRaw.split('\n')[0];
    if (!/^[a-fA-F0-9]+$/.test(rootCommit)) return false;
    // Remove each note independently — the absence of one (e.g. no brief was
    // ever generated) must not abort removing the other.
    let removed = false;
    try { git(['notes', '--ref=origin-memory', 'remove', rootCommit], opts); removed = true; } catch { /* no memory note */ }
    try { git(['notes', `--ref=${MEMORY_BRIEF_REF_NAME}`, 'remove', rootCommit], opts); removed = true; } catch { /* no brief note */ }
    return removed;
  } catch {
    return false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// Build a concise summary from a session's commit subjects — the highest-signal,
// always-available description of what was actually done, far better than a vague
// opening prompt ("create some small nice script — do whatever you want"). Used
// as the heuristic summary when the LLM summarizer is off/keyless. Filters
// Origin's own shadow/notes commits and dedupes. Pure + exported for testing.
const NOISE_COMMIT_SUBJECT = /^(origin shadow\b|Notes added by\b|Merge branch\b|Merge remote|Merge pull request|\[origin\])/i;
export function summarizeFromCommitSubjects(subjects: string[] | undefined | null): string | null {
  const seen = new Set<string>();
  const clean = (subjects || [])
    .map((s) => (s || '').trim())
    .filter((s) => s.length > 0 && !NOISE_COMMIT_SUBJECT.test(s))
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  if (clean.length === 0) return null;
  const shown = clean.slice(0, 3);
  let out = shown.join('; ');
  if (clean.length > shown.length) out += `; +${clean.length - shown.length} more`;
  return out.slice(0, 200);
}

// A basename with a real extension (`foo.ts`, `README.md`) vs an extensionless
// throwaway (`oneoneone`, `gandon`). A leading dot alone doesn't count as an
// extension (`.gitignore` → false), matching Node's path.extname.
export function hasFileExtension(basename: string): boolean {
  return /[^./\\]\.[A-Za-z0-9]+$/.test(basename);
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
