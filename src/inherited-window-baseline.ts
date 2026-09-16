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
  /**
   * `git rev-list --parents <baseline>..<end>` — each window commit's parents,
   * over the same range `listWindow` lists. Lets the ancestry questions among
   * the turn's own commits be answered from one read instead of one
   * `isAncestor` spawn per pair. Falls back to `isAncestor` when absent.
   */
  windowParents?: (baselineSha: string) => Map<string, string[]>;
  /** Real commit behind a turn shadow (or the baseline itself when not a shadow). */
  baselineCommit?: (baselineSha: string) => string;
  head?: () => string;
  /** Known commits made by this turn, including ones on branches it left. */
  ownCommits?: string[];
  firstParent?: (sha: string) => string;
  changedFilesBetween?: (from: string, to: string) => string[];
  /** `git rev-list <baseline>..<end> -- <files>` — the window, limited to
   *  commits that touched these files. Falls back to `listWindow`. */
  listWindowTouching?: (baselineSha: string, files: string[]) => string[];
  /** `git rev-list <baseline>..<sha>` — the window commits behind `sha`. */
  ancestryInWindow?: (baselineSha: string, sha: string) => string[];
  /** `git merge-base --independent` — the commits no other one descends from. */
  independent?: (shas: string[]) => string[];
  /**
   * A commit whose tree is all of `tips` merged. Where they conflict, the
   * conflicted paths take `conflictSide`'s version; null when there is no side
   * to take or the merge cannot be computed.
   */
  combineTips?: (tips: string[], conflictSide: string | null) => string | null;
  /** Has this commit more than one parent? */
  isMerge?: (sha: string) => boolean;
  /**
   * The paths git could NOT merge on its own when it merged this commit's
   * parents — the files the merge commit actually resolved. Null when that
   * cannot be answered (not a two-parent merge, or git older than
   * `merge-tree --write-tree`), and the caller treats every file the merge
   * touched as resolved, as it always has.
   */
  mergeConflicts?: (sha: string) => string[] | null;
  /**
   * A commit whose tree is `base` with each file taken from the commit it
   * came from — see `commitWithInheritedFiles` (git-capture.ts). Null when a
   * file cannot be placed.
   */
  commitWithFiles?: (base: string, sources: Map<string, string>) => string | null;
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
  if (!Array.isArray(window)) return null;
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
  //
  // Asked pair by pair that is |window| × |ours| spawns; a turn with hundreds
  // of own commits ran for minutes. `behindOurs` is the same answer read off
  // the window's parent graph, null when the graph cannot give it. Read only
  // when first asked: most windows are empty, or hold none of the turn's own.
  let graph: ReturnType<typeof commitsBehindAll> | undefined;
  const behindOurs = () => (graph === undefined
    ? (graph = ours.size ? commitsBehindAll(baselineSha, window, ours, deps) : null)
    : graph);
  const behindAllOurs = (sha: string): boolean => {
    const known = behindOurs();
    if (known?.inWindow.has(sha)) return known.behind.has(sha);
    for (const own of ours) {
      let ok: boolean;
      try { ok = deps.isAncestor(sha, own); } catch { ok = false; }
      if (!ok) return false;
    }
    return true;
  };
  for (const sha of window) {
    if (ours.has(sha)) continue;
    if (behindAllOurs(sha)) return widenToEveryInheritedLine(baselineSha, sha, window, ours, behindAllOurs, deps);
  }
  // A backward/divergent checkout can add NO foreign commits to baseline..HEAD.
  // In that case the destination is HEAD, or the parent before this turn's
  // first own commit. Only use it when it is outside the baseline's ancestry;
  // an ordinary commit atop a dirty shadow must keep that shadow's dirty bytes.
  if (deps.baselineCommit && deps.head && deps.firstParent) {
    try {
      // A turn that already committed on a branch it then left needs multiple
      // windows. One destination baseline would erase that earlier work.
      if (deps.ownCommits?.some((own) => !window.some((sha) => sha.startsWith(own) || own.startsWith(sha)))) return null;
      const start = deps.baselineCommit(baselineSha);
      // The own commit every other own commit descends from. At most one can
      // be; the graph names it without a spawn per pair.
      const known = behindOurs();
      const firstOwn = known
        ? [...ours].find((sha) => known.behind.has(sha))
        : [...ours].find((sha) =>
          [...ours].every((other) => sha === other || deps.isAncestor(sha, other)));
      if (ours.size && !firstOwn) return null;
      const destination = firstOwn ? deps.firstParent(firstOwn) : deps.head();
      if (HEX.test(start) && HEX.test(destination) && start !== destination
        && !deps.isAncestor(start, destination)) return destination;
    } catch { /* No proven checkout boundary: retain the original baseline. */ }
  }
  return null;
}

