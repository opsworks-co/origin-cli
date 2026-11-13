// A person committing work a session left uncommitted after it ENDED.
//
// Prod 9be790796 (#2175): session 771d17ae rewrote a line in DOCS.md, ended at
// 17:06 with it uncommitted, and its user committed it by hand at 17:25. Every
// commit-time rule looks only at sessions that have not ended, so the commit
// went out with no trailer and the server had to rediscover the link from
// content on every read.
//
// This is the write-side half: prepare-commit-msg asks, when no live session
// owns the commit, whether a session that ended in this tree recently recorded
// the lines being committed — and stamps that session's trailer if exactly one
// did. Evidence is content, never recency or file names: an ended session is
// exactly the zombie the liveness filter exists to keep away from commits, so
// only its own recorded lines in the staged patch may bring it back.
//
// The trailer only. post-commit never records work on an ended session; the
// server reads the trailer (and GitHub keeps it in a squash body).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { samePath } from './paths.js';
import type { SessionState } from './session-state.js';

/** The server's earlier-session lookback (findEarlierSessionWork). */
export const ENDED_SESSION_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

// Same rules as the server's absorb-content.ts, so the trailer written here
// and the content check the server runs on read agree on what counts.
const BARE_CODE_FENCE = /^(?:```|~~~)[A-Za-z0-9_+#-]*$/;
const MIN_FRAGMENT_WORD_CHARS = 16;

function isDistinctiveLine(c: string): boolean {
  if (BARE_CODE_FENCE.test(c.trim())) return false;
  return c.replace(/[^A-Za-z0-9_]/g, '').length >= 4;
}

// The lines a patch adds (or removes), per file. A recorded line only counts
// against the same file: OR-23 v1 (3265d18a3) was stamped with another
// repository's session on generic test and import lines from other files.
const WORKTREE_PREFIX = /^\.claude\/worktrees\/[^/]+\//;

function collect(patch: string, marker: '+' | '-', headerless: string | null = null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // Lines before any file header belong to `headerless`, when the caller knows it.
  let file: string | null = headerless;
  let inHunk = false;
  for (const ln of (patch || '').split('\n')) {
    if (ln.startsWith('@@')) { inHunk = true; continue; }
    // Inside a hunk `--- x` is a removed `-- x`, unless it names a file.
    const header = /^(?:\+\+\+|---) /.test(ln) && (!inHunk || /^(?:\+\+\+|---) (?:[ab]\/|\/dev\/null)/.test(ln));
    if (header) {
      inHunk = false;
      // The file is the post-image path; a deletion names it on the `---` side.
      const p = ln.slice(4).trim();
      if (p !== '/dev/null' && (ln.startsWith('+++ ') || file === null)) {
        file = p.replace(/^[ab]\//, '').replace(WORKTREE_PREFIX, '');
      }
      continue;
    }
    if (ln.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    if (!ln.startsWith(marker) || file === null) continue;
    const c = ln.slice(1).trim();
    if (!isDistinctiveLine(c)) continue;
    let set = out.get(file);
    if (!set) out.set(file, set = new Set());
    set.add(c);
  }
  return out;
}

/** True if `lines` holds `l`, whole or as a long-enough part of one line. */
function holdsLine(lines: Set<string>, l: string): boolean {
  if (lines.has(l)) return true;
  if (l.replace(/[^A-Za-z0-9_]/g, '').length < MIN_FRAGMENT_WORD_CHARS) return false;
  for (const x of lines) if (x.length > l.length && x.includes(l)) return true;
  return false;
}

/** Sessions that ENDED in this tree within the lookback, from the durable mirror. */
export function recentlyEndedSessionsForTree(
  tree: string,
  opts: { now?: number; mirrorDir?: string } = {},
): SessionState[] {
  if (!tree) return [];
  return endedSessionsWhere((st) => [
    st.repoPath, (st as any).lastCwd, (st as any).canonicalRepoPath,
    ...((st.discoveredWorkTrees || []).map((w) => w?.path)),
  ].some((c) => typeof c === 'string' && c.length > 0 && samePath(c, tree)), opts);
}

/** Sessions homed in another repository that ENDED after reaching this tree (foreign-trees.ts). */
export function recentlyEndedSessionsReachingTree(
  tree: string,
  opts: { now?: number; mirrorDir?: string } = {},
): SessionState[] {
  if (!tree) return [];
  return endedSessionsWhere((st) => (st.foreignTrees || []).some((e) => samePath(e.path, tree)), opts);
}

function endedSessionsWhere(
  accept: (st: SessionState) => boolean,
  opts: { now?: number; mirrorDir?: string },
): SessionState[] {
  const now = opts.now ?? Date.now();
  const dir = opts.mirrorDir ?? path.join(os.homedir(), '.origin', 'sessions');
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out: SessionState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    // The mirror is rewritten when a session ends, so an old mtime means an old
    // session: skip it before parsing what can be a large file.
    try { if (now - fs.statSync(file).mtimeMs > ENDED_SESSION_LOOKBACK_MS) continue; } catch { continue; }
    let st: SessionState | null = null;
    try { st = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { continue; }
    if (!st?.sessionId) continue;
    const endedAt = st.endedAt ? Date.parse(st.endedAt) : NaN;
    if (!((st as any).status === 'ENDED' || st.endedAt) || !Number.isFinite(endedAt)) continue;
    if (now - endedAt > ENDED_SESSION_LOOKBACK_MS || endedAt > now) continue;
    if (accept(st)) out.push(st);
  }
  return out;
}

export interface EndedSessionOwner {
  state: SessionState;
  /** Local turn indexes whose recorded lines are in the staged patch. */
  promptIndexes: number[];
  /** Distinct recorded lines found in the staged patch. */
  matchedLines: number;
}

/**
 * The ended session whose recorded lines the staged patch adds — or null when
 * none did, or two did equally (a coin flip is not evidence).
 *
 * A line counts when the patch adds it (or a line containing it) IN THE SAME
 * FILE the session recorded it in, and does not also remove it there: a line
 * on both sides existed before, so matching it is observation, not authorship.
 * The session must hold more than half of the patch's added lines.
 */
export function pickEndedSessionByContent(
  candidates: SessionState[],
  stagedPatch: string,
): EndedSessionOwner | null {
  const added = collect(stagedPatch, '+');
  const removed = collect(stagedPatch, '-');
  let total = 0;
  for (const lines of added.values()) total += lines.size;
  if (total === 0) return null;
  const none = new Set<string>();
  const scored: EndedSessionOwner[] = [];
  for (const state of candidates) {
    const lines = new Set<string>();
    const promptIndexes: number[] = [];
    for (const pm of state.completedPromptMappings || []) {
      if (!Number.isInteger(pm?.promptIndex)) continue;
      let hit = false;
      // A diff recorded without file headers can only be placed by a turn that
      // changed one file.
      const files = (pm.filesChanged || []).filter((f) => typeof f === 'string' && f.length > 0);
      const lone = files.length === 1 ? files[0].replace(WORKTREE_PREFIX, '') : null;
      for (const [file, recorded] of collect(`${pm.uncommittedDiff || ''}\n${pm.diff || ''}`, '+', lone)) {
        const staged = added.get(file);
        if (!staged) continue;
        for (const l of recorded) {
          if (holdsLine(staged, l) && !holdsLine(removed.get(file) || none, l)) { lines.add(`${file}\0${l}`); hit = true; }
        }
      }
      if (hit) promptIndexes.push(pm.promptIndex);
    }
    // The trailer names ONE session for the whole commit, so that session must
    // hold most of it. OR-23 v1: 8 lines of 116 were enough to stamp it.
    if (lines.size * 2 > total) scored.push({ state, promptIndexes: [...new Set(promptIndexes)].sort((a, b) => a - b), matchedLines: lines.size });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.matchedLines - a.matchedLines);
  if (scored.length > 1 && scored[0].matchedLines === scored[1].matchedLines) return null;
  return scored[0];
}
