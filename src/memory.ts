import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { git, gitDetailed, gitOrNull, gitIdentityEnv } from './utils/exec.js';
import { getGitRoot } from './session-state.js';
import { isRepoIgnored } from './ignore-repos.js';
import { contextVariant } from './context-variant.js';
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
  // What the session was FOR, in the user's terms — from [Origin: Intent]
  // markers, falling back to the user's first prompt. Distinct from `summary`,
  // which records what the agent DID (and is often the agent's own narration,
  // e.g. "I'll wire constellations into the oracle, then commit"). A resuming
  // agent needs the ask, not the plan: reviewers of the memory digest called
  // out "intent of the last change — what the user asked for, not just the
  // commit title" as the single biggest gap.
  intent?: string[];
  // Reviewer/run checks surfaced this session — from [Origin: Verify] markers.
  // "How do I run and confirm this?" is otherwise unrecoverable from the diff.
  verify?: string[];
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

// ─── How much the note keeps ─────────────────────────────────────────────────
//
// The note used to keep the last 20 sessions, whatever their size. That count
// said nothing about what it was protecting — the note's size — because a
// session's cost is mostly its commit records (on this repo 371 KB of a 464 KB
// note), and one busy session outweighs ten chat-only ones. So the window is a
// byte budget now: keep the newest sessions whose rollups and commit records
// fit, and never fewer than MIN_SESSIONS_KEPT however large they are.
//
// What falls out of the window is not all lost: a session's open TODOs and
// decisions move into `archivedTodos` / `archivedDecisions` — see settlePayload.
export const MEMORY_BUDGET_BYTES = 1024 * 1024;
const MIN_SESSIONS_KEPT = 5;
// The archive's slice of the budget. It only grows, so without its own ceiling
// it would slowly squeeze the session window down to MIN_SESSIONS_KEPT.
const ARCHIVE_SHARE = 0.25;

