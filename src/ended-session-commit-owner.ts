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

function collect(patch: string, marker: '+' | '-'): Set<string> {
  const head = marker === '+' ? '+++' : '---';
  const out = new Set<string>();
  for (const ln of (patch || '').split('\n')) {
    if (!ln.startsWith(marker) || ln.startsWith(head)) continue;
    const c = ln.slice(1).trim();
    if (isDistinctiveLine(c)) out.add(c);
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
    const claims = [
      st.repoPath, (st as any).lastCwd, (st as any).canonicalRepoPath,
      ...((st.discoveredWorkTrees || []).map((w) => w?.path)),
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (!claims.some((c) => samePath(c, tree))) continue;
    out.push(st);
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
 * A line counts when the patch adds it (or a line containing it) and does not
 * also remove it: a line on both sides existed before, so matching it is
 * observation, not authorship.
 */
export function pickEndedSessionByContent(
  candidates: SessionState[],
  stagedPatch: string,
): EndedSessionOwner | null {
  const added = collect(stagedPatch, '+');
  if (added.size === 0) return null;
  const removed = collect(stagedPatch, '-');
  const scored: EndedSessionOwner[] = [];
  for (const state of candidates) {
    const lines = new Set<string>();
    const promptIndexes: number[] = [];
    for (const pm of state.completedPromptMappings || []) {
      if (!Number.isInteger(pm?.promptIndex)) continue;
      let hit = false;
      for (const l of collect(`${pm.uncommittedDiff || ''}\n${pm.diff || ''}`, '+')) {
        if (holdsLine(added, l) && !holdsLine(removed, l)) { lines.add(l); hit = true; }
      }
      if (hit) promptIndexes.push(pm.promptIndex);
    }
    if (lines.size > 0) scored.push({ state, promptIndexes: [...new Set(promptIndexes)].sort((a, b) => a - b), matchedLines: lines.size });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.matchedLines - a.matchedLines);
  if (scored.length > 1 && scored[0].matchedLines === scored[1].matchedLines) return null;
  return scored[0];
}
