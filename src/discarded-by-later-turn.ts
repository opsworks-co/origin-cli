/**
 * Work an EARLIER turn left in the tree that a LATER turn threw away.
 *
 * Session 7ba816a4 (2026-10-01): every turn edited `Landing.tsx` and none
 * committed until the end. Turn 3 ran `git checkout HEAD -- Landing.tsx`
 * (throwing away turns 1 and 2) and wrote a new section; turn 7 checked the
 * file out again (throwing away 3, 4 and 6) and changed one paragraph, which
 * a later turn committed. The page read "uncommitted" on turns 1–6 — the pill
 * that says the work is still sitting in the tree — when none of it existed
 * anywhere. `discardedWorkForTurn` (discarded-work.ts) only judges the turn a
 * Stop CLOSES, from its own netZero files, so it never sees a later turn's
 * checkout.
 *
 * The rule, per file of an earlier turn's row:
 *
 *   • The turn's own lines are its DISTINCTIVE added lines: the lines of the
 *     file at the turn's end shadow that are not in the file at its start
 *     shadow nor in the commit that shadow stood on, whitespace-collapsed,
 *     ignoring lines with fewer than MIN_ALNUM letters/digits (`}`,
 *     `</div>`, `),` — they are everywhere and would make every turn look
 *     like it survived).
 *   • The work SURVIVES if any one of those lines is in the file in the tree
 *     now, or in the file in a commit made since (on HEAD, or one of the
 *     session's own), or in a stash made since. One line is enough: a later
 *     turn that REFINED the work (kept some, rewrote the rest) left it
 *     uncommitted, not discarded.
 *   • It is GONE only when none of them is anywhere.
 *
 * Content, not "is the file dirty": in 7ba816a4 turn 3 the file was dirty
 * again (a new section) while every line of turns 1–2 was gone.
 *
 * Conservative by construction — every doubt reads as "unknown", and unknown
 * changes nothing: no start/end shadow, a file missing from the tree (a move
 * reads the same as a delete), a turn with no distinctive line added or
 * removed, an unreadable git, more held versions than the bound.
 *
 * A REMOVAL is the turn's work too: lines it deleted, or a file it deleted.
 * It is gone when every removed line is back — in the tree now and in every
 * commit or stash since; one still missing anywhere keeps it.
 * A false "discarded" tells the user their work is gone; a missed one leaves
 * today's "uncommitted".
 *
 * Only ADDS to a row's `discardedFiles` and touches nothing else on the row —
 * not its diff, files or counts. A turn whose row is committed (its own
 * commit, a commit patch, an attestation) is never considered.
 */

import { execFileSync } from 'child_process';

/** A line needs this many letters/digits to count as the turn's own. */
export const MIN_ALNUM = 6;
/** Bounds that keep Stop cheap on a long session. */
export const MAX_TURNS = 25;
export const MAX_FILES_PER_TURN = 20;
/** More commits or stashes than this touching the files → unknown. */
export const MAX_HELD_VERSIONS = 40;

const norm = (line: string): string => line.replace(/\s+/g, ' ').trim();
const alnum = (line: string): number => (line.match(/[A-Za-z0-9]/g) || []).length;

function lineSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const l = norm(raw);
    if (l) out.add(l);
  }
  return out;
}

/**
 * The lines at `after` that were not at `before` — nor in `base`, the commit
 * the turn's tree stood on — and are worth looking for. A line that commit
 * already had is no evidence either way: a turn that PUT BACK the original
 * (7ba816a4 row 2: +411, restoring what the previous launch's turns had cut)
 * would "survive" every later checkout through exactly those lines.
 */
export function distinctiveAddedLines(before: string | null, after: string, base: string | null = null): Set<string> {
  const had = before === null ? new Set<string>() : lineSet(before);
  if (base !== null) for (const l of lineSet(base)) had.add(l);
  const out = new Set<string>();
  for (const l of lineSet(after)) {
    if (!had.has(l) && alnum(l) >= MIN_ALNUM) out.add(l);
  }
  return out;
}

export type LaterDiscardVerdict = 'gone' | 'survives' | 'unknown';

/**
 * One file of one earlier turn. `before` null = the file did not exist at the
 * turn's start; `after` null = absent or unreadable at its end; `now` null =
 * not in the tree; `held` = the file's text in each commit/stash since.
 */
