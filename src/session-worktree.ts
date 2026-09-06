// Which working tree is this session actually writing in?
//
// A turn's shell writes are derived from a git window: baseline shadow →
// working tree. Both halves have always used `state.repoPath`, which is the
// repo's IDENTITY, not necessarily the directory the agent is editing. When a
// session moves into a linked git worktree — Claude Code's own worktree mode
// does this, and agents `cd` into one by hand — every write lands somewhere
// `repoPath` cannot see, so the window comes back empty and the turn ships
// `edits: []`.
//
// Measured on session 81d65cb5: the turn produced a commit of +249/-16 across
// 6 files, all written into a worktree under /private/tmp, and the turn was
// captured as +40 on ONE file it never touched (a concurrent session's dirt,
// which was all the main checkout's window had to offer).
//
// The rule is deliberately narrow: follow the session ONLY into a linked
// worktree of the SAME repository, verified by git's common dir. Anything
// else — an unrelated repo, a non-repo cwd, a resolution failure — falls back
// to `repoPath`, because capturing the wrong tree is worse than capturing
// nothing.
import * as path from 'path';
import { isInsideRepo, samePath, samePath as canonicalSamePath, toRepoRelativePath } from './paths.js';
import * as fs from 'fs';

export interface WorkTreeDeps {
  /** Working-tree top containing `cwd`, or null. */
  gitRoot: (cwd: string) => string | null;
  /** Absolute `git rev-parse --git-common-dir` for `cwd`, or null. */
  gitCommonDir: (cwd: string) => string | null;
}

/**
 * Path equality that survives the platform.
 *
 * Windows: `git rev-parse --show-toplevel` answers with FORWARD slashes
 * (`C:/Users/...`) while node's `path` and `realpathSync` answer with
 * backslashes, so the same directory compares unequal as a raw string. macOS:
 * /var and /tmp are symlinks into /private, same problem by another route.
 * Normalise both sides before comparing — a `===` here silently mistook the
 * main checkout for a worktree on the Windows runner.
 */
export { samePath };

// Kept as the module-local helper the functions below already use; it now
// defers to the one implementation in paths.ts so a fix there reaches every
// caller rather than this file only.


function sameDir(a: string | null, b: string | null): boolean {
  return canonicalSamePath(a, b);
}

function _unusedSameDir(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  // realpath both sides: a worktree is routinely created under a symlinked
  // temp root (/tmp -> /private/tmp on macOS), so the raw strings differ for
  // what is one directory. Fall back to the raw value when a path is gone.
  // .native for the Windows 8.3 short-name case — see isInsideRepo.
  const real = (p: string): string => { try { return fs.realpathSync.native(p); } catch { return p; } };
  return path.resolve(real(a)) === path.resolve(real(b));
}

/**
 * The directory this session's writes are landing in.
 *
 * Returns `repoPath` unless `lastCwd` sits inside a linked worktree of that
 * same repository, in which case it returns the worktree's top.
 */
export function sessionWorkTree(
  repoPath: string | undefined | null,
  lastCwd: string | undefined | null,
  deps: WorkTreeDeps,
): string {
  const repo = repoPath || '';
  if (!repo || !lastCwd) return repo;

  let root: string | null = null;
  try { root = deps.gitRoot(lastCwd); } catch { root = null; }
  if (!root || sameDir(root, repo)) return repo;

  // Same repository? A linked worktree shares the main repo's common dir.
  // Without this check a session whose cwd wandered into an unrelated repo
  // would have that repo's diff attributed to it.
  let a: string | null = null;
  let b: string | null = null;
  try { a = deps.gitCommonDir(root); } catch { a = null; }
  try { b = deps.gitCommonDir(repo); } catch { b = null; }
  if (!sameDir(a, b)) return repo;

  // Normalise before handing it back: git's forward-slash answer would
  // otherwise flow into state and be string-compared against a backslash
  // repoPath elsewhere.
  return path.resolve(root);
}

