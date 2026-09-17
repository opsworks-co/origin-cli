/**
 * Is a commit a REPLAY of one that already existed — a rebase pick, a
 * cherry-pick, `git am` — rather than work typed in the turn that is running?
 *
 * git runs prepare-commit-msg and post-commit for every commit a rebase or a
 * cherry-pick writes, exactly as for `git commit`. Origin read each one as the
 * running turn's commit: prepare-commit-msg stamped this session's trailer on
 * it (when the original had none), and post-commit recorded it on the session
 * and attested it to the turn. Session 6c21a6d8 (2026-09-16) rebased other
 * agents' PR branches to merge them and ended up owning them: d1847306 (Codex's
 * #1665, no trailer) on turn 1, a5a09d7f (trailer e33b6ee1) and a1026086
 * (Codex's #1670) on turn 2, whose row then read +581/-15 for a turn that
 * wrote no code. GitHub's squash kept the stamped trailer, so the mislabel is
 * on main for good.
 *
 * A replay of the session's OWN commit loses nothing by being skipped here:
 * post-rewrite hands its old→new pair to every session that owned the old
 * sha, which moves the sha list, the turn attestation and the note.
 *
 * Signals, measured against git 2.50 (see commit-replay.test.ts):
 *  - `GIT_REFLOG_ACTION` is NOT exported to hooks — empty for every operation.
 *  - `source` is `message` for a rebase pick and a cherry-pick alike, so
 *    prepare-commit-msg's `source === 'commit'` skip never fires for them.
 *  - While prepare-commit-msg runs, the git dir holds `rebase-merge/` (or
 *    `rebase-apply/`) during a rebase and `CHERRY_PICK_HEAD` during a pick.
 *    post-commit cannot rely on them: cherry-pick removes CHERRY_PICK_HEAD
 *    before post-commit starts, and Origin's post-commit runs in the
 *    background, after a rebase may have finished.
 *  - The HEAD reflog entry that CREATED the commit says what made it —
 *    `rebase (pick):`, `rebase (continue):`, `cherry-pick:`, against
 *    `commit:`, `commit (amend):`, `revert:` — and it is still there however
 *    late the background process reads it.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export type ReplayKind = 'rebase' | 'cherry-pick' | 'am';

const READ = { encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true };

/** How far back to look for the entry. A rebase of hundreds of commits writes one per pick. */
const REFLOG_WINDOW = 2_000;

/** What kind of replay a HEAD reflog subject records, if any. */
export function kindOfReflogSubject(subject: string): ReplayKind | null {
  if (/^(?:rebase|pull --rebase)\b/.test(subject)) return 'rebase';
  if (/^cherry-pick\b/.test(subject)) return 'cherry-pick';
  if (/^am\b/.test(subject)) return 'am';
  return null;
}

/**
 * What wrote `sha`, from the OLDEST entry for it in HEAD's reflog — the one
 * that created it. Newer entries for the same sha are later visits (a checkout
 * back to it, `rebase (finish)`), not its origin. Null for an ordinary commit,
 * and whenever the reflog cannot answer: the caller then keeps today's
 * behaviour.
 */
export function commitReplayKind(repoPath: string, sha: string): ReplayKind | null {
  if (!repoPath || !/^[a-fA-F0-9]{40,64}$/.test(sha || '')) return null;
  let out: string;
  try {
    out = execFileSync('git', ['reflog', 'show', `-n${REFLOG_WINDOW}`, '--format=%H%x00%gs', 'HEAD', '--'], { ...READ, cwd: repoPath });
  } catch { return null; }
  const want = sha.toLowerCase();
  let created: string | null = null;
  for (const line of out.split('\n')) {
    const nul = line.indexOf('\0');
    if (nul < 0 || line.slice(0, nul).toLowerCase() !== want) continue;
    created = line.slice(nul + 1); // newest first — the last match is the oldest
  }
  return created === null ? null : kindOfReflogSubject(created);
}

/**
 * A rebase, cherry-pick or `git am` is in progress in this worktree — the
 * commit being prepared right now is one of its replays. For
 * prepare-commit-msg, which runs in the foreground while the markers exist.
 */
export function replayInProgress(repoPath: string): ReplayKind | null {
  let gitDir: string;
  try {
    gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { ...READ, cwd: repoPath }).trim();
  } catch { return null; }
  if (!gitDir) return null;
  const dir = path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);
  if (fs.existsSync(path.join(dir, 'rebase-merge'))) return 'rebase';
  if (fs.existsSync(path.join(dir, 'rebase-apply'))) {
    return fs.existsSync(path.join(dir, 'rebase-apply', 'applying')) ? 'am' : 'rebase';
  }
  // Not `sequencer/`: a multi-commit `git revert` uses it too, and a revert is authored.
  if (fs.existsSync(path.join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  return null;
}
