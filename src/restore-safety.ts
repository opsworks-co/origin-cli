// Restore safety decision — extracted from heartbeat.ts so it can be tested
// without importing the daemon (which starts timers and signal handlers on load).

/**
 * Decide whether a restore may safely overwrite the working tree.
 *
 * A restore's very next step is destructive — `git reset --hard` (hard mode) or
 * `read-tree` + `checkout-index -a -f` (soft) — and the pre-restore stash is the
 * ONLY recovery path for uncommitted work. So the decision is: stash a dirty
 * tree, and if that stash did NOT happen, DON'T proceed.
 *
 * This used to be an inline `try { status; if (dirty) stash } catch {}` whose
 * failures were swallowed, after which the reset ran regardless. Two ways it
 * went wrong, both destroying uncommitted work with a "restore succeeded"
 * message:
 *   • `git stash push` fails on a dirty tree (a stale index.lock, a mid-merge
 *     conflict, a failing clean/smudge filter) — the work exists but wasn't
 *     saved, and `stashed` stayed false.
 *   • `git status` itself throws — the code never even learned the tree was
 *     dirty, so it reset anyway.
 *
 * Extracted as a pure function so the safety property is directly testable
 * (the daemon's handleRestore isn't). `runGit(args)` should throw on non-zero
 * exit, exactly as execFileSync does.
 */
export function assessRestoreSafety(
  runGit: (args: string[]) => string,
  stashName: string,
): { safe: boolean; stashed: boolean; reason?: string } {
  let dirty = '';
  let statusKnown = true;
  try {
    dirty = runGit(['status', '--porcelain']).trim();
  } catch {
    statusKnown = false; // couldn't determine cleanliness — treat as risky
  }

  let stashed = false;
  if (dirty) {
    try {
      runGit(['stash', 'push', '-u', '-m', stashName]);
      stashed = true;
    } catch { /* stash failed — the guards below refuse to continue */ }
  }

  if (!statusKnown) {
    return { safe: false, stashed, reason: 'could not check for uncommitted changes' };
  }
  if (dirty && !stashed) {
    return { safe: false, stashed, reason: 'you have uncommitted changes that could not be stashed' };
  }
  return { safe: true, stashed };
}