/**
 * The window commits that are an ancestor of (or equal to) EVERY one of
 * `ours` — what `isAncestor(sha, own)` over all own commits answers — computed
 * from one parent-graph read.
 *
 * Ancestry between two window commits never leaves the window: every commit
 * on the path from b back to a is behind the window's end (b is) and not
 * behind the baseline (a is not). So the window's own parent edges answer it
 * exactly, and a graph that holds more than the window changes nothing.
 *
 * Null — callers fall back to per-pair `isAncestor` — when there is no graph
 * dep, it fails, or it does not hold every window commit.
 */
function commitsBehindAll(
  baselineSha: string,
  window: string[],
  ours: Set<string>,
  deps: InheritedWindowDeps,
): { inWindow: Set<string>; behind: Set<string> } | null {
  if (!deps.windowParents) return null;
  let parents: Map<string, string[]>;
  try { parents = deps.windowParents(baselineSha); } catch { return null; }
  if (!(parents instanceof Map) || !window.every((sha) => parents.has(sha))) return null;
  const inWindow = new Set(window);
  let behind: Set<string> | null = null;
  for (const own of ours) {
    // Inclusive ancestry of `own`, restricted to the window.
    const reach = new Set<string>();
    const stack = [own];
    while (stack.length) {
      const cur = stack.pop()!;
      if (reach.has(cur) || !inWindow.has(cur)) continue;
      reach.add(cur);
      for (const p of parents.get(cur) || []) stack.push(p);
    }
    if (behind === null) behind = reach;
    else for (const sha of behind) if (!reach.has(sha)) behind.delete(sha);
    if (behind.size === 0) break;
  }
  return behind ? { inWindow, behind } : null;
}

/**
 * The newest inherited commit is only the whole story when the turn inherited
 * ONE line. A turn that checks out a branch and then merges main inherits two,
 * and "newest" is then decided by commit date — session c5487aa9 turn 2 got
 * main's commit (00:25Z) over pr-1642's (00:09Z), a tree without the file the
 * PR created, and every producer measured that file as the turn's creation.
 *
 * So: every inherited line that is not already behind `first` is found, and
 * when there is more than one, `combineTips` names a commit whose tree holds
 * them all — the tree the turn's own merge started from.
 *
 * Git does not always produce that merge: a conflict with no side to take,
 * git older than `merge-tree --write-tree` (2.38), or more lines than the
 * budget lets us walk. Returning `first` then was a coin toss by commit date,
 * and every file only another line touched read at a tree that predates it.
 * Instead the same tree is built FILE BY FILE — see `fileByFileTree` — and
 * `first` is kept only when that cannot be answered either.
 */
function widenToEveryInheritedLine(
  baselineSha: string,
  first: string,
  window: string[],
  ours: Set<string>,
  behindAllOurs: (sha: string) => boolean,
  deps: InheritedWindowDeps,
): string | null {
  if (!deps.ancestryInWindow || !deps.independent || !deps.combineTips) return first;
  const orFileByFile = (): string | null => {
    const built = fileByFileTree(baselineSha, deps);
    return built === GAVE_UP ? first : built;
  };
  try {
    const behindFirst = new Set(deps.ancestryInWindow(baselineSha, first));
    const others = window.filter((sha) => sha !== first && !ours.has(sha) && !behindFirst.has(sha));
    if (others.length === 0) return first;
    // One argv per sha: a merge of main can bring in hundreds.
    if (others.length > (deps.fileBudget ?? DEFAULT_FILE_BUDGET)) return orFileByFile();
    const tips = deps.independent(others).filter((sha) => behindAllOurs(sha));
    if (tips.length === 0) return first;
    // Where two lines conflict, the turn's merge resolved them — its own work,
    // measured against the side it stood on, as mergeOwnDiff measures a merge.
    const side = lineTheTurnStoodOn(baselineSha, (sha) => ours.has(sha), window.length, deps);
    const all = [first, ...tips];
    const ordered = side ? [...all.filter((t) => t === side), ...all.filter((t) => t !== side)] : all;
    return deps.combineTips(ordered, side) || orFileByFile();
  } catch {
    return orFileByFile();
  }
}

const GAVE_UP = Symbol('gave up');

