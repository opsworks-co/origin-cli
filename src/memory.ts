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

function readMemoryPayload(repoPath: string): MemoryPayload {
  try {
    const root = memoryRootCommit(repoPath);
    if (!root) return { version: 2, sessions: [], commits: [], tombstones: [] };
    const raw = git(['notes', '--ref=origin-memory', 'show', root], { cwd: repoPath, timeoutMs: 10_000 }).trim();
    const data = JSON.parse(raw);
    return {
      version: typeof data.version === 'number' ? data.version : 1,
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      commits: Array.isArray(data.commits) ? data.commits : [], // absent in v1 payloads
      tombstones: Array.isArray(data.tombstones) ? data.tombstones : [],
    };
  } catch {
    return { version: 2, sessions: [], commits: [], tombstones: [] };
  }
}

function writeMemoryPayload(
  repoPath: string,
  sessions: SessionMemoryEntry[],
  commits: CommitMemoryEntry[],
  // Optional so the many existing callers stay unchanged: omitting it PRESERVES
  // whatever tombstones are already recorded. Dropping them on an ordinary write
  // would quietly resurrect everything they suppress.
  tombstones?: CommitTombstone[],
): void {
  const root = memoryRootCommit(repoPath);
  if (!root) return;
  const keptTombstones = tombstones ?? readMemoryPayload(repoPath).tombstones ?? [];
  const suppressed = new Set(keptTombstones.map((t) => t.commitSha));
  const visibleCommits = commits.filter((c) => !suppressed.has(c.commitSha));
  const payload = JSON.stringify(
    { version: 2, sessions, commits: visibleCommits, tombstones: keptTombstones },
    null,
    2,
  );
  git(['notes', '--ref=origin-memory', 'add', '-f', '-m', payload, root], { cwd: repoPath, timeoutMs: 10_000 });
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
 * Result is sorted oldest→newest and trimmed to the same window the writers
 * enforce, with orphaned commit records pruned exactly as writeSessionMemory
 * does — so a merged payload is indistinguishable from a locally-grown one.
 */
export function mergeMemoryPayloads(local: MemoryPayload, remote: MemoryPayload): MemoryPayload {
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

  const commits = new Map<string, CommitMemoryEntry>();
  for (const c of local?.commits || []) if (c?.commitSha) commits.set(c.commitSha, c);
  for (const c of remote?.commits || []) {
    if (c?.commitSha && !commits.has(c.commitSha)) commits.set(c.commitSha, c);
  }
  for (const sha of tombstones.keys()) commits.delete(sha);

  const mergedSessions = [...sessions.values()]
    .sort((a, b) => entryTime(a) - entryTime(b))
    .slice(-MAX_ENTRIES);

  // Same bounded-window rule the writers apply: drop commit records whose
  // session fell out of the retained window.
  const keep = new Set(mergedSessions.map((s) => s.sessionId));
  const mergedCommits = [...commits.values()]
    .filter((c) => keep.size === 0 || keep.has(c.sessionId))
    .sort((a, b) => {
      const ta = Date.parse(a?.committedAt || ''), tb = Date.parse(b?.committedAt || '');
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    });

  return { version: 2, sessions: mergedSessions, commits: mergedCommits, tombstones: [...tombstones.values()] };
}

/** Read the memory payload out of an arbitrary notes ref, or null if absent. */
export function readMemoryPayloadFromRef(repoPath: string, ref: string): MemoryPayload | null {
  try {
    const root = memoryRootCommit(repoPath);
    if (!root) return null;
    const raw = git(['notes', `--ref=${ref}`, 'show', root], { cwd: repoPath, timeoutMs: 10_000 }).trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      version: typeof data.version === 'number' ? data.version : 1,
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      commits: Array.isArray(data.commits) ? data.commits : [],
      tombstones: Array.isArray(data.tombstones) ? data.tombstones : [],
    };
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
    const local = readMemoryPayload(repoPath);
    const merged = mergeMemoryPayloads(local, remote);
    const before = JSON.stringify({ s: local.sessions, c: local.commits });
    const after = JSON.stringify({ s: merged.sessions, c: merged.commits });
    if (before === after) return false;
    writeMemoryPayload(repoPath, merged.sessions, merged.commits);
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
    const merged = mergeMemoryPayloads(readMemoryPayload(repoPath), remote);
    const opts = { cwd: repoPath, timeoutMs: 10_000 };
    git(['update-ref', MEMORY_REF, stagingRef], opts);
    writeMemoryPayload(repoPath, merged.sessions, merged.commits);
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
    const merged = reconcileSessionWindow(entry, idx >= 0 ? sessions[idx] : undefined, commits);
    if (idx >= 0) sessions[idx] = merged;
    else sessions.push(merged);
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
    const { sessions, commits, tombstones } = readMemoryPayload(repoPath);
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

export function writeCommitMemory(repoPath: string, entry: CommitMemoryEntry): void {
  try {
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return;
    if (!entry.commitSha) return;
    const { sessions, commits, tombstones } = readMemoryPayload(repoPath);
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
    writeMemoryPayload(repoPath, sessions, pruned);
  } catch {
    // Non-fatal
  }
}

/**
 * Fill in decisions that arrived LATE — after the session rollup and commit
 * records were first written. The trigger is agents that commit before writing
 * their response (Cursor, sometimes Codex): the `[Origin: Decision]` marker only
 * lands in the transcript once the turn's response is flushed, moments after the
 * commit-time capture already ran. A later hook fire re-parses the transcript and
 * calls this to backfill the session's rollup and its commit records.
 *
 * Fill-only: never overwrites decisions already recorded, so it can't clobber an
 * agy/LLM-derived set or re-run endlessly. No-op when there's nothing to add.
 */
export function enrichDecisionsForSession(repoPath: string, sessionId: string, decisions: string[]): boolean {
  try {
    if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return false;
    const clean = (decisions || []).filter((d) => typeof d === 'string' && d.trim());
    if (!sessionId || clean.length === 0) return false;
    const { sessions, commits } = readMemoryPayload(repoPath);
    let changed = false;
    for (const s of sessions) {
      if (s.sessionId === sessionId && (!s.decisions || s.decisions.length === 0)) {
        s.decisions = clean.slice(0, 8);
        changed = true;
      }
    }
    for (const c of commits) {
      if (c.sessionId === sessionId && (!c.decisions || c.decisions.length === 0)) {
        c.decisions = clean.slice(0, 6);
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
  const todos: string[] = [];
  for (const e of substantive) for (const t of e.openTodos || []) if (!todos.includes(t)) todos.push(t);
  if (todos.length) {
    parts.push('Open TODOs from previous sessions:');
    for (const t of todos.slice(0, 5)) parts.push(`  - ${t}`);
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
  if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return null;

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