/**
 * The two roots a read-only provenance query needs.
 *
 * `origin why` and `origin prompts` need BOTH, for different questions, and
 * conflating them is what made them answer nothing inside a worktree:
 *
 *   canonicalRoot — the repo's IDENTITY. `getGitRoot` collapses a linked
 *     worktree onto its main checkout on purpose, so the dashboard sees one
 *     project rather than one per worktree. Right for naming the repo to the
 *     server; wrong for reading files.
 *   workRoot — the tree the user is actually STANDING IN. `getWorkingGitRoot`.
 *     Right for `git blame` / `git log` / reading the file, because that is
 *     where the branch and the content the user is asking about live.
 *
 * Same working-vs-canonical split as `deriveAgyRoots` (#1226) and the capture
 * path's `getWorkingGitRoot` (#510) — the provenance commands never got it.
 */
export interface ProvenanceRoots {
  /** Top of the working tree containing cwd — a linked worktree, or the main checkout. */
  workRoot: string;
  /** The repo's identity root; a linked worktree collapses to its main checkout. */
  canonicalRoot: string;
}

/**
 * Both roots for a directory, or null when it is not in a repo.
 *
 * Deps are injected the way this module's other helpers take theirs, so the
 * two commands share ONE implementation and cannot drift apart: `gitRoot` is
 * `getGitRoot` (collapses a worktree — identity), `workingGitRoot` is
 * `getWorkingGitRoot` (keeps it — file reads).
 */
export function provenanceRoots(
  cwd: string,
  deps: { gitRoot: (cwd: string) => string | null; workingGitRoot: (cwd: string) => string | null },
): ProvenanceRoots | null {
  let canonicalRoot: string | null = null;
  let workRoot: string | null = null;
  try { canonicalRoot = deps.gitRoot(cwd); } catch { canonicalRoot = null; }
  try { workRoot = deps.workingGitRoot(cwd); } catch { workRoot = null; }
  workRoot = workRoot || canonicalRoot;
  if (!canonicalRoot || !workRoot) return null;
  return { workRoot, canonicalRoot };
}

/**
 * Turn a file argument into (repo-relative path, the root to run git in).
 *
 * The bug this exists to prevent: with worktrees living under
 * `<repo>/.claude/worktrees/<name>`, resolving the argument against the
 * CANONICAL root produced `.claude/worktrees/<name>/apps/api/src/routes/mcp.ts`
 * — a path git knows nothing about, since the worktree is untracked dirt in
 * the main checkout. `origin prompts` answered "No commits found for
 * .claude/worktrees/…" and `origin why` answered "Uncommitted change" for
 * lines with years of history. Both looked like missing DATA; the key was
 * wrong.
 *
 * Preference order is what does the work: the tree the user stands in wins, so
 * a worktree file resolves against the worktree. An absolute path pointing
 * into the MAIN checkout while cwd is in a worktree escapes workRoot and falls
 * through to canonicalRoot, which is the correct answer for it. A path in
 * neither tree keeps the old behaviour — the message still names something the
 * user can recognise.
 */
export function resolveQueryTarget(
  fileArg: string,
  roots: ProvenanceRoots,
  cwd: string,
): { relPath: string; root: string } {
  const abs = path.resolve(cwd, String(fileArg ?? ''));
  for (const root of [roots.workRoot, roots.canonicalRoot]) {
    if (!root) continue;
    if (isInsideRepo(root, abs)) return { relPath: toRepoRelativePath(root, abs), root };
  }
  const fallback = roots.workRoot || roots.canonicalRoot || '';
  return { relPath: toRepoRelativePath(fallback, abs), root: fallback };
}

/** A baseline snapshotted in the worktree the session is writing in. */
export interface WorkTreeBaseline {
  /** Working-tree top the shadow's tree was taken from. */
  path: string;
  /** Shadow commit sha. */
  sha: string;
  /** Turn this baseline belongs to. */
  promptIndex: number;
}

/**
 * Pick the (tree, baseline) pair the shell window should diff.
 *
 * The two MUST come from the same working tree. Mixing them — a main-checkout
 * shadow against a worktree's files — reports the whole branch delta as the
 * turn's work, which is far worse than the under-capture being fixed here.
 * That coupling is why this returns a pair rather than a path.
 */
