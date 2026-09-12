import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { git, gitOrNull, gitIdentityEnv } from './utils/exec.js';
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

function readMemoryPayload(repoPath: string): MemoryPayload {
  try {
    const root = memoryRootCommit(repoPath);
    if (!root) return { version: 2, sessions: [], commits: [], tombstones: [], closedTodos: [] };
    const raw = git(['notes', '--ref=origin-memory', 'show', root], { cwd: repoPath, timeoutMs: 10_000 }).trim();
    const data = JSON.parse(raw);
    return {
      version: typeof data.version === 'number' ? data.version : 1,
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      commits: Array.isArray(data.commits) ? data.commits : [], // absent in v1 payloads
      tombstones: Array.isArray(data.tombstones) ? data.tombstones : [],
      closedTodos: Array.isArray(data.closedTodos) ? data.closedTodos : [],
    };
  } catch {
    return { version: 2, sessions: [], commits: [], tombstones: [], closedTodos: [] };
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
  // Same contract as `tombstones`: omitting it PRESERVES what is recorded.
  closedTodos?: TodoClosure[],
): void {
  const root = memoryRootCommit(repoPath);
  if (!root) return;
  const existing = (tombstones === undefined || closedTodos === undefined)
    ? readMemoryPayload(repoPath)
    : null;
  const keptTombstones = tombstones ?? existing?.tombstones ?? [];
  const suppressed = new Set(keptTombstones.map((t) => t.commitSha));
  const visibleCommits = commits.filter((c) => !suppressed.has(c.commitSha));
  // A closure exists to suppress a TODO. Once the session that recorded that
  // TODO has aged out of the retained window the TODO is gone on its own, and
  // the closure is dead weight in a payload that has to stay push-sized — the
  // same rule that prunes commit records whose session dropped out.
  //
  // Only prune what is UNREACHABLE, never what is merely closed: dropping a
  // closure whose TODO is still in the window resurrects the TODO.
  const liveTodoKeys = new Set<string>();
  for (const e of sessions) for (const t of e.openTodos || []) liveTodoKeys.add(todoClosureKey(t));
  const keptClosures = (closedTodos ?? existing?.closedTodos ?? []).filter((c) => liveTodoKeys.has(c.key));
  const payload = JSON.stringify(
    { version: 2, sessions, commits: visibleCommits, tombstones: keptTombstones, closedTodos: keptClosures },
    null,
    2,
  );
  git(['notes', '--ref=origin-memory', 'add', '-f', '-m', payload, root],
    { cwd: repoPath, timeoutMs: 10_000, env: gitIdentityEnv(repoPath) });
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
  // The union is what makes this necessary: a machine that folded a rebase copy
  // away gets it handed straight back by one that hasn't, so the fold has to
  // happen again on the merged result or it never sticks.
  const mergedCommits = dedupeRebasedCommits(
    [...commits.values()]
      .filter((c) => keep.size === 0 || keep.has(c.sessionId))
      .sort((a, b) => {
        const ta = Date.parse(a?.committedAt || ''), tb = Date.parse(b?.committedAt || '');
        return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
      }),
  );

  const liveTodoKeys = new Set<string>();
  for (const e of mergedSessions) for (const t of e.openTodos || []) liveTodoKeys.add(todoClosureKey(t));
  return {
    version: 2,
    sessions: mergedSessions,
    commits: mergedCommits,
    tombstones: [...tombstones.values()],
    closedTodos: [...closedTodos.values()].filter((c) => liveTodoKeys.has(c.key)),
  };
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
      closedTodos: Array.isArray(data.closedTodos) ? data.closedTodos : [],
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
    // Compare — and write — ALL FOUR records. Sessions and commits alone left
    // the other two unable to arrive: `writeMemoryPayload` preserves what it is
    // not given, so passing only two of the four re-wrote the LOCAL tombstones
    // and closures over the merged ones, discarding everything the remote had
    // just contributed. Narrowing the comparison the same way also made a sync
    // whose only news was a retraction or a closure report "nothing changed"
    // and write nothing at all.
    const shape = (p: MemoryPayload) => JSON.stringify({
      s: p.sessions, c: p.commits, t: p.tombstones || [], d: p.closedTodos || [],
    });
    if (shape(local) === shape(merged)) return false;
    writeMemoryPayload(repoPath, merged.sessions, merged.commits, merged.tombstones, merged.closedTodos);
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
    // All four records, for the reason spelled out in foldRemoteMemory: the ref
    // now points at the REMOTE tip, so anything not written here is whatever
    // the remote had, and the local side's retractions and closures are gone.
    writeMemoryPayload(repoPath, merged.sessions, merged.commits, merged.tombstones, merged.closedTodos);
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
    const { sessions, commits, tombstones, closedTodos } = readMemoryPayload(repoPath);
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
  if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return null;

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
  if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return null;

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
const MEMORY_STOPWORDS = new Set([
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
    const base = raw.split('/').pop() || '';
    if (base && base !== raw) add(base, 8);
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


/**
 * Search this repo's memory for records relevant to `promptText`.
 *
 * Ranked, thresholded, and capped. Returns [] rather than a weak best-effort
 * list when nothing clears the bar — an empty result is a correct answer here,
 * and padding it with the newest records would just re-inject the digest the
 * agent already has.
 */
export function searchMemoryForPrompt(repoPath: string, promptText: string, limit = 3): MemoryHit[] {
  if (isBakeoffRepo(repoPath) || isRepoIgnored(repoPath)) return [];
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
  const hits: MemoryHit[] = [];

  for (const s of payload.sessions.filter(isSubstantiveMemory)) {
    const files = s.filesChanged || [];
    const text = searchableText([
      s.summary, s.intent, s.decisions, s.openTodos, s.verify, files,
      s.fileNotes ? Object.keys(s.fileNotes) : [], s.fileNotes ? Object.values(s.fileNotes) : [],
    ]);
    const { score, matched } = scoreEntry(text, files, terms);
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

  for (const c of payload.commits) {
    const files = c.filesChanged || [];
    const text = searchableText([
      c.message, c.decisions, files,
      c.fileNotes ? Object.keys(c.fileNotes) : [], c.fileNotes ? Object.values(c.fileNotes) : [],
    ]);
    const { score, matched } = scoreEntry(text, files, terms);
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