export function laterDiscardVerdict(input: {
  before: string | null;
  /**
   * The file in the commit the turn's start stood on, when that differs;
   * null when that commit did not have it, undefined when the start is it.
   */
  base?: string | null;
  after: string | null;
  /** `after` is null because git says the file was NOT in the end tree. */
  deletedAtEnd?: boolean;
  now: string | null;
  held: readonly string[];
}): LaterDiscardVerdict {
  if (input.now === null) return 'unknown';
  // Null with no proof of a delete is an unreadable end, not a removal: read
  // as a deletion, a turn that only ADDED lines would have "removed" a file
  // whose every line is still there, and read as gone.
  if (input.after === null && !input.deletedAtEnd) return 'unknown';
  // A deleted file has no lines of its own to look for — only removed ones.
  const own = input.after === null
    ? new Set<string>()
    : distinctiveAddedLines(input.before, input.after, input.base ?? null);
  const removed = input.before === null ? new Set<string>() : distinctiveRemovedLines(input.before, input.after);
  // Removed lines the COMMIT under the turn's start held are a removal of
  // committed code. The rest removed dirt — an earlier turn's uncommitted
  // work — which a later `git checkout` removes just the same, so its absence
  // proves nothing about this turn; its presence proves the removal undone.
  // `base` undefined: the start IS a commit, so `before` is what it held.
  // `base` null: the commit under the start did not have the file at all.
  const committed = input.base === undefined
    ? (input.before === null ? new Set<string>() : lineSet(input.before))
    : (input.base === null ? new Set<string>() : lineSet(input.base));
  const removedCommitted = [...removed].filter((l) => committed.has(l));
  const removedDirt = [...removed].filter((l) => !committed.has(l));
  if (own.size === 0 && removed.size === 0) return 'unknown';
  const versions = [input.now, ...input.held].map(lineSet);
  for (const have of versions) {
    for (const l of own) if (have.has(l)) return 'survives';
  }
  // The turn's removal of committed code survives while any of those lines
  // is missing anywhere it could have been kept: the tree now, or a commit
  // or stash made since.
  for (const have of versions) {
    for (const l of removedCommitted) if (!have.has(l)) return 'survives';
  }
  const dirtBack = removedDirt.length > 0 && versions.every((have) => removedDirt.every((l) => have.has(l)));
  const evidence = own.size > 0 || removedCommitted.length > 0 || dirtBack;
  return evidence ? 'gone' : 'unknown';
}

/**
 * The lines the turn REMOVED: at `before`, not at `after` (`after` null = the
 * turn deleted the file), worth looking for. Session df8cc9aa turn 9 took a
 * fix back out of five files to run a control (−306) and turn 10 put every
 * line back and committed it; with only added lines to look for, the verdict
 * was "unknown" and turn 9 read "uncommitted" over a change that existed
 * nowhere.
 */
export function distinctiveRemovedLines(before: string, after: string | null): Set<string> {
  const kept = after === null ? new Set<string>() : lineSet(after);
  const out = new Set<string>();
  for (const l of lineSet(before)) {
    if (!kept.has(l) && alnum(l) >= MIN_ALNUM) out.add(l);
  }
  return out;
}

export interface LaterDiscardRow {
  promptIndex: number;
  filesChanged?: unknown;
  discardedFiles?: string[];
  commitSha?: string | null;
  commitPatch?: boolean;
  patchCommits?: string[];
}

export interface LaterDiscardDeps {
  /** Server row → this launch's local turn; null for a row from before it. */
  localTurn: (serverRow: number) => number | null;
  /** The turn's start and end shadows; null when either is unknown. */
  window: (localTurn: number) => { start: string; end: string } | null;
  /** True when a commit is attested to the turn. */
  turnCommitted: (localTurn: number) => boolean;
  /** Announce the reads coming, so they can be batched. */
  prime?: (pairs: Array<[string, string]>) => void;
  readAtRev: (rev: string, file: string) => string | null;
  /**
   * True only when git CONFIRMS `file` is not in `rev`'s tree — what tells a
   * deleted file from an unreadable one. Omitted: no deletion is ever judged.
   */
  absentAtRev?: (rev: string, file: string) => boolean;
  /** The file in the working tree now; null when it is not there. */
  readNow: (file: string) => string | null;
  /**
   * Commits/stashes since `sinceRev` that may hold the files; null when they
   * could not be listed, or there were more than the bound.
   */
  heldRevs: (sinceRev: string, files: string[]) => string[] | null;
  /** Start shadow → the commit it stood on (see startBasesFromGit). */
  startBases?: (starts: string[]) => Map<string, string>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

function filesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((f): f is string => typeof f === 'string');
  if (typeof v === 'string') {
    try { return filesOf(JSON.parse(v)); } catch { return []; }
  }
  return [];
}

