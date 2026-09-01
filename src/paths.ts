// One place that knows how to compare paths.
//
// Every Windows bug in capture has been the same bug: two strings naming the
// same directory, compared with `===`. Within one night CI caught two of them.
//
//   - `wt === state.repoPath` never matched on Windows, because
//     `git rev-parse --show-toplevel` answers with FORWARD slashes (`C:/…`)
//     while node's `path` and `realpathSync` answer with backslashes. The main
//     checkout was therefore mistaken for a worktree on every single turn.
//   - `realpathSync` resolves symlinks but leaves 8.3 SHORT components alone,
//     so `C:\Users\RUNNER~1\…` and its long form compared as different
//     directories on the CI runner.
//   - On macOS the same class arrives by another route: /var and /tmp are
//     symlinks into /private, so a worktree under os.tmpdir() compares unequal
//     to the very path git just reported.
//
// Fixing each instance has not worked, because the next comparison someone
// writes reintroduces it. `path-comparison-guard.test.ts` fails the build when
// source compares path-ish identifiers with `===`, and points here.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A path in this platform's canonical form: separators normalised, `.`/`..`
 * resolved, symlinks and 8.3 short names resolved where the path exists.
 *
 * Resolution walks UP to the nearest existing ancestor and re-appends the
 * rest, so a file that has not been created yet — the common case when
 * recording a write — still normalises correctly instead of falling back to
 * the raw string.
 */
export function normalizePath(p: string | null | undefined): string {
  const raw = String(p ?? '');
  if (!raw) return '';
  // .native, not plain realpathSync: only the native form resolves 8.3 short
  // components on Windows.
  const real = (q: string): string => { try { return fs.realpathSync.native(q); } catch { return ''; } };

  let head = path.resolve(raw);
  const tail: string[] = [];
  for (let hops = 0; hops < 64; hops++) {
    const resolved = real(head);
    if (resolved) return tail.length ? path.join(resolved, ...tail.reverse()) : resolved;
    const parent = path.dirname(head);
    if (!parent || parent === head) break;
    tail.push(path.basename(head));
    head = parent;
  }
  // Nothing on the path exists — `path.resolve` is still the best answer, and
  // it has at least normalised separators and `..` segments.
  return path.resolve(raw);
}

/** Do these two strings name the same file or directory? */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Windows and macOS default to case-insensitive filesystems. Compare
  // case-folded THERE only: on Linux `A.ts` and `a.ts` are two files and
  // folding would merge them.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return false;
}

/**
 * Is `file` inside `root`'s tree?
 *
 * A relative path is taken as already expressed against the root. The
 * comparison is on normalised forms, so a not-yet-created file and a
 * symlinked temp root both answer correctly.
 */
export function isInsideRepo(root: string | null | undefined, file: string | null | undefined): boolean {
  if (!root || !file) return false;
  if (!path.isAbsolute(file)) return true;
  const rel = path.relative(normalizePath(root), normalizePath(file));
  if (rel === '') return true;
  // `..` means it escaped the root; an absolute result means a different drive
  // on Windows, which is likewise outside.
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * `file` expressed relative to `root`, with forward slashes — the form git
 * uses and the form every capture path keys on.
 *
 * Returns the input unchanged when it lies outside the root, which callers
 * must NOT read as "inside": use `isInsideRepo` for that question. This
 * function's contract is formatting, not membership.
 */
export function toRepoRelativePath(root: string | null | undefined, file: string | null | undefined): string {
  const f = String(file ?? '');
  if (!root || !f) return f.replace(/\\/g, '/');
  if (!path.isAbsolute(f)) return f.replace(/\\/g, '/');
  if (!isInsideRepo(root, f)) return f.replace(/\\/g, '/');
  const rel = path.relative(normalizePath(root), normalizePath(f));
  return rel.replace(/\\/g, '/');
}

/** Upper bound on a stored out-of-repo list — a runaway loop must not send MBs. */
export const MAX_OUT_OF_REPO_FILES = 50;

/**
 * `file` with the user's home directory collapsed to `~`.
 *
 * Out-of-repo paths are absolute by definition, so storing them verbatim would
 * put the account name into a column that (unlike the transcript) is not
 * encrypted at rest. `~` keeps every part a reviewer needs — which tree the
 * write landed in — and drops the part they don't.
 */
export function abbreviateHome(file: string): string {
  const f = String(file ?? '').replace(/\\/g, '/');
  const home = (os.homedir() || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!home) return f;
  if (f === home) return '~';
  const cmp = (process.platform === 'win32' || process.platform === 'darwin')
    ? (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase())
    : (a: string, b: string) => a.startsWith(b);
  return cmp(f, home + '/') ? '~' + f.slice(home.length) : f;
}

/**
 * The absolute paths in `files` that landed OUTSIDE `root`.
 *
 * This is the evidence behind a turn that captured no diff. An agent writing
 * to its own scratch dir, to /tmp, or into a sibling project produces exactly
 * the same "0 files changed" as a capture that broke — and the two are
 * indistinguishable to whoever is reading the session. Recording what was
 * dropped, and why, is what lets a zero-diff turn explain itself.
 *
 * Returns [] when `root` is unknown: without a root there is no "outside", and
 * guessing would label every write as out-of-repo. RELATIVE paths are skipped
 * for the same reason — they are already expressed against the root.
 */
export function outOfRepoWrites(root: string | null | undefined, files: Iterable<string> | null | undefined): string[] {
  if (!root || !files) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (typeof f !== 'string' || !f) continue;
    if (!path.isAbsolute(f)) continue;
    if (isInsideRepo(root, f)) continue;
    const abbr = abbreviateHome(f);
    const key = (process.platform === 'win32' || process.platform === 'darwin') ? abbr.toLowerCase() : abbr;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abbr);
    if (out.length >= MAX_OUT_OF_REPO_FILES) break;
  }
  return out;
}

