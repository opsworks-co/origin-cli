/**
 * Work a turn STASHED is not work it discarded.
 *
 * `git stash` puts the working tree back at HEAD, so the ledger sees a file
 * the turn wrote end the turn at its starting bytes — the same shape as a
 * `git checkout -- <file>`, and discarded-work.ts called both "discarded".
 * The stash still holds the work; `git stash pop` in a later turn brings it
 * back. A pill saying "nothing of it is in the working tree or in a commit"
 * over a stash is the uncommitted/discarded confusion again, in reverse.
 *
 * A file counts as held when a stash made since the turn began holds it at
 * bytes THIS turn wrote (a hash the journal recorded for it in the turn).
 * The byte match is what keeps a sibling worktree's stash — the stash stack
 * is shared across every worktree of the repository — from vouching for a
 * file it merely also touched.
 */
import { execFileSync } from 'child_process';
import { readFileAtRev } from './git-capture.js';
import { hashContent } from './write-journal-store.js';

/** Enough for any real turn; a turn does not make dozens of stashes. */
const MAX_STASHES = 20;
/** `%ct` is whole seconds; the turn mark is milliseconds. */
const CLOCK_SLACK_MS = 2000;

/**
 * Files a stash created at or after `sinceMs` holds at one of the hashes in
 * `written` (file → hashes the turn wrote it at). Empty when there is no
 * stash; null when git could not be asked, which the caller reads as
 * "unknown" and leaves the row's verdict alone.
 */
export function filesHeldInStashes(
  repoPath: string,
  sinceMs: number,
  written: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> | null {
  const out = new Set<string>();
  if (written.size === 0) return out;
  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  try {
    try {
      git(['rev-parse', '--verify', '--quiet', 'refs/stash']);
    } catch (err) {
      // Exit 1 is `--verify --quiet`'s "no such ref": no stash at all, the
      // common case, and a definite answer. Anything else — not a repository,
      // a missing directory, no git — is unknown, never "none".
      if ((err as { status?: number | null }).status === 1) return out;
      return null;
    }
    const lines = git(['log', '-g', `-n${MAX_STASHES}`, '--format=%H %ct', 'refs/stash']).split('\n');
    for (const line of lines) {
      const [sha, ct] = line.trim().split(' ');
      if (!sha || !ct) continue;
      if (Number(ct) * 1000 < sinceMs - CLOCK_SLACK_MS) continue;
      for (const [file, hashes] of written) {
        if (out.has(file)) continue;
        const bytes = readFileAtRev(repoPath, sha, file);
        if (bytes !== null && hashes.has(hashContent(bytes))) out.add(file);
      }
      if (out.size === written.size) break;
    }
    return out;
  } catch {
    return null;
  }
}