/**
 * Add to each earlier row's `discardedFiles` the files whose work a later
 * turn threw away. `closingLocal` is the turn this Stop closes; it and any
 * later turn are skipped (the closing turn's own verdict is
 * discardedWorkForTurn's). Returns the number of rows changed.
 */
export function markWorkDiscardedByLaterTurns(
  mappings: LaterDiscardRow[],
  closingLocal: number,
  deps: LaterDiscardDeps,
): number {
  type Candidate = { pm: LaterDiscardRow; local: number; win: { start: string; end: string }; files: string[] };
  const candidates: Candidate[] = [];
  for (const pm of [...mappings].sort((a, b) => b.promptIndex - a.promptIndex)) {
    if (candidates.length >= MAX_TURNS) break;
    if (!pm || !Number.isInteger(pm.promptIndex)) continue;
    const local = deps.localTurn(pm.promptIndex);
    if (local === null || local >= closingLocal) continue;
    if (pm.commitSha || pm.commitPatch || (pm.patchCommits || []).length > 0) continue;
    if (deps.turnCommitted(local)) continue;
    const already = new Set(Array.isArray(pm.discardedFiles) ? pm.discardedFiles : []);
    const files = filesOf(pm.filesChanged).filter((f) => !already.has(f));
    if (files.length === 0 || files.length > MAX_FILES_PER_TURN) continue;
    const win = deps.window(local);
    if (!win) continue;
    candidates.push({ pm, local, win, files });
  }
  if (candidates.length === 0) return 0;

  // Commits/stashes since the OLDEST candidate's start: every later one's
  // window is inside that range, and one listing serves them all. A commit
  // older than a turn that holds its line only ever reads as "survives".
  const oldest = candidates.reduce((a, b) => (a.local <= b.local ? a : b));
  const allFiles = [...new Set(candidates.flatMap((c) => c.files))];
  let held: string[] | null;
  try { held = deps.heldRevs(oldest.win.start, allFiles); } catch { held = null; }
  if (held === null) {
    deps.log?.('later-discard: held versions unknown, nothing decided', { turns: candidates.length });
    return 0;
  }

  let bases = new Map<string, string>();
  try { bases = deps.startBases?.(candidates.map((c) => c.win.start)) || bases; } catch { /* the start alone */ }
  const baseOf = (start: string): string | null => {
    const b = bases.get(start);
    return b && b !== start ? b : null;
  };

  try {
    deps.prime?.([
      ...candidates.flatMap((c) => {
        const b = baseOf(c.win.start);
        return b ? c.files.map((f) => [b, f] as [string, string]) : [];
      }),
      ...candidates.flatMap((c) => c.files.flatMap((f) => [[c.win.start, f], [c.win.end, f]] as Array<[string, string]>)),
      ...held.flatMap((rev) => allFiles.map((f) => [rev, f] as [string, string])),
    ]);
  } catch { /* each read falls back on its own */ }

  const nowCache = new Map<string, string | null>();
  const readNow = (f: string) => {
    if (!nowCache.has(f)) {
      let v: string | null;
      try { v = deps.readNow(f); } catch { v = null; }
      nowCache.set(f, v);
    }
    return nowCache.get(f)!;
  };
  const heldCache = new Map<string, string[]>();
  const heldOf = (f: string) => {
    if (!heldCache.has(f)) {
      const texts: string[] = [];
      for (const rev of held!) {
        const t = deps.readAtRev(rev, f);
        if (t !== null) texts.push(t);
      }
      heldCache.set(f, texts);
    }
    return heldCache.get(f)!;
  };

  let changed = 0;
  for (const c of candidates) {
    const gone: string[] = [];
    for (const f of c.files) {
      const verdict = laterDiscardVerdict({
        before: deps.readAtRev(c.win.start, f),
        base: (() => { const b = baseOf(c.win.start); return b ? deps.readAtRev(b, f) : undefined; })(),
        after: deps.readAtRev(c.win.end, f),
        deletedAtEnd: (() => { try { return deps.absentAtRev?.(c.win.end, f) === true; } catch { return false; } })(),
        now: readNow(f),
        held: heldOf(f),
      });
      if (verdict === 'gone') gone.push(f);
    }
    if (gone.length === 0) continue;
    const prior = Array.isArray(c.pm.discardedFiles) ? c.pm.discardedFiles : [];
    c.pm.discardedFiles = [...new Set([...prior, ...gone])];
    changed++;
    deps.log?.('a later turn threw away this turn\'s work', { promptIndex: c.pm.promptIndex, files: gone });
  }
  return changed;
}