/**
 * Bring a transcript-derived diff's file paths into the same space as the
 * turn's `filesChanged`: repo-relative, with out-of-repo sections dropped.
 *
 * A diff synthesized from an agent's own edit records (buildDiffFromEdits)
 * writes whatever path the record carried. Agents that record ABSOLUTE paths
 * and have no cwd on disk — Antigravity, which runs out of its own worktree
 * under ~/.gemini — therefore produce headers like
 *   diff --git a/Users/me/.gemini/antigravity/worktrees/repo/branch/app.py
 * because `diffHeaderPath` only strips what makes a path absolute (the drive
 * prefix); it is never told the repo root, so it cannot relativise.
 *
 * The turn's `filesChanged` IS relativised (toRepoRelative + isInsideRepo), so
 * the two disagreed, and every consumer that joins them on path missed:
 *
 *   - the server folds a turn's uncommitted diff onto the session's committed
 *     diff and skips any file the committed side already has. Keyed on the full
 *     path, `.../worktrees/repo/branch/app.py` never matched `app.py`, so the
 *     turn's whole window was APPENDED to a diff that already contained it.
 *     Session a4d0708a read +1666/-96 against a real +1103/-70 — five files
 *     counted twice.
 *   - sections for files outside the repo entirely (Antigravity writes its
 *     plan and walkthrough notes into its brain dir) stayed in the diff and
 *     were counted, though `filesChanged` had already dropped them.
 *
 * Rules, in order, per `diff --git` section:
 *   1. under `root` → rewritten to the repo-relative remainder;
 *   2. under the user's home but NOT under `root` → dropped, matching what
 *      `isInsideRepo` does to the same file in `filesChanged`;
 *   3. anything else → left exactly as it is.
 *
 * Rule 3 is what makes this safe to run over every agent's diff: a path that
 * is already repo-relative (`src/app.ts`) matches neither prefix and is not
 * touched. Comparison is on the drive-stripped form because the header path
 * has already lost its drive, and case-folded on the platforms whose
 * filesystems are.
 */
export function scopeDiffPathsToRepo(root: string | null | undefined, diff: string | null | undefined): string {
  const text = String(diff ?? '');
  if (!text || !text.includes('diff --git ')) return text;

  // The header path has no drive and no leading slash (see diffHeaderPath), so
  // both sides of every comparison are reduced to that same shape.
  const strip = (p: string): string => String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const fold = (p: string): string =>
    (process.platform === 'win32' || process.platform === 'darwin') ? p.toLowerCase() : p;

  const rootStripped = strip(root || '');
  const homeStripped = strip(os.homedir());
  const under = (p: string, prefix: string): boolean =>
    !!prefix && (fold(p) === fold(prefix) || fold(p).startsWith(fold(prefix) + '/'));

  // Does `root` actually describe THIS diff's path space? Dropping is the only
  // destructive thing here, and it must never fire on a guess.
  //
  // The watcher can resolve a session to the wrong checkout — an agent working
  // in its own worktree under ~/.gemini, measured against the main clone. Then
  // NOTHING is under `root`, every section is under the user's home, and rule 2
  // silently deleted the agent's entire diff. Live regression on session
  // 65014e0b: three files and +1352 lines became one file and +37/-37, because
  // the emptied diff let the (wrong) working-tree window win downstream.
  //
  // So: only drop when at least one section DID resolve under the root. That is
  // positive evidence the root belongs to this diff, and it makes a bad root
  // degrade to "paths left alone" — the pre-existing behaviour — instead of to
  // data loss.
  const sections = text.split(/^(?=diff --git )/m);
  const rootMatchesSomething = sections.some((s) => {
    const m = s.match(/^diff --git a\/\S+ b\/(\S+)/);
    return !!m && under(m[1], rootStripped);
  });

  const out: string[] = [];
  for (const section of sections) {
    if (!section) continue;
    const m = section.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!m) { out.push(section); continue; }
    const raw = m[2];
    if (under(raw, rootStripped)) {
      const rel = raw.slice(rootStripped.length + 1);
      // The root itself as a "file" is not a file — nothing to rewrite to.
      if (!rel) continue;
      out.push(
        section
          .replace(/^diff --git a\/\S+ b\/\S+/m, `diff --git a/${rel} b/${rel}`)
          .replace(/^--- a\/\S+/m, `--- a/${rel}`)
          .replace(/^\+\+\+ b\/\S+/m, `+++ b/${rel}`),
      );
      continue;
    }
    // Out-of-repo write the turn's filesChanged already dropped — but only once
    // the root has proved it describes this diff (see rootMatchesSomething).
    if (rootStripped && rootMatchesSomething && under(raw, homeStripped)) continue;
    out.push(section);
  }
  return out.join('');
}
