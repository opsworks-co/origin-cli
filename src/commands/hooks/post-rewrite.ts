/**
 * git's post-rewrite hook: the one place a rewrite is stated exactly.
 *
 * `git rebase` and `git commit --amend` hand this hook "old-sha new-sha" per
 * rewritten commit. Until now Origin used it only to copy attribution notes
 * across, and the SESSION learned about the rewrite later, by guessing: the
 * rescue in hooks.ts looks for a reachable commit with the same patch-id, or
 * the same subject and path set, or the same parent. Two of today's shapes
 * defeat every rung — a rebase that resolved a conflict AND changed the
 * subject, and a rebase whose conflict resolution changed the content of a
 * file — and the orphan stayed owned. Session 8a06aaf6 (2026-09-09): one PR,
 * five rewrites, three pairs guessed, six commit rows on one turn and a
 * header of +1005 across 19 files for +257 across 7.
 *
 * Git knew all five. Record what it says on every live session that owns
 * the old sha, and move that session's own readings onto the survivor.
 * Nothing is ever added that the session did not already own: a pair whose
 * `from` no session recorded is not ours and is left alone.
 */
import { debugLog } from '../../debug-log.js';
import { applyRewritePairsToState, saveSessionState } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import { listSessionsForGitHookUnscoped } from './post-commit.js';

export interface RewriteMapping { oldSha: string; newSha: string }

const SHA = /^[a-fA-F0-9]{7,40}$/;

function owns(state: SessionState, sha: string): boolean {
  const s = sha.toLowerCase();
  const same = (x: string) => {
    const y = x.toLowerCase();
    return y === s || y.startsWith(s) || s.startsWith(y);
  };
  if ((state.sessionCommitShas || []).some(same)) return true;
  if ((state.commitTurns || []).some((c) => c?.sha && same(c.sha))) return true;
  // Already-recorded pairs: a chain's later hop rewrites a sha that only
  // survives as an earlier pair's `to`.
  if ((state.rewrittenCommits || []).some((p) => p?.to && same(p.to))) return true;
  return false;
}

/**
 * Apply git's rewrite pairs to every live session in this tree that owns an
 * old sha. Returns what was recorded, for the log and for tests.
 */
export function recordGitRewrites(
  hookCwd: string,
  mappings: ReadonlyArray<RewriteMapping>,
): { sessions: number; pairs: number } {
  const valid = mappings.filter((m) => SHA.test(m?.oldSha || '') && SHA.test(m?.newSha || '') && m.oldSha !== m.newSha);
  if (valid.length === 0) return { sessions: 0, pairs: 0 };
  let sessions = 0;
  let pairs = 0;
  for (const state of listSessionsForGitHookUnscoped(hookCwd)) {
    // Ownership chains WITHIN the batch: a rebase followed by an amend before
    // any hook could record the first arrives as "A B" then "B C", and B is
    // ours the moment the first pair says so.
    const mine: RewriteMapping[] = [];
    const gained: string[] = [];
    for (const m of valid) {
      const ownedNow = owns(state, m.oldSha) || gained.some((g) => g.toLowerCase() === m.oldSha.toLowerCase());
      if (!ownedNow) continue;
      mine.push(m);
      gained.push(m.newSha);
    }
    if (mine.length === 0) continue;
    const changed = applyRewritePairsToState(state, mine.map((m) => ({ from: m.oldSha, to: m.newSha })));
    if (!changed) continue;
    try {
      saveSessionState(state, state.repoPath || hookCwd, state.sessionTag);
    } catch { /* best-effort — the rescue re-derives what it can */ }
    sessions += 1;
    pairs += mine.length;
    debugLog('post-rewrite', 'recorded rewrite pairs on session', {
      sessionId: state.sessionId,
      pairs: mine.map((m) => `${m.oldSha.slice(0, 8)}->${m.newSha.slice(0, 8)}`),
      commits: (state.sessionCommitShas || []).map((s) => s.slice(0, 8)),
    });
  }
  return { sessions, pairs };
}