const HEX = /^[0-9a-f]{7,64}$/i;

/**
 * `absentAtRev` from git: `ls-tree` succeeded and listed nothing for the path.
 * A failed read is not an answer, so it returns false.
 */
export function absentAtRevFromGit(repoPath: string): (rev: string, file: string) => boolean {
  const run = gitRunner(repoPath);
  return (rev, file) => {
    if (!HEX.test(rev) || !file) return false;
    try {
      return run(['ls-tree', '--name-only', rev, '--', file]).trim() === '';
    } catch {
      return false;
    }
  };
}
const gitRunner = (repoPath: string) => (args: string[]): string => execFileSync('git', args, {
  cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000,
  maxBuffer: 4 * 1024 * 1024,
});

/**
 * `startBases` from git, in one process: a start that is an Origin shadow
 * commit (`origin shadow …`, parent = HEAD at the time) maps to its parent;
 * any other start maps to itself. Starts git cannot read are left out.
 */
export function startBasesFromGit(repoPath: string, starts: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const valid = [...new Set(starts.filter((s) => HEX.test(s)))];
  if (valid.length === 0) return out;
  try {
    const lines = gitRunner(repoPath)(['log', '--no-walk=unsorted', '--format=%H%x09%P%x09%s', ...valid]).split('\n');
    for (const line of lines) {
      const [sha, parents = '', subject = ''] = line.split('\t');
      if (!sha) continue;
      const first = parents.split(' ')[0];
      const base = subject.startsWith('origin shadow ') && first ? first : sha;
      for (const s of valid) if (sha.startsWith(s) || s.startsWith(sha)) out.set(s, base);
    }
  } catch { /* the caller compares against the start alone */ }
  return out;
}

/**
 * `heldRevs` from git: commits on HEAD since `sinceRev` that touch `files`,
 * the session's own live commits wherever they are (a turn that committed on
 * a branch and switched back), then stashes made since `sinceRev` was
 * written. Not every branch: in a checkout shared by many worktrees, other
 * sessions' branches would only add noise and push the list past the bound.
 * Null on any git failure, or when there are more than the bound.
 */
export function heldRevsFromGit(
  repoPath: string,
  sinceRev: string,
  files: string[],
  sessionCommits: readonly string[] = [],
): string[] | null {
  if (!HEX.test(sinceRev) || files.length === 0) return null;
  const run = gitRunner(repoPath);
  try {
    const onHead = run([
      'rev-list', `--max-count=${MAX_HELD_VERSIONS + 1}`, 'HEAD', '--not', sinceRev, '--', ...files,
    ]).split('\n').map((l) => l.trim()).filter(Boolean);
    const commits = [...new Set([...onHead, ...sessionCommits.filter((s) => HEX.test(s))])];
    if (commits.length > MAX_HELD_VERSIONS) return null;
    let stashes: string[] = [];
    let hasStash = true;
    try {
      run(['rev-parse', '--verify', '--quiet', 'refs/stash']);
    } catch (err) {
      // Exit 1 = no stash at all; anything else is unknown, never "none".
      if ((err as { status?: number | null }).status !== 1) return null;
      hasStash = false;
    }
    if (hasStash) {
      const since = Number(run(['log', '-1', '--format=%ct', sinceRev]).trim());
      if (!Number.isFinite(since)) return null;
      stashes = run(['log', '-g', `-n${MAX_HELD_VERSIONS + 1}`, '--format=%H %ct', 'refs/stash'])
        .split('\n').map((l) => l.trim().split(' '))
        // A minute of slack: the shadow is cut a moment after the turn starts.
        .filter(([sha, ct]) => !!sha && Number(ct) >= since - 60)
        .map(([sha]) => sha);
    }
    const all = [...new Set([...commits, ...stashes])];
    return all.length > MAX_HELD_VERSIONS ? null : all;
  } catch {
    return null;
  }
}