/** The byte budget in force. The env override exists for tests, which write small sessions. */
export function memoryBudgetBytes(): number {
  const raw = Number(process.env.ORIGIN_MEMORY_BUDGET_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : MEMORY_BUDGET_BYTES;
}

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

/**
 * May an INJECTION path read this repo's memory? Not in an ignored repo, and
 * not in a bake-off repo — unless the process runs under a context variant,
 * where the replay harness has given the clone only the history that existed
 * before its task (see context-variant.ts). Write paths keep the plain
 * isBakeoffRepo gate: an arm's work is never remembered.
 */
export function memoryReadBlocked(repoPath: string | undefined | null): boolean {
  if (isRepoIgnored(repoPath)) return true;
  return isBakeoffRepo(repoPath) && contextVariant() === null;
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
export interface MemoryPayload {
  version: number;
  sessions: SessionMemoryEntry[];
  commits: CommitMemoryEntry[];
  // Commit SHAs deliberately removed, and never to be re-added.
  //
  // Commit records are immutable and the cross-machine merge UNIONS them, which
  // together made a wrong record permanent: a commit recorded under the wrong
  // agent was deleted locally, and the next sync folded the remote copy — which
  // still had it — straight back in. Observed exactly that with 74d04c6, filed
  // under antigravity when Cursor had made it. Immutability is meant to stop
  // records being rewritten, not to make a mistake unfixable, so removal is
  // expressed as a fact that merges like any other rather than as an absence,
  // which merges as nothing.
  tombstones?: CommitTombstone[];
  // TODO closures. Same reasoning as `tombstones`, for the other append-only
  // record in here: `openTodos` is written by session end and never edited, so
  // a leftover that someone has since dealt with is re-read as open forever.
  // A closure is the fact "this was discharged", which merges like any other
  // fact; the absence of a TODO would merge as nothing.
  //
  // In the NOTE rather than `~/.origin/origin-todos.json` because the TODO
  // itself travels with the repo and its closure has to travel the same way —
  // a closure recorded only on one laptop leaves every clone, every other
  // machine and CI reading the item as still open.
  closedTodos?: TodoClosure[];
  // TODOs a person typed (`origin todo add`). Session-mined leftovers reach the
  // repo through `openTodos` on a session rollup, but a manual one had no
  // session to be written under, so it lived only in
  // `~/.origin/origin-todos.json` — one laptop's file, outside any repo. Every
  // clone, every other machine, every other agent and CI read the list without
  // it: three follow-ups recorded on 2026-09-15 were invisible to everything
  // except the machine that typed them.
  //
  // Same append-only shape as `closedTodos`, and closed the same way — the
  // closure is the fact that discharges it.
  manualTodos?: ManualTodo[];
  // Open TODOs and decisions of sessions that aged out of the window.
  //
  // They lived only on the session rollup, so when the rollup was dropped they
  // went with it: an unfinished item vanished from `origin todo list` once 20
  // newer sessions had run — every few days on a busy repo — without anyone
  // closing it. The rest of a rollup (summary, files, line counts) describes
  // work that is done, and can go; these two describe what is still owed and
  // why the code is the way it is, and cannot be recovered from the code.
  archivedTodos?: ArchivedItem[];
  archivedDecisions?: ArchivedItem[];
}

/**
 * A TODO or decision carried over from a session that left the window.
 *
 * Keyed by text like a closure (see todoClosureKey): the same sentence recorded
 * by several sessions is one item. The session it came from is kept so the TODO
 * keeps the id it was listed under — `todoDisplayId(text, sessionId)`.
 */
export interface ArchivedItem {
  key: string;
  text: string;
  sessionId: string;
  agentSlug?: string;
  branch?: string | null;
  /** When the session that recorded it ended. */
  at: string;
}

/**
 * A TODO that has been discharged.
 *
 * KEYED BY TEXT, not by the TODO id. An id is `hash(text + sessionId)`, and
 * session end re-records a long-running leftover under each new session that
 * mentions it — so the same sentence has a different id every time it comes
 * back, and an id-keyed closure suppresses exactly one of its incarnations.
 *
 * `state` is what makes a closure evidence rather than an assertion. An agent
 * saying it fixed something is a claim about a working tree; the claim becomes
 * a fact when the work reaches the default branch. `pending` is the claim,
 * `closed` is the fact, and only `closed` hides the item — see todo-sweep.ts.
 */
export interface TodoClosure {
  /** The TODO's text, lowercased and whitespace-collapsed. */
  key: string;
  /** The id it carried when closed. Display only — see the note above. */
  id: string;
  text: string;
  /** Why it is closed. A bare key in a suppression list is unreviewable later. */
  reason: string;
  at: string;
  state: 'pending' | 'closed';
  /** The session that asserted the closure. */
  sessionId?: string;
  /** Commits carrying the closing work. The promotion check reads these. */
  shas?: string[];
  /** When `pending` became `closed`. */
  confirmedAt?: string;
}

/**
 * A TODO someone typed, recorded in the repo rather than on one machine.
 *
 * KEYED BY TEXT like a closure, and for the same reason: the id is
 * `hash(text + something)`, and the same sentence typed twice (or typed here
 * and mined from a prompt there) must be ONE item. The id is kept for display
 * so `origin todo done <id>` resolves what the list printed.
 */
export interface ManualTodo {
  /** The TODO's text, lowercased and whitespace-collapsed — see todoClosureKey. */
  key: string;
  /** The id the list shows. Display only; the key is what identifies it. */
  id: string;
  text: string;
  /** When it was typed. First write wins, so re-adding keeps the original. */
  at: string;
  /** The session that typed it, when there was one. */
  sessionId?: string;
  branch?: string | null;
}

/**
 * The id `origin todo` shows for a TODO.
 *
 * Lives here rather than in todo.ts so the INJECTED context can print it:
 * an agent that cannot see a TODO's id cannot write `[Origin: Closes] <id>`,
 * and prose matching is the fallback, not the intended path. todo.ts imports
 * memory.ts, so the helper has to sit on this side of that edge.
 */
export function todoDisplayId(text: string, sessionId: string): string {
  return crypto.createHash('sha256').update(text + sessionId).digest('hex').slice(0, 8);
}

/** The durable key for a TODO: its text, lowercased and collapsed. */
export function todoClosureKey(text: string): string {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface CommitTombstone {
  commitSha: string;
  // Why it was removed. Kept because a bare sha in a deletion list is
  // unreviewable six months later.
  reason: string;
  at: string;
}

function memoryRootCommit(repoPath: string): string | null {
  const raw = gitOrNull(['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
  const c = raw ? raw.split('\n')[0] : null;
  return c && /^[a-fA-F0-9]+$/.test(c) ? c : null;
}

const EMPTY_PAYLOAD = (): MemoryPayload => ({
  version: 2, sessions: [], commits: [], tombstones: [], closedTodos: [], manualTodos: [],
  archivedTodos: [], archivedDecisions: [],
});

/** Parse a note's JSON into a payload, defaulting every record a note may lack. */
function parsePayload(raw: string): MemoryPayload {
  const data = JSON.parse(raw);
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    sessions: list(data.sessions),
    commits: list(data.commits), // absent in v1 payloads
    tombstones: list(data.tombstones),
    closedTodos: list(data.closedTodos),
    // Absent in every payload written before manual TODOs travelled.
    manualTodos: list(data.manualTodos),
    // Absent in every payload written before the window became a byte budget.
    archivedTodos: list(data.archivedTodos),
    archivedDecisions: list(data.archivedDecisions),
  };
}

/**
 * The note, for a caller about to WRITE it back. Throws when the note could
 * not be read — a timeout, a lock, a broken repo — rather than returning an
 * empty payload.
 *
 * Every writer here is read-modify-write of the whole note. Reading "nothing"
 * after a failed read and writing the result back replaces the repo's entire
 * memory with the one record the writer was adding. Only "there is no note
 * yet" is an empty payload; a note that exists but will not parse is too,
 * because nothing can recover it and refusing would stop memory for good.
 */
function loadMemoryPayloadForWrite(repoPath: string): MemoryPayload {
  const root = memoryRootCommit(repoPath);
  if (!root) return EMPTY_PAYLOAD();
  const r = gitDetailed(['notes', '--ref=origin-memory', 'show', root], { cwd: repoPath, timeoutMs: 10_000 });
  if (r.status !== 0) {
    if (/no note found/i.test(r.stderr)) return EMPTY_PAYLOAD();
    throw new Error(`memory note unreadable: ${r.stderr.trim() || `exit ${r.status}`}`);
  }
  try {
    return parsePayload(r.stdout.trim());
  } catch {
    return EMPTY_PAYLOAD();
  }
}

/** The note, for a caller that only reads it: anything unreadable reads as empty. */
export function readMemoryPayload(repoPath: string): MemoryPayload {
  try {
    return loadMemoryPayloadForWrite(repoPath);
  } catch {
    return EMPTY_PAYLOAD();
  }
}

/**
 * Bytes a record — or a list of records — takes in the stored note, measured
 * at the depth it is stored at: every record sits in a top-level array, and
 * pretty-printing indents it four spaces deeper than it prints on its own.
 */
function bytesOf(v: unknown): number {
  return Buffer.byteLength(JSON.stringify({ k: Array.isArray(v) ? v : [v] }, null, 2), 'utf8');
}

/**
 * Apply the note's retention rules. Pure — exported for testing.
 *
 * Every write and every merge goes through this, so a payload grown on one
 * machine and one merged from two are held to the same shape:
 *
 *  1. The session window. Newest sessions first, each costing its rollup plus
 *     its commit records, until the budget left after the other records runs
 *     out — but never fewer than MIN_SESSIONS_KEPT. The kept sessions keep
 *     their stored order; only which ones stay is decided by time.
 *  2. What an evicted session still owes moves to the archive: its open TODOs
 *     (unless a confirmed closure already discharged them) and its decisions.
 *     Its commit records go with it, as they always did.
 *  3. The archive is held to its own share of the budget, dropping the oldest
 *     decisions first and the oldest TODOs only after every decision is gone —
 *     an unfinished item is the thing this exists to keep.
 *  4. Closures that no longer reach any TODO are dropped, and a TODO a
 *     confirmed closure discharges leaves the manual list and the archive.
 */
export function settlePayload(p: MemoryPayload, budget: number = memoryBudgetBytes()): MemoryPayload {
  const sessions = p.sessions || [];
  const commits = p.commits || [];
  const tombstones = p.tombstones || [];
  const manualTodos = p.manualTodos || [];
  let closedTodos = p.closedTodos || [];

  const commitsBySession = new Map<string, CommitMemoryEntry[]>();
  for (const c of commits) {
    const list = commitsBySession.get(c.sessionId) || [];
    list.push(c);
    commitsBySession.set(c.sessionId, list);
  }
  const sessionIds = new Set(sessions.map((s) => s.sessionId));
  // A commit whose session is not recorded (write ordering — see
  // writeCommitMemory) has no session to be evicted with, so it is fixed cost.
  const unowned = commits.filter((c) => !sessionIds.has(c.sessionId));

  const archiveBudget = Math.floor(budget * ARCHIVE_SHARE);
  const fixed = bytesOf(tombstones) + bytesOf(closedTodos) + bytesOf(manualTodos) + bytesOf(unowned);
  const windowBudget = budget - archiveBudget - fixed;

  const kept = new Set<string>();
  let used = 0;
  // A tie goes to the one recorded later, as the old count window's slice did.
  const newestFirst = sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (entryTime(b.s) - entryTime(a.s)) || (b.i - a.i))
    .map(({ s }) => s);
  for (const s of newestFirst) {
    const cost = bytesOf(s) + bytesOf(commitsBySession.get(s.sessionId) || []);
    if (kept.size >= MIN_SESSIONS_KEPT && used + cost > windowBudget) break;
    kept.add(s.sessionId);
    used += cost;
  }
  const evicted = sessions.filter((s) => !kept.has(s.sessionId));

  const confirmedClosed = new Set(closedTodos.filter((c) => c?.state === 'closed').map((c) => c.key));
  const archivedTodos = new Map<string, ArchivedItem>();
  const archivedDecisions = new Map<string, ArchivedItem>();
  for (const a of p.archivedTodos || []) if (a?.key && a.text && !archivedTodos.has(a.key)) archivedTodos.set(a.key, a);
  for (const a of p.archivedDecisions || []) if (a?.key && a.text && !archivedDecisions.has(a.key)) archivedDecisions.set(a.key, a);
  // Oldest evicted first, so an item several sessions recorded is archived
  // under the first of them — the same "first seen wins" as every other record.
  for (const s of [...evicted].sort((a, b) => entryTime(a) - entryTime(b))) {
    const from = (text: string): ArchivedItem => ({
      key: todoClosureKey(text), text: text.trim(), sessionId: s.sessionId,
      ...(s.agentSlug ? { agentSlug: s.agentSlug } : {}),
      branch: s.branch ?? null,
      at: s.endedAt || s.startedAt || '',
    });
    for (const t of s.openTodos || []) {
      if (typeof t !== 'string' || !t.trim()) continue;
      const item = from(t);
      if (!confirmedClosed.has(item.key) && !archivedTodos.has(item.key)) archivedTodos.set(item.key, item);
    }
    for (const d of s.decisions || []) {
      if (typeof d !== 'string' || !d.trim()) continue;
      const item = from(d);
      if (!archivedDecisions.has(item.key)) archivedDecisions.set(item.key, item);
    }
  }

  const byAge = (a: ArchivedItem, b: ArchivedItem) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0);
  let todosOut = [...archivedTodos.values()].filter((t) => !confirmedClosed.has(t.key)).sort(byAge);
  let decisionsOut = [...archivedDecisions.values()].sort(byAge);
  let archiveBytes = bytesOf(todosOut) + bytesOf(decisionsOut);
  while (archiveBytes > archiveBudget && decisionsOut.length > 0) {
    archiveBytes -= bytesOf(decisionsOut[0]);
    decisionsOut = decisionsOut.slice(1);
  }
  while (archiveBytes > archiveBudget && todosOut.length > 0) {
    archiveBytes -= bytesOf(todosOut[0]);
    todosOut = todosOut.slice(1);
  }

  const keptSessions = sessions.filter((s) => kept.has(s.sessionId));
  const evictedIds = new Set(evicted.map((s) => s.sessionId));
  // A closure exists to suppress a TODO. Once nothing carries that TODO — no
  // kept session, no manual item, no archived one — the closure is dead weight.
  // Only prune what is UNREACHABLE, never what is merely closed: dropping a
  // closure whose TODO is still here resurrects the TODO.
  const liveTodoKeys = new Set<string>();
  for (const e of keptSessions) for (const t of e.openTodos || []) liveTodoKeys.add(todoClosureKey(t));
  for (const m of manualTodos) if (m?.key) liveTodoKeys.add(m.key);
  for (const a of todosOut) liveTodoKeys.add(a.key);
  closedTodos = closedTodos.filter((c) => liveTodoKeys.has(c.key));
  // Closed means gone — the item leaves, and its closure leaves with it on the
  // next write, once nothing references the key any more.
  const closedKeys = new Set(closedTodos.filter((c) => c.state === 'closed').map((c) => c.key));

  return {
    version: 2,
    sessions: keptSessions,
    commits: commits.filter((c) => !evictedIds.has(c.sessionId)),
    tombstones,
    closedTodos,
    manualTodos: manualTodos.filter((m) => m?.key && !closedKeys.has(m.key)),
    archivedTodos: todosOut.filter((t) => !closedKeys.has(t.key)),
    archivedDecisions: decisionsOut,
  };
}

function writeMemoryPayload(
  repoPath: string,
  sessions: SessionMemoryEntry[],
  commits: CommitMemoryEntry[],
  // Optional so the many existing callers stay unchanged: omitting it PRESERVES
  // whatever tombstones are already recorded. Dropping them on an ordinary write
  // would quietly resurrect everything they suppress.
  tombstones?: CommitTombstone[],
  // Same contract as `tombstones`: omitting it PRESERVES what is recorded.
  closedTodos?: TodoClosure[],
  // Same contract again. A session-end write knows nothing about the TODOs a
  // person typed, and must not drop them.
  manualTodos?: ManualTodo[],
  // And again: only a merge knows the other side's archive.
  archive?: { todos: ArchivedItem[]; decisions: ArchivedItem[] },
): void {
  const root = memoryRootCommit(repoPath);
  if (!root) return;
  const existing = (tombstones === undefined || closedTodos === undefined || manualTodos === undefined || archive === undefined)
    ? loadMemoryPayloadForWrite(repoPath)
    : null;
  const keptTombstones = tombstones ?? existing?.tombstones ?? [];
  const suppressed = new Set(keptTombstones.map((t) => t.commitSha));
  const settled = settlePayload({
    version: 2,
    sessions,
    commits: commits.filter((c) => !suppressed.has(c.commitSha)),
    tombstones: keptTombstones,
    closedTodos: closedTodos ?? existing?.closedTodos ?? [],
    manualTodos: manualTodos ?? existing?.manualTodos ?? [],
    archivedTodos: archive?.todos ?? existing?.archivedTodos ?? [],
    archivedDecisions: archive?.decisions ?? existing?.archivedDecisions ?? [],
  });
  // On STDIN, not `-m <payload>`. The payload is hundreds of KB, and an argv
  // string that size is refused by the OS before git ever runs: Linux caps one
  // argument at 128 KB, Windows a whole command line at 32 KB. The write is
  // best-effort, so every caller swallowed the E2BIG and memory just stopped
  // being recorded there.
  const r = gitDetailed(['notes', '--ref=origin-memory', 'add', '-f', '-F', '-', root], {
    cwd: repoPath, timeoutMs: 10_000, env: gitIdentityEnv(repoPath), input: JSON.stringify(settled, null, 2),
  });
  if (r.status !== 0) throw new Error(`git notes add failed: ${r.stderr.trim()}`);
}

/** Write a payload whole — every record, none preserved from the note. For merge results. */
function writeWholePayload(repoPath: string, p: MemoryPayload): void {
  writeMemoryPayload(
    repoPath, p.sessions, p.commits, p.tombstones || [], p.closedTodos || [], p.manualTodos || [],
    { todos: p.archivedTodos || [], decisions: p.archivedDecisions || [] },
  );
}

// ─── Cross-machine merge ───────────────────────────────────────────────────
//
// The memory payload is ONE note on ONE object (the root commit), so two
// machines that both wrote memory always collide on that object. `git notes
// merge -s ours` — the strategy that works fine for the per-commit
// refs/notes/origin — would silently discard the entire other side here,
// because "ours" resolves the whole blob, not individual sessions. The merge
// therefore has to happen inside the payload.
//
// Session rollups are MUTABLE (upserted as a session progresses), so the
// newer write wins per sessionId. Commit records are IMMUTABLE (frozen once
// written), so either copy is equivalent and we keep ours for determinism.

/** Millisecond timestamp for recency comparison; -Infinity when unparseable. */
function entryTime(e: SessionMemoryEntry): number {
  const t = Date.parse(e?.endedAt || e?.startedAt || '');
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Union two memory payloads. Pure — exported for testing.
 *
 * sessions: keyed by sessionId, newer `endedAt` (else `startedAt`) wins; ties
 *           and unparseable timestamps keep `local` so a merge is idempotent.
 * commits:  keyed by commitSha, first-seen wins (records are frozen).
 *
 * Result is sorted oldest→newest and settled by the same rules the writers
 * apply (settlePayload) — so a merged payload is indistinguishable from a
 * locally-grown one.
 */
export function mergeMemoryPayloads(local: MemoryPayload, remote: MemoryPayload, budget?: number): MemoryPayload {
  const sessions = new Map<string, SessionMemoryEntry>();
  for (const e of local?.sessions || []) if (e?.sessionId) sessions.set(e.sessionId, e);
  for (const e of remote?.sessions || []) {
    if (!e?.sessionId) continue;
    const mine = sessions.get(e.sessionId);
    // Strictly-greater: on a tie local wins, which keeps merge(a,b) stable.
    if (!mine || entryTime(e) > entryTime(mine)) sessions.set(e.sessionId, e);
  }

  // Tombstones union like everything else, and a deletion recorded on EITHER
  // side wins. That asymmetry is deliberate: the whole point is that one machine
  // can retract a wrong record and have the retraction stick, and a merge where
  // the un-deleted side wins would restore it on the very next sync — which is
  // precisely how 74d04c6 kept coming back.
  const tombstones = new Map<string, CommitTombstone>();
  for (const t of [...(local?.tombstones || []), ...(remote?.tombstones || [])]) {
    if (t?.commitSha && !tombstones.has(t.commitSha)) tombstones.set(t.commitSha, t);
  }

  // Closures union by key, and a CONFIRMED closure beats a pending one from
  // the other side however the timestamps fall — promotion is monotonic (a
  // merge is evidence that arrived, never evidence that was withdrawn), so
  // letting a stale `pending` win would un-close an item on the next sync,
  // which is the 74d04c6 failure in a different record.
  const closedTodos = new Map<string, TodoClosure>();
  for (const c of [...(local?.closedTodos || []), ...(remote?.closedTodos || [])]) {
    if (!c?.key) continue;
    const mine = closedTodos.get(c.key);
    if (!mine || (mine.state !== 'closed' && c.state === 'closed')) closedTodos.set(c.key, c);
  }

  // Manual TODOs and archived items union by key, first seen wins — the item
  // is the same sentence whichever machine recorded it, and keeping the first
  // keeps its original `at`.
  const unionByKey = <T extends { key: string; text: string }>(a?: T[], b?: T[]): T[] => {
    const out = new Map<string, T>();
    for (const m of [...(a || []), ...(b || [])]) if (m?.key && m.text && !out.has(m.key)) out.set(m.key, m);
    return [...out.values()];
  };

  const commits = new Map<string, CommitMemoryEntry>();
  for (const c of local?.commits || []) if (c?.commitSha) commits.set(c.commitSha, c);
  for (const c of remote?.commits || []) {
    if (c?.commitSha && !commits.has(c.commitSha)) commits.set(c.commitSha, c);
  }
  for (const sha of tombstones.keys()) commits.delete(sha);

  const mergedSessions = [...sessions.values()].sort((a, b) => entryTime(a) - entryTime(b));

  // Commit records of a session neither side still has are orphans — the
  // session left one side's window and this record was never pruned there.
  const known = new Set(mergedSessions.map((s) => s.sessionId));
  // The union is what makes this necessary: a machine that folded a rebase copy
  // away gets it handed straight back by one that hasn't, so the fold has to
  // happen again on the merged result or it never sticks.
  const mergedCommits = dedupeRebasedCommits(
    [...commits.values()]
      .filter((c) => known.size === 0 || known.has(c.sessionId))
      .sort((a, b) => {
        const ta = Date.parse(a?.committedAt || ''), tb = Date.parse(b?.committedAt || '');
        return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
      }),
  );

  return settlePayload({
    version: 2,
    sessions: mergedSessions,
    commits: mergedCommits,
    tombstones: [...tombstones.values()],
    closedTodos: [...closedTodos.values()],
    manualTodos: unionByKey(local?.manualTodos, remote?.manualTodos),
    archivedTodos: unionByKey(local?.archivedTodos, remote?.archivedTodos),
    archivedDecisions: unionByKey(local?.archivedDecisions, remote?.archivedDecisions),
  }, budget);
}

/** Read the memory payload out of an arbitrary notes ref, or null if absent. */
export function readMemoryPayloadFromRef(repoPath: string, ref: string): MemoryPayload | null {
  try {
    const root = memoryRootCommit(repoPath);
    if (!root) return null;
    const raw = git(['notes', `--ref=${ref}`, 'show', root], { cwd: repoPath, timeoutMs: 10_000 }).trim();
    if (!raw) return null;
    return parsePayload(raw);
  } catch {
    return null;
  }
}

/**
 * Fold a fetched remote memory note (staged in `stagingRef`) into local memory.
 * Returns true when local memory actually changed.
 */
export function foldRemoteMemory(repoPath: string, stagingRef: string): boolean {
  try {
    const remote = readMemoryPayloadFromRef(repoPath, stagingRef);
    if (!remote) return false;
    const local = loadMemoryPayloadForWrite(repoPath);
    const merged = mergeMemoryPayloads(local, remote);
    // Compare — and write — EVERY record. Sessions and commits alone left the
    // rest unable to arrive: `writeMemoryPayload` preserves what it is not
    // given, so passing only some re-wrote the LOCAL copies over the merged
    // ones, discarding everything the remote had just contributed. Narrowing
    // the comparison the same way also made a sync whose only news was a
    // retraction or a closure report "nothing changed" and write nothing.
    const shape = (p: MemoryPayload) => JSON.stringify({
      s: p.sessions, c: p.commits, t: p.tombstones || [], d: p.closedTodos || [],
      m: p.manualTodos || [], at: p.archivedTodos || [], ad: p.archivedDecisions || [],
    });
    if (shape(local) === shape(merged)) return false;
    writeWholePayload(repoPath, merged);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile local memory onto the remote tip so the next push FAST-FORWARDS.
 *
 * foldRemoteMemory alone is not enough before a retry. Two machines that each
 * created their memory note independently have notes refs with no common
 * ancestor, so merging the payload fixes the CONTENT but leaves the ref
 * histories unrelated — every retry is rejected as non-fast-forward, forever,
 * and the second machine's memory never publishes. (Caught by the two
 * concurrent-clone cases in memory-notes-transport.test.ts.)
 *
 * So: compute the union FIRST, then re-point the local ref at the fetched
 * remote tip, then write the union on top. The resulting note commit is a
 * child of what's on the remote, which pushes cleanly, and it carries both
 * sides' entries. Returns true when the local ref was repositioned.
 */
export function reconcileMemoryWithRemote(repoPath: string, stagingRef: string): boolean {
  try {
    const remote = readMemoryPayloadFromRef(repoPath, stagingRef);
    if (!remote) return false;
    const merged = mergeMemoryPayloads(loadMemoryPayloadForWrite(repoPath), remote);
    const opts = { cwd: repoPath, timeoutMs: 10_000 };
    git(['update-ref', MEMORY_REF, stagingRef], opts);
    // Every record, for the reason spelled out in foldRemoteMemory: the ref
    // now points at the REMOTE tip, so anything not written here is whatever
    // the remote had, and the local side's retractions and closures are gone.
    writeWholePayload(repoPath, merged);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep a session rollup's [startedAt, endedAt] window consistent with what the
 * record itself claims the session did.
 *
 * Two ways the window used to end up lying. (1) A re-homed / resumed session
 * keeps its id but re-stamps startedAt, so the upsert SHRANK the window and the
 * entry's own earlier commits fell outside it. (2) The commit records reference
 * a session whose window never contained their commit time. Observed live: a
 * session claiming an 89-second window (15:52:10Z–15:53:39Z) credited with a
 * commit made 14 hours earlier. A reader cannot tell which half is wrong, so
 * both stop being usable evidence — and this record is what `origin why` and
 * the PR surface reason from.
 *
 * So the window only ever GROWS: back to the earliest of (previous startedAt,
 * new startedAt, the earliest commit attributed to this session) and forward to
 * the latest endedAt. The times themselves are never invented — every candidate
 * is something the record already asserted.
 *
 * Pure + exported for testing.
 */
export function reconcileSessionWindow(
  entry: SessionMemoryEntry,
  previous: SessionMemoryEntry | undefined,
  commits: CommitMemoryEntry[],
): SessionMemoryEntry {
  const ms = (iso: string | undefined): number => {
    const t = iso ? new Date(iso).getTime() : NaN;
    return Number.isFinite(t) ? t : NaN;
  };
  const earliest = (...isos: Array<string | undefined>): string | undefined => {
    const dated = isos.filter((i): i is string => Number.isFinite(ms(i)));
    return dated.length ? dated.reduce((a, b) => (ms(a) <= ms(b) ? a : b)) : undefined;
  };
  const latest = (...isos: Array<string | undefined>): string | undefined => {
    const dated = isos.filter((i): i is string => Number.isFinite(ms(i)));
    return dated.length ? dated.reduce((a, b) => (ms(a) >= ms(b) ? a : b)) : undefined;
  };

  const ownCommitTimes = (commits || [])
    .filter((c) => c && c.sessionId === entry.sessionId)
    .map((c) => c.committedAt);

  return {
    ...entry,
    startedAt: earliest(entry.startedAt, previous?.startedAt, ...ownCommitTimes) || entry.startedAt,
    endedAt: latest(entry.endedAt, previous?.endedAt, ...ownCommitTimes) || entry.endedAt,
  };
}

/**
 * A session's recorded work only ever GROWS across its own upserts.
 *
 * A session writes memory at each commit and again at session end, and every
 * write replaced the last. A post-commit write carries that commit's files, so
 * the entry ended up describing only the LAST commit: session 64038e34 changed
 * ~10 files across four merged PRs and its entry listed one file — the test
 * the final commit touched. Same rule as reconcileSessionWindow applies to the
 * time window: keep everything the record already asserted.
 *
 * Pure + exported for testing.
 */
export function accumulateSessionWork(entry: SessionMemoryEntry, previous: SessionMemoryEntry | undefined): SessionMemoryEntry {
  if (!previous) return entry;
  const files = Array.from(new Set([...(previous.filesChanged || []), ...(entry.filesChanged || [])]));
  return {
    ...entry,
    filesChanged: files,
    linesAdded: Math.max(entry.linesAdded || 0, previous.linesAdded || 0),
    linesRemoved: Math.max(entry.linesRemoved || 0, previous.linesRemoved || 0),
  };
}

/**
 * Drop open items the repo already knows are done, so the next agent is not
 * handed a list of leftovers that shipped.
 *
 * Only CONFIRMED closures count — a pending one is a claim, and todo-sweep.ts
 * does not hide it either. Two matches: the item's own text, or an item that
 * is itself about another TODO (`TODO \`87ec29e1\`: …`) whose id is closed.
 *
 * Pure + exported for testing.
 */
export function withoutResolvedTodos(entry: SessionMemoryEntry, closures: readonly TodoClosure[]): SessionMemoryEntry {
  const closed = (closures || []).filter((c) => c && c.state === 'closed');
  if (closed.length === 0 || !(entry.openTodos || []).length) return entry;
  const keys = new Set(closed.map((c) => c.key));
  const ids = new Set(closed.map((c) => (c.id || '').toLowerCase()).filter(Boolean));
  const refersToClosed = (text: string) => {
    for (const m of text.matchAll(/\bTODO\s*[`'"]?([0-9a-f]{8})\b/gi)) if (ids.has(m[1].toLowerCase())) return true;
    return false;
  };
  const openTodos = entry.openTodos.filter((t) => !keys.has(todoClosureKey(t)) && !refersToClosed(t));
  return openTodos.length === entry.openTodos.length ? entry : { ...entry, openTodos };
}

export function writeSessionMemory(repoPath: string, entry: SessionMemoryEntry): void {
  try {
    // Don't accumulate memory for bake-off arms or repos the user excluded —
    // it only pollutes the shared repo's memory with benchmark noise.
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return;
    const { sessions, commits, closedTodos } = loadMemoryPayloadForWrite(repoPath);
    // UPSERT by sessionId — a session may write memory more than once (at each
    // commit AND at session end, per `memoryUpdate`), and we want ONE entry per
    // session that reflects its latest state, not a duplicate per write.
    const idx = sessions.findIndex((e) => e.sessionId === entry.sessionId);
    const previous = idx >= 0 ? sessions[idx] : undefined;
    const merged = withoutResolvedTodos(
      accumulateSessionWork(reconcileSessionWindow(entry, previous, commits), previous),
      closedTodos || [],
    );
    if (idx >= 0) sessions[idx] = merged;
    else sessions.push(merged);
    // Prune commit records whose session is no longer recorded. Which sessions
    // stay is decided by writeMemoryPayload's budget — see settlePayload.
    const keep = new Set(sessions.map((s) => s.sessionId));
    writeMemoryPayload(repoPath, sessions, commits.filter((c) => keep.has(c.sessionId)));
  } catch {
    // Non-fatal — memory is nice-to-have
  }
}

// Record an IMMUTABLE per-commit memory entry. Add-once by SHA: if a record for
// this commit already exists, it is left untouched (frozen). Pruned to commits
// whose session is still in the retained session window.
/**
 * Retract a per-commit memory record: remove it AND record why, so it cannot
 * come back.
 *
 * Commit records are immutable and merge by union, which is right for the case
 * they were designed for — two machines each holding half the history — but it
 * meant a WRONG record was permanent. 74d04c6 was filed under antigravity when
 * Cursor had made it; deleting it locally worked until the next sync folded the
 * remote copy back in. Immutability should stop a record being quietly
 * rewritten, not stop a mistake being corrected.
 *
 * Returns true when something was actually retracted. Idempotent: retracting
 * the same sha twice leaves one tombstone.
 */
export function forgetCommitMemory(repoPath: string, commitSha: string, reason: string): boolean {
  try {
    if (!commitSha || !reason) return false;
    const { sessions, commits, tombstones } = loadMemoryPayloadForWrite(repoPath);
    const existing = tombstones || [];
    if (existing.some((t) => t.commitSha === commitSha)) return false;
    const next = [
      ...existing,
      { commitSha, reason, at: new Date().toISOString() },
    ];
    writeMemoryPayload(repoPath, sessions, commits.filter((c) => c.commitSha !== commitSha), next);
    return true;
  } catch {
    return false;
  }
}

/** Every TODO closure recorded in this repo's memory, pending and confirmed. */
export function readTodoClosures(repoPath: string): TodoClosure[] {
  try {
    return readMemoryPayload(repoPath).closedTodos || [];
  } catch {
    return [];
  }
}

/**
 * Record TODO closures in the repo's memory note.
 *
 * Upserts by key. A `pending` claim never overwrites a `closed` fact — a later
 * session re-asserting something already confirmed must not demote it back to
 * unproven — and re-recording the same pending claim keeps the FIRST one, so
 * the `at` stamp stays the moment the work was actually done.
 *
 * Returns how many closures the note gained or promoted.
 */
export function recordTodoClosures(repoPath: string, closures: TodoClosure[]): number {
  try {
    if (!closures?.length) return 0;
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return 0;
    const { sessions, commits, tombstones, closedTodos } = loadMemoryPayloadForWrite(repoPath);
    const byKey = new Map<string, TodoClosure>();
    for (const c of closedTodos || []) if (c?.key) byKey.set(c.key, c);
    let changed = 0;
    for (const c of closures) {
      if (!c?.key || !c.text) continue;
      const mine = byKey.get(c.key);
      if (mine && (mine.state === 'closed' || c.state !== 'closed')) continue;
      byKey.set(c.key, mine && c.state === 'closed'
        // Promotion keeps the original claim and stamps it, so the record still
        // says when the work was done as well as when it landed.
        ? { ...mine, state: 'closed', confirmedAt: c.confirmedAt || new Date().toISOString() }
        : c);
      changed++;
    }
    if (changed === 0) return 0;
    writeMemoryPayload(repoPath, sessions, commits, tombstones, [...byKey.values()]);
    return changed;
  } catch {
    return 0;
  }
}

/** Open TODOs and decisions carried over from sessions that left the window. */
export function readArchivedMemory(repoPath: string): { todos: ArchivedItem[]; decisions: ArchivedItem[] } {
  try {
    const p = readMemoryPayload(repoPath);
    return { todos: p.archivedTodos || [], decisions: p.archivedDecisions || [] };
  } catch {
    return { todos: [], decisions: [] };
  }
}

/** The TODOs someone typed against this repo, as recorded in its memory note. */
export function readManualTodos(repoPath: string): ManualTodo[] {
  try {
    return readMemoryPayload(repoPath).manualTodos || [];
  } catch {
    return [];
  }
}

/**
 * Record typed TODOs in the repo's memory note so they travel with the repo.
 *
 * Add-once by key: re-adding the same sentence keeps the first record, so its
 * `at` stays the moment it was actually written down. Returns how many the note
 * gained.
 */
export function recordManualTodos(repoPath: string, items: ManualTodo[]): number {
  try {
    if (!items?.length) return 0;
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return 0;
    const { sessions, commits, tombstones, closedTodos, manualTodos } = loadMemoryPayloadForWrite(repoPath);
    const byKey = new Map<string, ManualTodo>();
    for (const m of manualTodos || []) if (m?.key) byKey.set(m.key, m);
    let added = 0;
    for (const m of items) {
      if (!m?.key || !m.text || byKey.has(m.key)) continue;
      byKey.set(m.key, m);
      added++;
    }
    if (added === 0) return 0;
    writeMemoryPayload(repoPath, sessions, commits, tombstones, closedTodos, [...byKey.values()]);
    return added;
  } catch {
    return 0;
  }
}

export function writeCommitMemory(repoPath: string, entry: CommitMemoryEntry): void {
  try {
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return;
    if (!entry.commitSha) return;
    const { sessions, commits, tombstones } = loadMemoryPayloadForWrite(repoPath);
    // A retracted commit stays retracted. Without this the writer that produced
    // the wrong record in the first place simply writes it again on the next
    // poll, and the retraction is a no-op with extra steps.
    if ((tombstones || []).some((t) => t.commitSha === entry.commitSha)) return;
    const existing = commits.find((c) => c.commitSha === entry.commitSha);
    if (existing) {
      // Add-once: the record's content is frozen — with ONE exception. An agent
      // that commits BEFORE writing its response (Cursor, sometimes Codex) emits
      // its `[Origin: Decision]` marker into the transcript AFTER the post-commit
      // hook already captured this record, so it froze with no decisions. Fill
      // (never overwrite) decisions when the frozen record has none and a later
      // write brings some. Nothing else about the record changes.
      if ((!existing.decisions || existing.decisions.length === 0) && entry.decisions && entry.decisions.length > 0) {
        existing.decisions = entry.decisions.slice(0, 6);
        writeMemoryPayload(repoPath, sessions, commits);
      }
      return;
    }
    commits.push(entry);
    // Keep only commits belonging to sessions still in memory (bounded window).
    const keep = new Set(sessions.map((s) => s.sessionId));
    // A commit whose session isn't recorded yet (write ordering) is kept too.
    const pruned = commits.filter((c) => keep.size === 0 || keep.has(c.sessionId) || c.sessionId === entry.sessionId);
    // A rebase records the rewritten commit as a new one. Replace the copy it
    // supersedes rather than growing the note by one record per rebase — see
    // dedupeRebasedCommits. Deliberately NOT a tombstone: those are permanent
    // and un-re-addable by design, which is far too strong a commitment to make
    // on a heuristic. Should a merge from another machine hand the superseded
    // record back, mergeMemoryPayloads folds it again.
    writeMemoryPayload(repoPath, sessions, dedupeRebasedCommits(pruned));
  } catch {
    // Non-fatal
  }
}

/**
 * Fill in decisions that arrived LATE — after the session rollup and commit
 * records were first written. Agents write the `[Origin: Decision]` marker in
 * the reply that follows the commit (Claude Code, Cursor, sometimes Codex), so
 * the commit-time capture usually finds none. A later hook fire re-parses the
 * transcript and calls this to backfill.
 *
 * Each commit gets the decisions of the turn that MADE it (`decisionsFor`),
 * never the session's whole set: a turn whose work was thrown away does not get
 * to explain a commit it had nothing to do with. The rollup, when empty, gets
 * the union of what its commits now carry.
 *
 * Fill-only: never overwrites decisions already recorded, so it can't clobber an
 * agy/LLM-derived set or re-run endlessly. No-op when there's nothing to add.
 */
export function enrichDecisionsForSession(
  repoPath: string,
  sessionId: string,
  decisionsFor: (commit: CommitMemoryEntry) => string[],
): boolean {
  try {
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return false;
    if (!sessionId) return false;
    const { sessions, commits } = loadMemoryPayloadForWrite(repoPath);
    let changed = false;
    const own: string[] = [];
    for (const c of commits) {
      if (c.sessionId !== sessionId) continue;
      if (!c.decisions || c.decisions.length === 0) {
        const clean = (decisionsFor(c) || []).filter((d) => typeof d === 'string' && d.trim());
        if (clean.length > 0) {
          c.decisions = clean.slice(0, 6);
          changed = true;
        }
      }
      for (const d of c.decisions || []) if (!own.includes(d)) own.push(d);
    }
    for (const s of sessions) {
      if (s.sessionId === sessionId && (!s.decisions || s.decisions.length === 0) && own.length > 0) {
        s.decisions = own.slice(0, 8);
        changed = true;
      }
    }
    if (changed) writeMemoryPayload(repoPath, sessions, commits);
    return changed;
  } catch {
    return false;
  }
}

// ─── Read Memory ───────────────────────────────────────────────────────────

export function readAllSessionMemory(repoPath: string): SessionMemoryEntry[] {
  return readMemoryPayload(repoPath).sessions;
}

// The immutable per-commit records, oldest→newest.
/**
 * Chronological order, oldest → newest.
 *
 * Insertion order is NOT time order and must not be used as a proxy for it:
 *   - writeSessionMemory UPSERTS by sessionId, so a long session that ends last
 *     keeps the slot it took when it FIRST wrote. "the last element" is then
 *     whichever session was created most recently, not the one that ended most
 *     recently.
 *   - writeCommitMemory appends, so a catch-up write — a commit an older build
 *     never recorded, picked up on a later poll — lands AFTER commits that are
 *     newer than it.
 *
 * Entries whose date will not parse keep their position relative to each other
 * instead of being flung to one end, and the sort is stable on ties, so equal
 * timestamps stay in the order they were recorded.
 */
export function sortByDateAsc<T>(list: T[], dateOf: (item: T) => string | undefined): T[] {
  return list
    .map((item, index) => ({ item, index, at: Date.parse(dateOf(item) || '') }))
    .sort((a, b) => {
      const bothParsed = Number.isFinite(a.at) && Number.isFinite(b.at);
      if (bothParsed && a.at !== b.at) return a.at - b.at;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/**
 * The identity a rebase copy shares with the commit it rewrote.
 *
 * `git rebase` replaces sha A with a new sha B carrying the same change, and
 * the post-commit hook records B as a brand-new commit — so a session that
 * rebases before merging remembers its own work twice. On this repo that is
 * every session on a busy main: of 209 records, 20 were rebase copies, and the
 * digest injected into every new session opened with a commit count 11% too
 * high and the same fix listed two or three times over.
 *
 * The key is sessionId + subject + changed-path set — deliberately NOT the line
 * counts, and deliberately not the sha. It mirrors `isRewriteOf`'s fallback in
 * hooks.ts, and for the same reason: a rebase here is rarely pure. Resolving
 * the version-file conflict re-bumps `packages/cli/package.json`, so the
 * rewritten commit is the same work carrying two or three extra lines
 * (`6ca2ef79` +408/-26 → `474d5310` +411/-29). Requiring the subject AND the
 * full path set to match is what keeps that from collapsing two genuinely
 * different commits — they would have to share a subject and touch exactly the
 * same files, within one session.
 *
 * Null — meaning "never fold this record" — when anything the key rests on is
 * missing. The empty-`filesChanged` case is the one that matters: merge commits
 * record no files, so without that guard seven distinct `Merge main` commits
 * (+215/-35, +601/-21, +574/-8 …) collapse into one on subject alone.
 */
export function rebasedCommitKey(c: CommitMemoryEntry | null | undefined): string | null {
  const subject = (c?.message || '').split('\n')[0].trim();
  const files = (c?.filesChanged || []).filter(Boolean).slice().sort().join(' ');
  if (!c?.sessionId || !subject || !files) return null;
  return `${c.sessionId} ${subject} ${files}`;
}

/**
 * Collapse rebase copies to the surviving commit. Pure — exported for testing.
 *
 * The survivor is the one committed LAST: the rewrite is created when the
 * rebase runs, after the commit it replaces. Both shas are usually orphaned by
 * the time anyone reads this (the PR squash-merges, so neither branch commit
 * reaches main), which is exactly why reachability can't pick the survivor and
 * the stored record data has to.
 *
 * Records keep their original positions — insertion order is not time order
 * here (see sortByDateAsc) and callers that care already sort for themselves,
 * so reordering as a side effect of deduping would be a second, unasked-for
 * change. `decisions` and `fileNotes` are carried forward fill-only, so a
 * decision captured against the pre-rebase sha isn't lost with it.
 */
export function dedupeRebasedCommits(commits: CommitMemoryEntry[]): CommitMemoryEntry[] {
  const list = commits || [];
  const at = (c: CommitMemoryEntry) => {
    const t = Date.parse(c?.committedAt || '');
    return Number.isFinite(t) ? t : -Infinity;
  };
  // Winner per key: latest committedAt, ties broken by the later position —
  // the same "recorded after" ordering the append gives us when timestamps are
  // equal or unparseable.
  const winner = new Map<string, number>();
  list.forEach((c, i) => {
    const key = rebasedCommitKey(c);
    if (!key) return;
    const held = winner.get(key);
    if (held === undefined || at(c) >= at(list[held])) winner.set(key, i);
  });

  return list.flatMap((c, i) => {
    const key = rebasedCommitKey(c);
    if (!key || winner.get(key) === i) {
      if (!key) return [c];
      const superseded = list.filter((o, j) => j !== i && rebasedCommitKey(o) === key);
      if (superseded.length === 0) return [c];
      const merged = { ...c };
      if (!merged.decisions?.length) {
        const from = superseded.reverse().find((o) => o.decisions?.length);
        if (from) merged.decisions = from.decisions!.slice(0, 6);
      }
      const notes = superseded.reduce<Record<string, string>>(
        (acc, o) => ({ ...o.fileNotes, ...acc }), { ...merged.fileNotes },
      );
      if (Object.keys(notes).length > 0) merged.fileNotes = notes;
      return [merged];
    }
    return [];
  });
}

/**
 * The subjects of every commit this repo's memory records for one session,
 * oldest first — what the session's summary is built from.
 *
 * A summary built from the LATEST commit alone falls through to the agent's
 * last message whenever that commit is noise: a session that merges main in
 * before merging its PR ends on "Merge remote-tracking branch…", which
 * summarizeFromCommitSubjects rightly drops, and the entry was left reading
 * "While that runs, I'm pushing the merge commit…" (22005642).
 */
export function sessionCommitSubjects(repoPath: string, sessionId: string): string[] {
  const own = readAllCommitMemory(repoPath).filter((c) => c.sessionId === sessionId);
  return sortByDateAsc(own, (c) => c.committedAt)
    .map((c) => (c.message || '').split('\n')[0].trim())
    .filter(Boolean);
}

/** This session's memory entry, if the note has one. */
export function readSessionMemoryEntry(repoPath: string, sessionId: string): SessionMemoryEntry | undefined {
  return readAllSessionMemory(repoPath).find((e) => e.sessionId === sessionId);
}

export function readAllCommitMemory(repoPath: string): CommitMemoryEntry[] {
  // Folded on READ as well as on write: notes already carrying rebase copies
  // are on every machine that has pulled them, and the write-side fix only
  // reaches records made from here on.
  return dedupeRebasedCommits(readMemoryPayload(repoPath).commits);
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
 * Truncate text for INJECTION without cutting mid-word, and say that you did.
 *
 * The old `.slice(0, n)` cuts landed wherever the byte budget ran out — a
 * digest ended "The branch is two commits a", which reads as a complete
 * thought that happens to be gibberish, and drops exactly the fact worth
 * carrying. Two problems, both fixed here: land the cut on a sentence (else a
 * word) boundary, and append an explicit marker so a truncated summary is
 * distinguishable from a complete one and the reader knows where the rest is.
 *
 * Pure + exported for testing.
 */
export function truncateAtBoundary(text: string, max: number, hint?: string): string {
  const s = (text || '').trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  // Prefer a sentence end, but only in the last 40% of the budget: backing off
  // further to land on a period throws away more than the ragged edge costs.
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '), head.lastIndexOf('.\n'),
    head.lastIndexOf('! '), head.lastIndexOf('? '),
  );
  let cut = sentenceEnd >= max * 0.6 ? sentenceEnd + 1 : -1;
  if (cut < 0) {
    const space = head.lastIndexOf(' ');
    cut = space > 0 ? space : max;
  }
  const marker = hint ? ` \u2026 (truncated \u2014 ${hint})` : ' \u2026 (truncated)';
  return s.slice(0, cut).replace(/[\s,;:\-\u2014]+$/, '') + marker;
}

// What to tell a reader who hit a truncation marker — the command that shows
// the untruncated record. Kept next to the helper so the two never drift.
export const MEMORY_FULL_RECORD_HINT = "run `origin context memory`";

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
  if (memoryReadBlocked(repoPath)) return null;

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
  // By endedAt, not by position — see sortByDateAsc. An upserted long-running
  // session sits wherever it first wrote, so the array tail is the newest
  // session to have STARTED, which is not the same thing.
  const last = sortByDateAsc(substantive, (e) => e.endedAt)[substantive.length - 1];
  const ago = formatAge(Date.now() - new Date(last.endedAt).getTime());
  parts.push(`- Most recent: [${ago} ago] ${truncateAtBoundary(last.summary, 160, MEMORY_FULL_RECORD_HINT)}`);
  // What the user actually ASKED for, above what the agent said it would do.
  // `summary` is frequently the agent's own first-person plan, which reads as
  // intent but isn't; without this line a resuming agent inherits the plan and
  // never learns the goal.
  const lastIntent = (last.intent || []).filter(Boolean);
  if (lastIntent.length) parts.push(`  Goal: ${truncateAtBoundary(lastIntent.slice(0, 2).join(' / '), 200, MEMORY_FULL_RECORD_HINT)}`);
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
  // Ids are printed so a session that deals with one of these can name it in
  // an [Origin: Closes] marker. Confirmed closures are dropped: re-injecting a
  // leftover that has already been discharged and landed is how the same ground
  // gets covered twice.
  const closedKeys = new Set(
    (readMemoryPayload(repoPath).closedTodos || [])
      .filter((c) => c.state === 'closed')
      .map((c) => c.key),
  );
  const todos: { id: string; text: string }[] = [];
  for (const e of substantive) {
    for (const t of e.openTodos || []) {
      if (closedKeys.has(todoClosureKey(t))) continue;
      if (todos.some((x) => x.text === t)) continue;
      todos.push({ id: todoDisplayId(t, e.sessionId), text: t });
    }
  }
  if (todos.length) {
    parts.push('Open TODOs from previous sessions (close one with `[Origin: Closes] <id>`):');
    for (const t of todos.slice(0, 5)) parts.push(`  - ${t.id}  ${t.text}`);
  }

  // How to run/confirm the recent work. Bounded to the most recent sessions and
  // reversed (newest first) because verify steps go stale fastest of anything
  // in this digest — an old repo's setup command is worse than none.
  const verify: string[] = [];
  for (const e of [...substantive].reverse()) for (const v of e.verify || []) if (!verify.includes(v)) verify.push(v);
  if (verify.length) {
    parts.push('How to verify (from previous sessions):');
    for (const v of verify.slice(0, 4)) parts.push(`  - ${v}`);
  }

  // The immutable per-commit log — the granular "what each commit did", distinct
  // from the evolving session rollup above. Most recent few, bounded.
  const commits = readAllCommitMemory(repoPath);
  if (commits.length) {
    parts.push('Recent commits (newest first):');
    for (const c of commits.slice(-5).reverse()) {
      const files = repoRelativeFiles(c.filesChanged).map((f) => path.basename(f)).slice(0, 4).join(', ');
      parts.push(`  - ${c.commitSha.slice(0, 7)} ${truncateAtBoundary(c.message, 80)}${files ? ` (${files})` : ''}`);
    }
  }

  return parts.join('\n');
}

// ─── Memory pointer (discoverability) ────────────────────────────────────────
//
// Everything above is a DIGEST: a capped session count, five decisions, five
// TODOs, basenamed and truncated file lists. The full store is much larger, and
// it lives somewhere no agent looks unprompted — a JSON note hanging off the
// repo's ROOT commit, on a ref that `git clone` does not fetch and that `git
// log` never surfaces. An agent asked "is there any memory from previous
// agents?" checks the things it knows about (log, CLAUDE.md/AGENTS.md, the
// worktree), finds nothing, and answers no — truthfully, as far as it can tell.
//
// Observed live on a fresh clone 2026-08-14: the agent reported it had no
// access to prior-session memory, then recovered the entire history one turn
// later once it was simply told the notes were there. The data had been sitting
// in .git the whole time; the only thing missing was the pointer.
//
// So say where it is and how to read all of it. Gated on there actually BEING
// something to point at — an empty repo must never send an agent chasing a ref
// that holds nothing, which would be a worse failure than saying nothing.
export function buildMemoryPointerContext(repoPath: string): string | null {
  // Same exclusions as the digest: bake-off arms and user-ignored repos get no
  // memory injected, so they must not be told memory exists either.
  if (memoryReadBlocked(repoPath)) return null;

  const substantive = readAllSessionMemory(repoPath).filter(isSubstantiveMemory);
  const commits = readAllCommitMemory(repoPath);
  if (substantive.length === 0 && commits.length === 0) return null;

  // Three routes on purpose, cheapest-to-reach first. The raw git command is
  // the one that always works: it needs no MCP server, no `origin` on PATH and
  // no network, and it is what the agent in the case above ended up running.
  //
  // The QUERY list below matters more than the dump list. Everything Origin
  // injects is a fixed slice chosen for the LAST task; the query commands let
  // an agent go and get what THIS task needs. Without them the agent only
  // learns three ways to re-read the same blob — so it never asks a question
  // the digest didn't already answer, and the strongest part of the product
  // (per-line provenance) stays invisible. Retrievable beats resident.
  return [
    `Repo memory (${substantive.length} session${substantive.length !== 1 ? 's' : ''}, ` +
      `${commits.length} commit record${commits.length !== 1 ? 's' : ''}) is stored in this repo's git notes — ` +
      'the summary above is only a capped digest of it.',
    'Query it for what THIS task needs, rather than assuming the digest is all there is:',
    '  - `origin why <file>:<line>` — the session + prompt that wrote a specific line',
    '  - `origin ask "<question>"` — find the session and prompts behind a file or change',
    '  - `origin prompts <file>` — every prompt that touched a file',
    '  - `origin todo list` — open TODOs carried across sessions',
    'To read the whole record instead — every session rollup, the decisions, the open TODOs, ' +
      'the per-file notes and the per-commit log — use any of:',
    '  - the `get_repo_memory` MCP tool, if Origin\'s MCP server is connected',
    '  - `origin context memory`',
    '  - `git notes --ref=origin-memory show $(git rev-list --max-parents=0 HEAD | tail -1)`',
  ].join('\n');
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
    git(['notes', `--ref=${MEMORY_BRIEF_REF_NAME}`, 'add', '-f', '-m', JSON.stringify(brief, null, 2), root],
      { cwd: repoPath, timeoutMs: 10_000, env: gitIdentityEnv(repoPath) });
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
 * Fold a fetched remote continuation brief into the local one. The brief is a
 * single regenerated blob (not an accumulation), so "merge" is just: keep
 * whichever was generated later. Returns true when local memory changed.
 */
export function foldRemoteMemoryBrief(repoPath: string, stagingRef: string): boolean {
  try {
    const root = briefRootCommit(repoPath);
    if (!root) return false;
    let remote: MemoryBrief | null = null;
    try {
      const raw = git(['notes', `--ref=${stagingRef}`, 'show', root], { cwd: repoPath, timeoutMs: 10_000 }).trim();
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.version === 1 && typeof data.brief === 'string') remote = data as MemoryBrief;
    } catch { return false; }
    if (!remote) return false;
    const local = readMemoryBrief(repoPath);
    if (local) {
      const lt = Date.parse(local.generatedAt || ''), rt = Date.parse(remote.generatedAt || '');
      // Tie or unparseable → keep local, so folding twice is a no-op.
      if (!(Number.isFinite(rt) && (!Number.isFinite(lt) || rt > lt))) return false;
    }
    writeMemoryBrief(repoPath, remote);
    return true;
  } catch {
    return false;
  }
}

/**
 * Brief counterpart to reconcileMemoryWithRemote — re-point the local brief
 * ref at the remote tip, then re-apply ours on top if ours is the newer one,
 * so the retry push fast-forwards. Returns true when the ref was repositioned.
 */
export function reconcileMemoryBriefWithRemote(repoPath: string, stagingRef: string): boolean {
  try {
    const root = briefRootCommit(repoPath);
    if (!root) return false;
    const opts = { cwd: repoPath, timeoutMs: 10_000 };
    let remote: MemoryBrief | null = null;
    try {
      const raw = git(['notes', `--ref=${stagingRef}`, 'show', root], opts).trim();
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.version === 1 && typeof data.brief === 'string') remote = data as MemoryBrief;
    } catch { return false; }
    if (!remote) return false;
    const local = readMemoryBrief(repoPath);
    const lt = Date.parse(local?.generatedAt || ''), rt = Date.parse(remote.generatedAt || '');
    const localWins = !!local && (!Number.isFinite(rt) || (Number.isFinite(lt) && lt > rt));
    git(['update-ref', `refs/notes/${MEMORY_BRIEF_REF_NAME}`, stagingRef], opts);
    // Remote already IS the ref now — only re-apply when ours is newer.
    if (localWins && local) writeMemoryBrief(repoPath, local);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inject the cached LLM continuation brief — cache-only, never generates here.
 * Returns null for bake-off/ignored repos or when there is no cached brief (the
 * caller then falls back to the deterministic buildMemoryContext).
 */
export function buildMemoryBriefContext(repoPath: string): string | null {
  if (memoryReadBlocked(repoPath)) return null;
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

// ─── Startup check: the imperative half of the memory pointer ────────────────
//
// buildMemoryPointerContext tells the agent memory EXISTS and how to query it.
// That is a capability description, and agents treat it as one — they reach for
// it when a prompt happens to mention prior work, and otherwise never. Observed
// verbatim from an Antigravity session asked why it hadn't looked: deeper
// commands "are not executed unless … an explicit workspace or global rule
// instructs the agent to run those startup checks automatically."
//
// So this block states the rule the model said was missing. Three properties
// matter and each is deliberate:
//
//   1. It names a FIRST ACTION with an ordering constraint ("before your first
//      substantive action"), not a capability. "You may query X" and "run X
//      before you start" produce very different compliance.
//   2. It offers the three routes in cheapest-reachable order, same as the
//      pointer — the raw git command needs no MCP server, no `origin` on PATH
//      and no network, and is what an agent actually falls back to.
//   3. It requires a one-line ACK. That is not politeness: the ack is the only
//      externally visible evidence the check happened, which is what lets
//      buildMemoryEscalationContext below notice silence and escalate. A
//      directive with no observable outcome cannot be enforced, only hoped for.
//
// Returns null under exactly the same exclusions as the pointer — a repo with
// no memory must not be told to go read memory.
export function buildStartupCheckContext(repoPath: string): string | null {
  if (memoryReadBlocked(repoPath)) return null;

  const substantive = readAllSessionMemory(repoPath).filter(isSubstantiveMemory);
  const commits = readAllCommitMemory(repoPath);
  if (substantive.length === 0 && commits.length === 0) return null;

  return [
    'Origin startup check — do this BEFORE your first substantive action in this session. ' +
      'Do not wait for a prompt to mention prior work: the digest above is a fixed slice chosen ' +
      'for the LAST task, not yours.',
    '',
    '  1. Read this repo\'s Origin memory, by any route that works here:',
    '     `origin context memory` · the `get_repo_memory` MCP tool · ' +
      '`git notes --ref=origin-memory show $(git rev-list --max-parents=0 HEAD | tail -1)`',
    '  2. Before editing a file the task names, check who wrote it and why: ' +
      '`origin why <file>:<line>` or `origin prompts <file>`.',
    '  3. State in ONE line what you found and whether it changes your plan — e.g. ' +
      '"Origin memory: 19 sessions; the notes-refspec work is unfinished and touches this file." ' +
      'If nothing in it bears on this task, say that instead.',
    '',
    'Step 3 is not optional. It is the only signal a human reviewer — and Origin — has that the ' +
      'check actually happened; a session that skips it is indistinguishable from one that ran blind.',
  ].join('\n');
}

// Second-turn escalation. Injected once, on the turn AFTER a session that was
// given the startup check above produced no evidence of running it (no memory
// read command, no MCP memory tool call, see isMemoryReadCommand).
//
// Deliberately shorter and blunter than the checklist rather than a re-send of
// it: the long form demonstrably did not land for this session, and repeating
// an instruction verbatim after it was ignored mostly buys a second copy of the
// same tokens. This one names the omission, which the first block cannot do
// because at that point there is nothing to name.
export function buildMemoryEscalationContext(repoPath: string): string | null {
  if (memoryReadBlocked(repoPath)) return null;

  const substantive = readAllSessionMemory(repoPath).filter(isSubstantiveMemory);
  const commits = readAllCommitMemory(repoPath);
  if (substantive.length === 0 && commits.length === 0) return null;

  return [
    `Origin: this repo carries ${substantive.length} session record${substantive.length !== 1 ? 's' : ''} ` +
      `and ${commits.length} commit record${commits.length !== 1 ? 's' : ''} in its git notes, and this ` +
      'session has not read any of it yet.',
    'Run `origin context memory` (or the `get_repo_memory` MCP tool) now, before continuing, and say in ' +
      'one line what it changes about your plan. Prior sessions in this repo have left work unfinished ' +
      'and decisions recorded that are not visible from the code alone.',
  ].join('\n');
}

// ─── Compliance detection ────────────────────────────────────────────────────
//
// Did this session actually go and read the memory? The only trustworthy
// evidence is a tool call we can see, so match the commands that read the
// record — every route the two blocks above offer, plus the query commands the
// pointer advertises, since an agent that ran `origin why` on the file it is
// about to edit has demonstrably consulted the record and does not need a nudge.
//
// Matching is intentionally loose on the surrounding shell (pipes, `&&`, a
// leading `cd … &&`, `pnpm origin …`) and strict on the verb. A false NEGATIVE
// costs one redundant nudge; a false POSITIVE silently disables the escalation
// for the whole session, which is the failure this exists to prevent — so
// prefer matching too little over too much.
const MEMORY_READ_PATTERNS: RegExp[] = [
  // `origin context memory`, `origin memory`, `origin recap`
  /\borigin\s+context\s+memory\b/,
  /\borigin\s+memory\b/,
  /\borigin\s+recap\b/,
  // Per-line / per-file provenance queries
  /\borigin\s+why\b/,
  /\borigin\s+ask\b/,
  /\borigin\s+prompts\b/,
  /\borigin\s+todo\s+list\b/,
  // The no-dependency fallback route: raw git notes against Origin's refs
  /\bgit\s+notes\b[^\n]*\borigin-(memory|sessions)\b/,
];

/** True when a shell command reads this repo's Origin memory. Pure. */
export function isMemoryReadCommand(cmd: string | undefined | null): boolean {
  if (typeof cmd !== 'string' || !cmd) return false;
  return MEMORY_READ_PATTERNS.some((re) => re.test(cmd));
}

/**
 * True when a TOOL NAME is Origin's memory MCP tool. Hosts namespace MCP tools
 * differently (`get_repo_memory`, `mcp__origin__get_repo_memory`,
 * `origin.get_repo_memory`), so match on the bare tool name anywhere in the
 * string rather than on one host's spelling of it.
 */
export function isMemoryReadToolName(toolName: string | undefined | null): boolean {
  if (typeof toolName !== 'string' || !toolName) return false;
  return /\bget_repo_memory\b/.test(toolName) || toolName.endsWith('get_repo_memory');
}

// ─── Prompt-scoped memory retrieval ──────────────────────────────────────────
//
// Everything Origin injects at session start is a FIXED slice chosen before the
// task was known: the last N sessions, the hottest files, the newest brief. It
// answers "what happened here recently", which is only accidentally the same
// question as "what does THIS task need to know".
//
// The startup directive asks the agent to close that gap itself by querying the
// record. That works when the agent complies, and the escalation exists because
// it often does not. This path removes compliance from the loop for the agents
// that fire a prompt hook: take the user's prompt, search the notes with it, and
// hand over the hits. An agent cannot fail to consult what is already in its
// context window.
//
// Deterministic and local on purpose — no LLM, no network. It runs on every
// prompt, in front of a user waiting for their agent to answer.

// Words that carry no retrieval signal. Prompts are imperative and
// conversational ("can you fix the thing where…"), so without this the top
// terms are all verbs and pronouns and every entry matches equally.
export const MEMORY_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'can', 'could', 'should', 'would', 'will', 'shall', 'may',
  'for', 'from', 'with', 'without', 'into', 'onto', 'about', 'over', 'under', 'out',
  'you', 'your', 'yours', 'we', 'our', 'ours', 'they', 'them', 'their', 'it', 'its',
  'me', 'my', 'mine', 'him', 'her', 'his', 'hers', 'who', 'what', 'when', 'where',
  'why', 'how', 'all', 'any', 'both', 'each', 'more', 'most', 'other', 'some', 'such',
  'not', 'only', 'same', 'than', 'too', 'very', 'just', 'now', 'also', 'let', 'lets',
  'please', 'thanks', 'thank', 'ok', 'okay', 'yes', 'no', 'sure', 'here', 'there',
  'run', 'make', 'made', 'get', 'got', 'use', 'used', 'using', 'add', 'added', 'new',
  'need', 'needs', 'want', 'like', 'look', 'see', 'try', 'go', 'going', 'done',
  'file', 'files', 'code', 'change', 'changes', 'changed', 'fix', 'fixed', 'work',
]);

/** A term the search actually uses, and how much a hit on it is worth. */
interface MemoryTerm { term: string; weight: number }

/**
 * Pull the retrievable terms out of a prompt.
 *
 * Three weights, because three very different kinds of evidence get flattened
 * into "the prompt mentioned it":
 *   - a PATH-like token (`src/memory.ts`, `hooks.ts`) is near-conclusive — if a
 *     past session touched the file this task names, that session is relevant
 *     almost regardless of what either of them said about it.
 *   - an IDENTIFIER (camelCase, snake_case, dotted) is strong: shared jargon
 *     between a prompt and a summary is rarely coincidence.
 *   - a plain word is weak on its own and only adds up in aggregate: at weight
 *     2 against a threshold of 8, four distinct non-stopword terms must
 *     co-occur in ONE record before it is retrieved.
 *
 * That last weight was 1 originally, which quietly made the whole feature
 * path-only: no prose prompt could reach 8 without eight separate matching
 * words, so anything phrased in English retrieved nothing. Measured over this
 * repo's own notes (19 sessions, 160 commits), weight 1 scored 0/6 on prompts
 * whose subject is demonstrably IN the corpus. Weight 2 scores 4/4 on the ones
 * actually present, with zero false fires across seven conversational prompts
 * ("ok thanks continue", "looks good ship it", …). Weight 3 raises recall by
 * one but matches 69 of 179 records on a single prompt — at which point the
 * threshold has stopped filtering and the top-3 cut is close to arbitrary.
 *
 * Exported for testing: the scoring above is the whole quality of this feature,
 * and it is far easier to get wrong than to notice going wrong.
 */
export function extractMemoryTerms(promptText: string): MemoryTerm[] {
  if (typeof promptText !== 'string' || !promptText.trim()) return [];
  const seen = new Map<string, number>();
  const add = (raw: string, weight: number) => {
    const term = raw.toLowerCase();
    if (!term) return;
    // Keep the STRONGEST weight a term earned: `hooks.ts` reaching us both as a
    // path and as a bare word must not be demoted by the second sighting.
    if ((seen.get(term) || 0) < weight) seen.set(term, weight);
  };

  // Path-like: contains a slash, or looks like <name>.<ext>.
  //
  // The bare-filename half requires an alphabetic stem AND an alphabetic
  // extension. Allowing digits on either side makes a version number a path:
  // `1.2` scored as high as `memory.ts` and matched every note that happened to
  // contain the string, which is the worst failure this search has — a
  // top-weighted hit on a coincidence.
  for (const m of promptText.matchAll(/[A-Za-z0-9_@.\-]*\/[A-Za-z0-9_/.\-]+|\b[A-Za-z][A-Za-z0-9_\-]*\.[A-Za-z]{1,6}\b/g)) {
    const raw = m[0].replace(/[.,;:)\]]+$/, '');
    if (raw.length < 3) continue;
    add(raw, 10);
    // Also index the basename, so a prompt naming `src/memory.ts` still matches
    // a note that recorded the file as `packages/cli/src/memory.ts`.
    //
    // Only a basename that names a FILE. Prose uses slashes too ("prompts/diffs/
    // token", "and/or"), and indexing `token` at path weight let one word of a
    // sentence outscore every real match — then double again on any record that
    // changed a file called `tokens.ts`.
    const base = raw.split('/').pop() || '';
    if (base && base !== raw && hasFileExtension(base)) add(base, 8);
  }

  // Identifier-like: camelCase, snake_case, or dotted — shared jargon.
  for (const m of promptText.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*|_[A-Za-z0-9]+)+\b/g)) {
    if (m[0].length >= 4) add(m[0], 4);
  }

  // Plain words.
  for (const m of promptText.matchAll(/\b[A-Za-z][A-Za-z0-9\-]{2,}\b/g)) {
    const w = m[0].toLowerCase();
    if (MEMORY_STOPWORDS.has(w)) continue;
    add(w, 2);
  }

  return [...seen.entries()].map(([term, weight]) => ({ term, weight }));
}

/** One retrieved record, with the reason it was retrieved. */
export interface MemoryHit {
  /** Stable identity, so the same record is not injected twice in one session. */
  key: string;
  kind: 'session' | 'commit';
  score: number;
  /** The terms that matched — shown to the agent so a bad hit is visibly bad. */
  matched: string[];
  /** Rendered lines for injection. */
  lines: string[];
}

/**
 * One line, always.
 *
 * A memory summary is often a full commit message — subject, blank line, body —
 * and dropping that into a `- [session …] …` list breaks the list: the body
 * renders as unindented prose that reads like the surrounding instructions
 * rather than like a retrieved record. Collapse first, truncate second, or the
 * budget is spent on whitespace.
 */
function oneLine(text: string | undefined | null, max: number): string {
  return truncateAtBoundary((text || '').replace(/\s+/g, ' ').trim(), max);
}

/** Everything about an entry a term could match, lowercased once. */
function searchableText(parts: Array<string | undefined | null | string[]>): string {
  const flat: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (Array.isArray(p)) flat.push(...p.filter((x) => typeof x === 'string'));
    else flat.push(p);
  }
  return flat.join('\n').toLowerCase();
}

function scoreEntry(text: string, files: string[], terms: MemoryTerm[]): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];
  const fileText = files.join('\n').toLowerCase();
  for (const { term, weight } of terms) {
    // A path term is checked against the FILE LIST as well as the prose, and
    // scores double when it lands there: "this session edited that exact file"
    // is a different class of evidence from "this session mentioned it".
    const inFiles = weight >= 8 && fileText.includes(term);
    if (inFiles) {
      score += weight * 2;
      matched.push(term);
      continue;
    }
    if (text.includes(term)) {
      score += weight;
      matched.push(term);
    }
  }
  return { score, matched };
}

// Below this, a "hit" is one or two incidental common words and injecting it
// teaches the agent that this block is noise. One path match (10, doubled to 20
// on a file-list hit) clears it alone; a pile of ordinary words does not.
//
// 10 rather than 8, because at 8 that last sentence was false: plain words are
// weight 2, so FOUR of them scored exactly the bar. "is checking origin memory
// on every prompt expensive or not?" matched `origin, memory, every, expensive`
// — 4 x 2 = 8 — and retrieved a record about the daily brief blocking on an
// LLM. A different performance problem, presented as though it were the answer.
//
// Two of those four are near-worthless here by construction: `origin` is the
// repo's own name and `memory` is what the feature is called, so both appear in
// a large share of records. A coincidence assembled from words like those is
// the worst failure this search has — not a miss, which costs nothing, but a
// confident-looking hit. Once the block reads as noise the agent skims past it,
// and the real retrievals go with it.
//
// Deliberately NOT an "only paths and identifiers count" rule: prose-only
// recall is a tested, intentional capability ("so a fresh clone fetches the
// notes refspec" — five distinctive words, no symbol, and it must still find
// the session about exactly that). Five such words score 10 and still clear;
// four common ones no longer do. The floor moved by one word, not by a class.
const MEMORY_HIT_MIN_SCORE = 10;

// A long prompt drowns the threshold above in ordinary words. A pasted
// 400-word brief about memory design carries ~150 plain terms, and at weight 2
// any record matching five of them clears the bar. Measured on this repo's own
// notes: the top five hits for such a prompt were a heartbeat fix, a cost fix,
// a Codex capture fix and two supersession fixes, each on 28-32 matches like
// `thing, one, after, before, read, still`. None was about memory.
//
// Short prompts score exactly as before: that path is tuned (4/4 recall, no
// false fires on conversational turns) and a five-word question has no length
// to correct for. Past MEMORY_PLAIN_TERMS_FULL_WEIGHT plain words, two
// corrections apply, to plain words only. A path or identifier match is
// evidence at any prompt length and stays at full weight.
//
//   1. Words most records share are no evidence. A plain word found in more
//      than a quarter of the records is dropped: in a repo about sessions,
//      `session` and `prompt` rank every record the same. It needs a corpus to
//      measure, so it applies only from MEMORY_COMMON_WORD_MIN_RECORDS up.
//   2. Each plain word is worth less the more of them there are. The weight is
//      scaled by FULL_WEIGHT / count, so what a record needs is the same SHARE
//      of the prompt's words a short prompt needs, not the same number.
//
// Not applied to short prompts on purpose: the common-word filter drops `row`,
// `hook` and `commit`, which "a heartbeat tick replacing a hook capture's row"
// needs to reach its record.
const MEMORY_COMMON_WORD_SHARE = 0.25;
const MEMORY_COMMON_WORD_MIN_RECORDS = 10;
const MEMORY_PLAIN_TERMS_FULL_WEIGHT = 12;

/**
 * The terms a search actually scores with, once plain words are corrected for
 * how common they are in `texts` and how many of them the prompt carries.
 * Pure + exported for testing.
 */
export function effectiveMemoryTerms(terms: MemoryTerm[], texts: string[]): MemoryTerm[] {
  const isPlain = (t: MemoryTerm) => t.weight < 4;
  let plain = terms.filter(isPlain);
  if (plain.length <= MEMORY_PLAIN_TERMS_FULL_WEIGHT) return terms;
  const strong = terms.filter((t) => !isPlain(t));
  if (texts.length >= MEMORY_COMMON_WORD_MIN_RECORDS) {
    const cap = texts.length * MEMORY_COMMON_WORD_SHARE;
    plain = plain.filter(({ term }) => {
      let n = 0;
      for (const text of texts) {
        if (text.includes(term) && ++n > cap) return false;
      }
      return true;
    });
  }
  const scale = Math.min(1, MEMORY_PLAIN_TERMS_FULL_WEIGHT / Math.max(1, plain.length));
  return [...strong, ...plain.map((t) => ({ term: t.term, weight: t.weight * scale }))];
}


/**
 * Search this repo's memory for records relevant to `promptText`.
 *
 * Ranked, thresholded, and capped. Returns [] rather than a weak best-effort
 * list when nothing clears the bar — an empty result is a correct answer here,
 * and padding it with the newest records would just re-inject the digest the
 * agent already has.
 */
export function searchMemoryForPrompt(repoPath: string, promptText: string, limit = 3): MemoryHit[] {
  if (memoryReadBlocked(repoPath)) return [];
  const terms = extractMemoryTerms(promptText);
  if (terms.length === 0) return [];
  // Bail before touching git when no entry COULD clear the threshold.
  //
  // This runs on the user's keystroke path, once per prompt, and the reads
  // below shell out to `git notes show`. Without this, "ok thanks, continue"
  // paid the full cost — read the entire payload, score every record — to
  // return the empty list its one weight-1 term made inevitable. Conversational
  // turns are a large share of all prompts, so this is the common case, not an
  // edge one.
  //
  // Sound rather than heuristic: an entry's score is the sum of the weights it
  // matches, so the best any entry can do is match everything. Path terms count
  // double because scoreEntry doubles them on a file-list hit — overstating the
  // ceiling is what keeps this from ever discarding a prompt that had a chance.
  const ceiling = terms.reduce((n, t) => n + (t.weight >= 8 ? t.weight * 2 : t.weight), 0);
  if (ceiling < MEMORY_HIT_MIN_SCORE) return [];

  // ONE payload read, not two. readAllSessionMemory and readAllCommitMemory are
  // each a thin wrapper over readMemoryPayload, which is uncached — so calling
  // both made every prompt pay for the same `git notes show` twice.
  const payload = readMemoryPayload(repoPath);
  const sessions = payload.sessions.filter(isSubstantiveMemory).map((s) => ({
    s,
    files: s.filesChanged || [],
    text: searchableText([
      s.summary, s.intent, s.decisions, s.openTodos, s.verify, s.filesChanged || [],
      s.fileNotes ? Object.keys(s.fileNotes) : [], s.fileNotes ? Object.values(s.fileNotes) : [],
    ]),
  }));
  const commits = payload.commits.map((c) => ({
    c,
    files: c.filesChanged || [],
    text: searchableText([
      c.message, c.decisions, c.filesChanged || [],
      c.fileNotes ? Object.keys(c.fileNotes) : [], c.fileNotes ? Object.values(c.fileNotes) : [],
    ]),
  }));
  const scored = effectiveMemoryTerms(terms, [...sessions.map((r) => r.text), ...commits.map((r) => r.text)]);
  const hits: MemoryHit[] = [];

  for (const { s, files, text } of sessions) {
    const { score, matched } = scoreEntry(text, files, scored);
    if (score < MEMORY_HIT_MIN_SCORE) continue;
    const lines: string[] = [];
    const when = (s.endedAt || s.startedAt || '').slice(0, 10);
    lines.push(`- [session ${s.sessionId.slice(0, 8)}${when ? `, ${when}` : ''}] ${oneLine(s.summary || '(no summary)', 220)}`);
    if (s.intent?.length) lines.push(`  Asked for: ${oneLine(s.intent[0], 160)}`);
    if (s.decisions?.length) lines.push(`  Decision: ${oneLine(s.decisions[0], 160)}`);
    if (s.openTodos?.length) lines.push(`  Still open: ${oneLine(s.openTodos[0], 160)}`);
    if (files.length) lines.push(`  Files: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` (+${files.length - 6})` : ''}`);
    hits.push({ key: `s:${s.sessionId}`, kind: 'session', score, matched, lines });
  }

  for (const { c, files, text } of commits) {
    const { score, matched } = scoreEntry(text, files, scored);
    if (score < MEMORY_HIT_MIN_SCORE) continue;
    const lines: string[] = [];
    lines.push(`- [commit ${c.commitSha.slice(0, 8)}${c.committedAt ? `, ${c.committedAt.slice(0, 10)}` : ''}] ${oneLine(c.message || '', 180)}`);
    if (c.decisions?.length) lines.push(`  Decision: ${oneLine(c.decisions[0], 160)}`);
    if (files.length) lines.push(`  Files: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` (+${files.length - 6})` : ''}`);
    hits.push({ key: `c:${c.commitSha}`, kind: 'commit', score, matched, lines });
  }

  // Sessions before commits at equal score: a session rollup carries intent,
  // decisions and open TODOs, where a commit record carries a subject line.
  hits.sort((a, b) => (b.score - a.score) || (a.kind === b.kind ? 0 : a.kind === 'session' ? -1 : 1));
  return hits.slice(0, limit);
}

/**
 * Render the prompt-scoped hits for injection, skipping any already delivered to
 * this session.
 *
 * `alreadySeen` is what keeps a multi-turn conversation about one file from
 * re-injecting the same three records every prompt — which costs real context
 * and, worse, trains the agent to skim past this block.
 */
export function buildPromptScopedMemoryContext(
  repoPath: string,
  promptText: string,
  alreadySeen: string[] = [],
): { block: string; keys: string[] } | null {
  const seen = new Set(alreadySeen);
  const hits = searchMemoryForPrompt(repoPath, promptText).filter((h) => !seen.has(h.key));
  if (hits.length === 0) return null;

  const body = hits.map((h) => h.lines.join('\n')).join('\n');
  // Strongest evidence first: a reader scanning "(matched: …)" should see the
  // path that earned the hit, not the three common words that came along with
  // it. Unordered, this line made a good retrieval look like a coincidence.
  const weights = new Map(extractMemoryTerms(promptText).map((t) => [t.term, t.weight]));
  const terms = [...new Set(hits.flatMap((h) => h.matched))]
    .sort((a, b) => (weights.get(b) || 0) - (weights.get(a) || 0))
    .slice(0, 4);
  return {
    block: [
      `Origin memory — records matching THIS request${terms.length ? ` (matched: ${terms.join(', ')})` : ''}:`,
      body,
      'This is retrieved from the repo\'s git notes, not a guess. Treat an open TODO or a recorded ' +
        'decision above as binding prior context: if you are about to contradict one, say so and why.',
    ].join('\n'),
    keys: hits.map((h) => h.key),
  };
}

// ─── Records about one file ──────────────────────────────────────────────────

/**
 * The memory records that changed `relPath`, newest first — the session and
 * commit entries whose file list names it — plus every session, for TODOs.
 * One payload read. Used by the
 * per-file card, which wants the latest note, decision and open TODO for the
 * file an agent is about to touch, not the repo's.
 */
export function readMemoryRecordsForFile(
  repoPath: string,
  relPath: string,
): { sessions: SessionMemoryEntry[]; commits: CommitMemoryEntry[]; allSessions: SessionMemoryEntry[] } {
  if (memoryReadBlocked(repoPath)) return { sessions: [], commits: [], allSessions: [] };
  const payload = readMemoryPayload(repoPath);
  const touches = (files: string[] | undefined) => (files || []).includes(relPath);
  const when = (s: string | undefined | null) => Date.parse(s || '') || 0;
  return {
    sessions: payload.sessions
      .filter((s) => touches(s.filesChanged))
      .sort((a, b) => when(b.endedAt || b.startedAt) - when(a.endedAt || a.startedAt)),
    commits: payload.commits
      .filter((c) => touches(c.filesChanged))
      .sort((a, b) => when(b.committedAt) - when(a.committedAt)),
    // Every session, for open TODOs that name the file without having changed it.
    allSessions: payload.sessions,
  };
}