/**
 * The tree the turn started from, assembled one file at a time: its own start,
 * with each file an inherited commit changed taken from THE commit it came
 * from (`inheritedFileSources`, the question post-commit asks).
 *
 * That answer needs no merge. A file with one proven source is placed from it;
 * a file the resolver leaves out on purpose — the turn's own merge resolved it
 * against the side it stood on, or two lines left it ambiguous — keeps the
 * turn's start, which is where post-commit measures it from too.
 *
 * Null when nothing was proven: no file has a single inherited source, so no
 * tree differs from the turn's own start. GAVE_UP when the question could not
 * be asked — reads missing, over the budget, or the resolver surrendered — and
 * the caller keeps the single-commit answer it already had.
 */
function fileByFileTree(baselineSha: string, deps: InheritedWindowDeps): string | null | typeof GAVE_UP {
  if (!deps.baselineCommit || !deps.head || !deps.changedFilesBetween || !deps.commitWithFiles) return GAVE_UP;
  try {
    const start = deps.baselineCommit(baselineSha);
    const end = deps.head();
    if (!HEX.test(start) || !HEX.test(end)) return GAVE_UP;
    const files = [...new Set(deps.changedFilesBetween(start, end))];
    if (files.length === 0) return null;
    if (files.length > (deps.fileBudget ?? DEFAULT_FILE_BUDGET)) return GAVE_UP;
    let surrendered = false;
    const sources = inheritedFileSources(baselineSha, files, deps, () => { surrendered = true; });
    if (surrendered) return GAVE_UP;
    if (sources.size === 0) return null;
    return deps.commitWithFiles(start, sources) || GAVE_UP;
  } catch {
    return GAVE_UP;
  }
}

/**
 * For each of `files`, the ONE inherited commit whose version of it the turn
 * started from.
 *
 * `inheritedBaseline` names one commit for the whole tree, and a merge makes
 * that a coin toss. Session c5487aa9 turn 2 checked out pr-1642 (ced61af0c,
 * another session's, which CREATED a test file), merged origin/main
 * (acd0c65bd, which never touched it), then committed +2/-1 to the file. Both
 * foreign commits are behind all of the turn's own; main's was the newer, so
 * newest-first names a tree without the file, and post-commit sent +64/-0.
 *
 * Asked per file, the order stops mattering: only commits that touched the file
 * are candidates. A file is left out — its caller keeps the turn's own
 * baseline, today's behaviour — when the answer is not a single commit:
 *   - no inherited commit touched it;
 *   - an inherited commit touched it AFTER the turn's own work on it (a pull
 *     between two of its commits), where neither tree is where the turn began;
 *   - two parallel inherited lines both touched it;
 *   - a MERGE of the turn's touched it — its resolution mixed both sides.
 */