export function shellWindowTarget(
  state: {
    repoPath?: string;
    prePromptWorkTree?: WorkTreeBaseline | null;
  },
  promptIndex: number,
  fallbackBaseline: string | null | undefined,
  currentWorkTree: string,
): { repoPath: string; baseline: string | null | undefined } {
  const wt = state.prePromptWorkTree;
  if (
    wt && wt.sha && wt.path &&
    wt.promptIndex === promptIndex &&
    sameDir(wt.path, currentWorkTree)
  ) {
    return { repoPath: wt.path, baseline: wt.sha };
  }
  // No worktree baseline for this turn (the common case, and any case where
  // the session moved mid-turn): the main checkout's pair is still coherent.
  return { repoPath: state.repoPath || '', baseline: fallbackBaseline };
}

/**
 * Directories a shell command plausibly wrote in, for finding a worktree the
 * session moved into WITHOUT the harness knowing.
 *
 * `sessionWorkTree` reads `state.lastCwd`, which only moves when the harness
 * enters a worktree. An agent that runs `cd /path/to/wt && …` inside a single
 * Bash call never moves it, so its writes stay invisible — that is how session
 * 81d65cb5 lost +249/-16 across six files while the fix for the harness case
 * was already shipped.
 *
 * The command text is a usable signal because agents write literal absolute
 * paths even when they later use variables: `W=/private/tmp/…/wt && cd $W`
 * carries the real path in the assignment. `$W` itself is NOT recoverable —
 * shell expansion happened in a process we never saw — so a command that only
 * ever names the directory through a variable defined in an earlier, separate
 * call stays uncovered. This narrows the gap; it does not close it.
 *
 * Returns absolute-looking candidates only, de-duplicated, newest-first, and
 * capped: each one costs a `git rev-parse` to check.
 */
export function candidateDirsFromCommand(command: string, cap = 8): string[] {
  if (!command || typeof command !== 'string') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    if (!p) return;
    // Strip trailing punctuation the tokenizer drags along, and anything from
    // a shell metacharacter onward.
    const clean = p.replace(/["'`;|&)]+$/, '').replace(/[\\/]+$/, '');
    if (!clean || clean.length < 2) return;
    // A path containing an unexpanded variable or substitution is useless.
    if (/[$*?]/.test(clean)) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };

  // Absolute paths in BOTH families. Windows was the whole feature silently
  // doing nothing: the extraction matched only POSIX `/...`, so on a Windows
  // agent every candidate was `C:\Users\...` and none were seen. CI caught it.
  const POSIX_ABS = '\\/[^\\s;|&)"\']+';
  const WIN_ABS = '[A-Za-z]:[\\\\/][^\\s;|&)"\']+';
  const ABS = `(?:${POSIX_ABS}|${WIN_ABS})`;

  // Explicit directory arguments first — the strongest signal.
  for (const m of command.matchAll(new RegExp(`(?:^|[;&|]\\s*|\\s)cd\\s+(${ABS})`, 'g'))) push(m[1]);
  for (const m of command.matchAll(new RegExp(`git\\s+-C\\s+(${ABS})`, 'g'))) push(m[1]);
  // Then any absolute path in the text, which covers `VAR=/abs/path`.
  for (const m of command.matchAll(new RegExp(`(?:^|[\\s=:"'])(${ABS})`, 'g'))) push(m[1]);

  return out.slice(0, cap);
}

/**
 * Of `candidates`, the ones that are a linked worktree of `repoPath` — the
 * same same-repository test `sessionWorkTree` applies, so a path in an
 * unrelated repo or outside git is never adopted.
 *
 * Candidates are FILES as often as directories (a write target), so each is
 * walked up until git answers.
 */
export function worktreesAmongCandidates(
  repoPath: string,
  candidates: readonly string[],
  deps: WorkTreeDeps,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    // Walk UP until git can answer. A candidate is as often a write target as
    // a directory (`cat > <wt>/src/new.ts`), and its parent may not exist yet,
    // in which case `git -C` fails outright rather than reporting the repo.
    let dir = c;
    let resolved = '';
    for (let hops = 0; hops < 6 && dir && dir !== path.dirname(dir); hops++) {
      if (fs.existsSync(dir)) {
        const r = sessionWorkTree(repoPath, dir, deps);
        if (r && !samePath(r, repoPath)) resolved = r;
        break;
      }
      dir = path.dirname(dir);
    }
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    found.push(resolved);
  }
  return found;
}
