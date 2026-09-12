// What a turn INHERITED, as opposed to what it wrote.
//
// A turn's baseline is a shadow commit cut when the turn began, and every
// producer answers "what did this turn write?" by diffing that baseline
// against the turn's end state. That question is only the same question while
// the repo stays still. It does not:
//
//   `gh pr checkout 1538`, `git pull`, `git rebase origin/main`, `git merge` —
//   each REWRITES files on disk, and each therefore reads, to a
//   baseline..end diff and to the write-journal watcher alike, exactly like
//   the turn having typed those lines.
//
// Session a073a85b turn 1 is the shape. The prompt was "Review and merge 1538
// pr"; the turn ran `gh pr checkout 1538`, fixed the branch's CI, and
// committed FIVE lines shy of nothing — `7c96d0df`, +20/-10. Its stored row
// said 10 files, +574/-15: the entire pull request, authored the day before in
// another session, plus the twenty lines that were actually its own.
//
// hooks.ts already asks a version of this question per FILE
// (`filesLeftByForeignCommits`, `filesLeftByOwnEarlierCommits`) and drops a
// file whose working content still equals what the incoming commit left. That
// is necessary and not sufficient, and turn 1 shows both halves of why:
//
//   - Six files were dropped correctly — the checkout wrote them and the turn
//     never touched them again.
//   - Four survived, because the turn DID edit them on top. Their diffs were
//     still measured from the pre-checkout baseline, so
//     `prefer-shadow-range.test.ts` reported +195 for a +4/-3 edit.
//
// Both halves come from the same missing fact: the tree the turn actually
// started from is not its shadow, it is the tree the last inherited commit
// left. Name that commit once, and the file-level and line-level errors are
// the same error.
//
// The walk stops at the turn's OWN first commit. A turn that commits, then
// pulls, then commits again must not be re-baselined onto the pull — its first
// commit is work it authored, and everything from there on is its own.

/** Everything this module needs to read, injected so the rules are testable
 *  without a repository. */
export interface InheritedWindowDeps {
  /** `git rev-list <baseline>..HEAD` — NEWEST first, as git prints it. */
  listWindow: (baselineSha: string) => string[];
  /**
   * Is this commit the work of the turn being closed?
   *
   * True stops the walk. Callers combine the two questions hooks.ts already
   * asks separately: the commit belongs to this session AND it is not
   * attributed to one of the session's other turns.
   */
  isOwnWork: (sha: string) => boolean;
  /** Files a commit changed. */
  changedFiles: (sha: string) => string[];
  /** `git show <sha>:<file>`; null when the file does not exist there. */
  readAtRev: (sha: string, file: string) => string | null;
  /** `git merge-base --is-ancestor <a> <b>`. */
  isAncestor: (a: string, b: string) => boolean;
  /** Ceiling on file reads, mirroring FOREIGN_WINDOW_FILE_BUDGET in hooks.ts. */
  fileBudget?: number;
}

const DEFAULT_FILE_BUDGET = 300;
const HEX = /^[a-fA-F0-9]{7,40}$/;

/**
 * The newest commit in the turn's window that the turn did not author, and
 * that precedes every commit it did.
 *
 * Null when the window holds nothing inherited — the overwhelmingly common
 * case, and the one where every caller must keep its existing baseline
 * untouched.
 */
export function inheritedBaseline(
  baselineSha: string | null | undefined,
  deps: InheritedWindowDeps,
): string | null {
  if (!baselineSha || !HEX.test(baselineSha)) return null;
  let window: string[];
  try { window = deps.listWindow(baselineSha); } catch { return null; }
  if (!Array.isArray(window) || window.length === 0) return null;
  // An unanswerable commit counts as the turn's own: re-baselining PAST work
  // the turn authored erases it from the record, where failing to re-baseline
  // only leaves today's behaviour.
  const ours = new Set<string>();
  for (const sha of window) {
    let own: boolean;
    try { own = deps.isOwnWork(sha); } catch { own = true; }
    if (own) ours.add(sha);
  }
  // ANCESTRY, not recency. A window is not always a line: a turn that commits
  // and then merges holds its own commit, the merge, and every commit the
  // merge brought in — and "the newest commit before the first of ours" then
  // picks one off the other branch, re-baselining onto a tree the turn's own
  // work is not in. The commit the turn started from is the newest one that is
  // behind everything the turn wrote.
  for (const sha of window) {
    if (ours.has(sha)) continue;
    let behindOurs = true;
    for (const own of ours) {
      let ok: boolean;
      try { ok = deps.isAncestor(sha, own); } catch { ok = false; }
      if (!ok) { behindOurs = false; break; }
    }
    if (behindOurs) return sha;
  }
  return null;
}

/**
 * What each inherited file held at that commit — the before-state a producer
 * should measure the turn against.
 *
 * Only files the inherited commits touched appear. Everything else is diffed
 * from the turn's own baseline exactly as before, because for those two the
 * shadow and the inherited tree hold the same bytes.
 *
 * A file the inherited commit DELETED maps to null, which renders as a
 * creation if the turn wrote it back — which is what the turn did.
 */
export function inheritedBeforeStates(
  baselineSha: string | null | undefined,
  deps: InheritedWindowDeps,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const upTo = inheritedBaseline(baselineSha, deps);
  if (!upTo || !baselineSha) return out;
  let window: string[];
  try { window = deps.listWindow(baselineSha); } catch { return out; }
  let budget = deps.fileBudget ?? DEFAULT_FILE_BUDGET;
  for (const sha of window) {
    // Only the commits the turn actually inherited: `upTo` and its ancestors.
    if (sha !== upTo) {
      let behind: boolean;
      try { behind = deps.isAncestor(sha, upTo); } catch { behind = false; }
      if (!behind) continue;
    }
    let files: string[];
    try { files = deps.changedFiles(sha); } catch { files = []; }
    for (const file of files) {
      if (budget-- <= 0) return out;
      if (out.has(file)) continue;
      // Read at the NEWEST inherited commit, not at the one that named the
      // file: the turn started from the tree all of them left together.
      let at: string | null;
      try { at = deps.readAtRev(upTo, file); } catch { at = null; }
      out.set(file, at);
    }
  }
  return out;
}