export function inheritedFileSources(
  baselineSha: string | null | undefined,
  files: string[],
  deps: InheritedWindowDeps,
  /**
   * Called when the resolver GAVE UP — over the budget, or a read failed —
   * rather than finding that no file had a single inherited source. Both
   * return an empty map, and they mean opposite things to a caller choosing a
   * base for the files left out: a deliberate omission is measured from the
   * turn's own start (see the merge case above); a surrender carries no
   * information at all.
   */
  onGiveUp?: () => void,
): Map<string, string> {
  const out = new Map<string, string>();
  const giveUp = () => { onGiveUp?.(); return new Map<string, string>(); };
  if (!baselineSha || !HEX.test(baselineSha) || files.length === 0) return out;
  const budget = deps.fileBudget ?? DEFAULT_FILE_BUDGET;
  if (files.length > budget) return giveUp();
  let window: string[];
  try {
    window = deps.listWindowTouching ? deps.listWindowTouching(baselineSha, files) : deps.listWindow(baselineSha);
  } catch { return giveUp(); }
  if (!Array.isArray(window) || window.length > budget) return giveUp();
  // Nothing in the window touched these files: an answer, not a surrender.
  if (window.length === 0) return out;

  const wanted = new Set(files);
  const touching = new Map<string, Array<{ sha: string; own: boolean }>>();
  for (const sha of window) {
    let changed: string[];
    try { changed = deps.changedFiles(sha); } catch { return giveUp(); }
    const hits = changed.filter((f) => wanted.has(f));
    if (hits.length === 0) continue;
    // Unanswerable counts as the turn's own, as in inheritedBaseline.
    let own: boolean;
    try { own = deps.isOwnWork(sha); } catch { own = true; }
    for (const file of hits) {
      const list = touching.get(file) || [];
      list.push({ sha, own });
      touching.set(file, list);
    }
  }

  const ancestor = (a: string, b: string): boolean => {
    try { return deps.isAncestor(a, b); } catch { return false; }
  };
  const ownCache = new Map<string, boolean>();
  for (const list of touching.values()) for (const c of list) ownCache.set(c.sha, c.own);
  const isOwn = (sha: string): boolean => {
    const known = ownCache.get(sha);
    if (known !== undefined) return known;
    let own: boolean;
    try { own = deps.isOwnWork(sha); } catch { own = true; }
    ownCache.set(sha, own);
    return own;
  };
  // Did one of the turn's own merges RESOLVE this file? A merge's changed-file
  // list (`changedFiles`, first-parent) names every file it brought in, and a
  // file main merged in cleanly is not the turn's resolution: its one source
  // is main. Only the paths git itself could not merge were resolved by the
  // turn. Unanswerable keeps the old reading — any merge that touched it.
  const conflictsOf = new Map<string, string[] | null>();
  const mergeResolved = (sha: string, file: string): boolean => {
    if (!deps.isMerge) return false;
    let merge: boolean;
    try { merge = deps.isMerge(sha); } catch { return true; }
    if (!merge) return false;
    if (!deps.mergeConflicts) return true;
    if (!conflictsOf.has(sha)) {
      let c: string[] | null;
      try { c = deps.mergeConflicts(sha); } catch { c = null; }
      conflictsOf.set(sha, c);
    }
    const conflicted = conflictsOf.get(sha);
    return conflicted == null ? true : conflicted.includes(file);
  };
  // Computed once, and only when some file needs it.
  let stoodOn: string | null | undefined;
  const side = () => (stoodOn === undefined
    ? (stoodOn = lineTheTurnStoodOn(baselineSha, isOwn, budget, deps))
    : stoodOn);

  for (const [file, commits] of touching) {
    const foreign = commits.filter((c) => !c.own).map((c) => c.sha);
    if (foreign.length === 0) continue;
    const own = commits.filter((c) => c.own).map((c) => c.sha);
    if (!foreign.every((f) => own.every((o) => ancestor(f, o)))) continue;
    const tips = foreign.filter((f) => !foreign.some((g) => g !== f && ancestor(f, g)));
    const resolvedByOurMerge = own.some((sha) => mergeResolved(sha, file));
    // One line, taken in whole: that line's version.
    if (tips.length === 1 && !resolvedByOurMerge) { out.set(file, tips[0]); continue; }
    // Parallel lines, or a merge of the turn's that resolved this file: the
    // resolution is the turn's work, measured against the side it stood on.
    // A side behind the baseline is the turn's own start — no inherited source.
    const stood = side();
    if (!stood) continue;
    const onSide = tips.filter((t) => t === stood || ancestor(t, stood));
    if (onSide.length === 1) out.set(file, onSide[0]);
  }
  return out;
}

/**
 * The commit the turn stood on when it took in other lines: the first commit
 * that is not the turn's own, walking FIRST parents back from the window's end.
 *
 * A merge's first parent is the branch it was run on, so this is the side a
 * conflict's resolution is measured against — the same convention mergeOwnDiff
 * uses for a merge's own contribution. Null when it cannot be walked.
 */
function lineTheTurnStoodOn(
  baselineSha: string,
  isOwn: (sha: string) => boolean,
  limit: number,
  deps: InheritedWindowDeps,
): string | null {
  if (!deps.head || !deps.firstParent) return null;
  try {
    const start = deps.baselineCommit ? deps.baselineCommit(baselineSha) : null;
    let cur = deps.head();
    for (let i = 0; i <= limit; i++) {
      if (!HEX.test(cur)) return null;
      // Behind the baseline is where the turn began, whoever wrote it.
      if (start && (cur === start || deps.isAncestor(cur, start))) return cur;
      if (!isOwn(cur)) return cur;
      cur = deps.firstParent(cur);
    }
  } catch { /* unwalkable: no side */ }
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
  // Comparing trees includes files removed by LEAVING the old branch, which
  // a walk of newly reachable commits cannot name.
  if (deps.changedFilesBetween && deps.baselineCommit) {
    try {
      const files = deps.changedFilesBetween(deps.baselineCommit(baselineSha), upTo);
      for (const file of [...new Set(files)].slice(0, deps.fileBudget ?? DEFAULT_FILE_BUDGET)) {
        out.set(file, deps.readAtRev(upTo, file));
      }
      return out;
    } catch { return new Map(); }
  }
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
