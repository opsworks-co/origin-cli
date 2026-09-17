/**
 * Files a turn only put back to a version history already had.
 *
 * Session 874ff028 turn 6. After Stop, a background shell job committed a WIP
 * commit and ran `git checkout 95ec4a416 -- packages/cli/src` — an OLDER main,
 * HEAD unchanged — and restored the tree only after the next prompt was
 * typed. The removal landed in turn 6's window, the restoration in turn 7's:
 * +129/-1059 and then its mirror, both naming eight files of another
 * session's PR (#1676) that neither turn edited.
 *
 * The guards that exist reason about COMMITS in the window (a pull, a
 * checkout of a branch, a merge). A pathspec checkout or `git restore
 * --source` brings no commit into the window, so they see nothing.
 *
 * The test here is content: a file whose bytes at the window START and at the
 * window END are both versions of that path in history reachable from the
 * window start commit was not written by the turn — it was put back. History
 * from the START, never HEAD: work the turn wrote and a later turn committed
 * is in HEAD's history but not in the start's, and must stay.
 *
 * Symmetric by construction: the removal (current → old) and the restoration
 * (old → current) both fail it. Callers exempt files the turn shows it
 * authored (tool calls, edit hooks, commands naming the file, its commits),
 * so an Edit-tool revert stays.
 *
 * A DELETION never qualifies. Every path's creating commit has an all-zero
 * source, so "absent" is a past version of everything; counting it made a
 * turn's own `git rm -r src/legacy && rm NOTES.md` read as a restoration
 * (review of #1684). Only a PRESENT end blob equal to an older version does.
 *
 * The history walk runs only where a row may be REPLACED or EXTENDED: the
 * next prompt's retroactive capture (user-prompt-submit.ts). Stop and
 * session-end re-check rows with `filesPutBackAcrossTheGap`, which needs no
 * history and only fires on the exact straddle shape: a file something
 * rewrote between the previous turn's Stop and this turn's prompt, and that
 * this turn's window ends with back at the previous Stop's bytes. A turn's own
 * `git checkout HEAD~1 -- package.json`, `git revert --no-commit` or
 * `git restore --source=<old> dir` straddles nothing and stays its work.
 *
 * Any failure answers nothing: today's behaviour.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { captureShadowWindow, type ShadowWindowCapture } from './git-capture.js';
import { filesTurnNamedByGitPathspec } from './git-pathspec-names.js';

const HEX = /^[a-fA-F0-9]{7,64}$/;
const ZERO = /^0+$/;
const ABSENT = 'absent';
/** Paths per call; a row larger than this is checked for its first N files. */
const MAX_PATHS = 400;
/** Commits touching those paths walked back from the window start. */
const MAX_COMMITS = 5000;

const READ = { windowsHide: true, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 };

const norm = (f: string) => f.replace(/\\/g, '/');

/** A shadow commit stands for the working tree at a boundary; its history starts at its parent. */
function historyTip(repoPath: string, sha: string): string {
  const record = execFileSync('git', ['show', '-s', '--format=%s%n%P', sha], { ...READ, cwd: repoPath }).trim().split('\n');
  return (record[0] || '').startsWith('origin shadow ') ? ((record[1] || '').split(' ')[0] || '') : sha;
}

/** `<rev>:<path>` blob ids, or ABSENT, in one process — for one rev, or for each of several. */
function blobsAt(repoPath: string, rev: string, files: string[]): Map<string, string>;
function blobsAt(repoPath: string, rev: string[], files: string[]): Array<Map<string, string>>;
function blobsAt(repoPath: string, rev: string | string[], files: string[]): Map<string, string> | Array<Map<string, string>> {
  const revs = Array.isArray(rev) ? rev : [rev];
  const input = revs.flatMap((r) => files.map((f) => `${r}:${f}`)).join('\n') + '\n';
  const lines = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { ...READ, cwd: repoPath, input })
    .split('\n');
  const maps = revs.map((_, r) => {
    const out = new Map<string, string>();
    files.forEach((f, i) => {
      // A missing object prints `<rev>:<path> missing`: never a blob.
      const [oid, type] = (lines[r * files.length + i] || '').trim().split(' ');
      out.set(f, type === 'blob' && oid && HEX.test(oid) ? oid : ABSENT);
    });
    return out;
  });
  return Array.isArray(rev) ? maps : maps[0];
}

/** Blob ids of the working-tree files, or ABSENT, in one process. */
function blobsInWorkingTree(repoPath: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const present: string[] = [];
  for (const f of files) {
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(path.join(repoPath, f)); } catch { st = null; }
    if (!st) out.set(f, ABSENT);
    else if (st.isFile()) present.push(f);
    // A symlink or a directory is not compared: it answers nothing.
  }
  if (present.length > 0) {
    const lines = execFileSync('git', ['hash-object', '--stdin-paths'], { ...READ, cwd: repoPath, input: present.join('\n') + '\n' })
      .split('\n');
    present.forEach((f, i) => {
      const oid = (lines[i] || '').trim();
      if (HEX.test(oid)) out.set(f, oid);
    });
  }
  return out;
}

/**
 * One walk per (repo, tip, path set) per process: a hook run asks the same
 * question for the same window more than once (the replacement path and the
 * extension path at the next prompt), and the walk is the cost — 0.2-0.85 s
 * per call on a 52k-commit repo. Path-limited and capped at MAX_COMMITS.
 */
const historyCache = new Map<string, Map<string, Set<string>>>();

/** Every blob id (and ABSENT, for a creation or deletion) each path had in history. */
function versionsInHistory(repoPath: string, tip: string, files: string[]): Map<string, Set<string>> {
  const key = `${repoPath}\0${tip}\0${[...files].sort().join('\0')}`;
  const cached = historyCache.get(key);
  if (cached) return cached;
  const out = new Map<string, Set<string>>();
  const text = execFileSync('git', [
    '--literal-pathspecs', 'log', '--format=', '--raw', '--no-abbrev', '--no-renames',
    `--max-count=${MAX_COMMITS}`, tip, '--', ...files,
  ], { ...READ, cwd: repoPath });
  for (const line of text.split('\n')) {
    // :100644 100644 <src> <dst> M\t<path>
    if (!line.startsWith(':')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const file = norm(line.slice(tab + 1));
    const parts = line.slice(1, tab).split(' ');
    const src = parts[2] || '';
    const dst = parts[3] || '';
    let set = out.get(file);
    if (!set) { set = new Set(); out.set(file, set); }
    set.add(ZERO.test(src) ? ABSENT : src);
    set.add(ZERO.test(dst) ? ABSENT : dst);
  }
  if (historyCache.size > 32) historyCache.clear();
  historyCache.set(key, out);
  return out;
}

/** Test seam: forget the per-process history walks. */
export function clearHistoryCache(): void {
  historyCache.clear();
}

/**
 * Files among `files` whose content at `startSha` and at `endSha` (the live
 * working tree when null) are both versions of that path in history reachable
 * from the window start. Paths are repo-relative to `repoPath`.
 */
export function filesRestoredFromHistory(
  repoPath: string,
  startSha: string,
  endSha: string | null,
  files: string[],
  /**
   * Blob ids the caller already read for these files at the start and end, and
   * the history tip when it is known — each saves a git process.
   */
  known?: { start?: Map<string, string>; end?: Map<string, string>; tip?: string },
): Set<string> {
  const restored = new Set<string>();
  try {
    if (!repoPath || !startSha || !HEX.test(startSha) || (endSha && !HEX.test(endSha))) return restored;
    const paths = [...new Set(files.filter((f) => typeof f === 'string' && f && !path.isAbsolute(f)).map(norm))]
      .slice(0, MAX_PATHS);
    if (paths.length === 0) return restored;
    const tip = known?.tip || historyTip(repoPath, startSha);
    if (!HEX.test(tip)) return restored;
    const start = known?.start && paths.every((f) => known.start!.has(f)) ? known.start : blobsAt(repoPath, startSha, paths);
    const end = known?.end && paths.every((f) => known.end!.has(f))
      ? known.end
      : (endSha ? blobsAt(repoPath, endSha, paths) : blobsInWorkingTree(repoPath, paths));
    // An absent end is a deletion: the turn's work, never a restoration.
    const moved = paths.filter((f) => end.has(f) && end.get(f) !== ABSENT && start.get(f) !== end.get(f));
    if (moved.length === 0) return restored;
    const history = versionsInHistory(repoPath, tip, moved);
    for (const f of moved) {
      const versions = history.get(f);
      if (versions && versions.has(start.get(f)!) && versions.has(end.get(f)!)) restored.add(f);
    }
    return restored;
  } catch {
    return new Set();
  }
}

// ─── The tree a closed turn ended with ─────────────────────────────────────

type EndShadowState = {
  gitPathspecsByTurn?: Array<{ promptIndex: number; paths: string[] }>;
  promptShadows?: Array<{ promptIndex: number; shadowSha: string; completeBaseline?: boolean }>;
  turnEndShadows?: Array<{ promptIndex: number; shadowSha: string; capturedAt: string; completeBaseline?: boolean; lateFiles?: string[] }>;
};

/**
 * Files among `files` that LOCAL turn `localTurn`'s window only put back
 * across the gap before it: something rewrote them between the previous
 * turn's Stop (its recorded end tree) and this turn's start shadow, and the
 * window ends (`endSha`, or the live tree when null) with them back at the
 * previous Stop's bytes. Session 874ff028 turn 7: the background job's
 * restoration of `packages/cli/src` after the next prompt was typed.
 *
 * No history walk, and nothing without a recorded previous end: a turn that
 * checks out, reverts or deletes files itself straddles no gap. A deletion
 * never qualifies. Any failure answers nothing.
 */
export function filesPutBackAcrossTheGap(
  repoPath: string,
  state: EndShadowState,
  localTurn: number,
  startSha: string,
  endSha: string | null,
  files: string[],
): Set<string> {
  const out = new Set<string>();
  try {
    if (!repoPath || !Number.isInteger(localTurn) || localTurn < 1 || !startSha || !HEX.test(startSha)) return out;
    if (endSha && !HEX.test(endSha)) return out;
    const prev = (state.turnEndShadows || []).find((s) => s.promptIndex === localTurn - 1);
    if (!prev?.shadowSha || !HEX.test(prev.shadowSha) || prev.shadowSha === startSha) return out;
    const paths = [...new Set(files.filter((f) => typeof f === 'string' && f && !path.isAbsolute(f)).map(norm))]
      .slice(0, MAX_PATHS);
    if (paths.length === 0) return out;
    const both = blobsAt(repoPath, [prev.shadowSha, startSha], paths);
    const before = both[0];
    const start = both[1];
    const rewritten = paths.filter((f) => before.get(f) !== start.get(f) && before.get(f) !== ABSENT);
    if (rewritten.length === 0) return out;
    const end = endSha ? blobsAt(repoPath, endSha, rewritten) : blobsInWorkingTree(repoPath, rewritten);
    // A file this turn's own git command named (`git checkout -- config.py`
    // of the user's between-turn edit) is the turn's revert, not a restoration.
    const named = filesTurnNamedByGitPathspec(state, localTurn, rewritten);
    for (const f of rewritten) if (end.get(f) === before.get(f) && !named.has(f)) out.add(f);
    return out;
  } catch {
    return new Set();
  }
}

// ─── Work a closed turn's background job finished after its Stop ───────────

function diffSections(diff: string | null | undefined): Array<{ file: string | null; text: string }> {
  return String(diff || '').split(/(?=^diff --git )/m).map((text) => {
    const m = text.match(/^diff --git a\/(.*?) b\/(.*)$/m);
    return { file: m ? norm(m[2] || m[1]) : null, text };
  });
}

function sectionsFor(diff: string | null | undefined, files: Set<string>): string {
  return diffSections(diff).filter((s) => s.file && files.has(s.file)).map((s) => s.text).join('');
}

function countLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

export interface LateWorkRow {
  filesChanged?: unknown;
  diff?: string;
  uncommittedDiff?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  chatOnly?: boolean;
  contentUnavailableFiles?: string[];
}

function rowFileSet(row: LateWorkRow | undefined): Set<string> {
  const out = new Set<string>();
  if (!row) return out;
  if (Array.isArray(row.filesChanged)) for (const f of row.filesChanged) if (typeof f === 'string' && f) out.add(norm(f));
  for (const s of diffSections(row.diff)) if (s.file) out.add(s.file);
  for (const s of diffSections(row.uncommittedDiff)) if (s.file) out.add(s.file);
  for (const f of row.contentUnavailableFiles || []) if (typeof f === 'string' && f) out.add(norm(f));
  return out;
}

/**
 * Replace (or append) each of `files`' sections in `diff` with its section in
 * `from`. Returns the new text and the line delta against the sections it
 * replaced.
 */
function spliceSections(
  diff: string | null | undefined,
  from: string | null | undefined,
  files: Set<string>,
): { text: string; added: number; removed: number } {
  const incoming = sectionsFor(from, files);
  const kept: string[] = [];
  let oldAdded = 0;
  let oldRemoved = 0;
  for (const s of diffSections(diff)) {
    if (s.file && files.has(s.file)) {
      const c = countLines(s.text);
      oldAdded += c.added;
      oldRemoved += c.removed;
    } else {
      kept.push(s.text);
    }
  }
  const base = kept.join('');
  const n = countLines(incoming);
  return {
    text: base && incoming && !base.endsWith('\n') ? `${base}\n${incoming}` : `${base}${incoming}`,
    added: n.added - oldAdded,
    removed: n.removed - oldRemoved,
  };
}

/**
 * At the next prompt, for LOCAL turn `localTurn` that Stop closed: EXTEND
 * Stop's row with what the turn's background job changed after that Stop.
 * Stop's row is final against being replaced wholesale (session 874ff028), not
 * against being extended — `sleep 2 && ./gen.sh > src/gen_client.py` fires no
 * hook, and the next turn's start shadow is cut after the write, so without
 * this the work belongs to no turn (review of #1684).
 *
 * A file qualifies when all of these hold:
 *   - it differs between the tree Stop recorded and the live tree;
 *   - it differs between the turn's start and the live tree (a change the job
 *     undid is nothing);
 *   - it is not a restoration: its live bytes are not an older version history
 *     reachable from Stop's tree already had (the pathspec checkout of an older
 *     main stays out);
 *   - nothing else claims it (`excluded`): a foreign commit's files, another
 *     live session's writes in this checkout, pre-existing dirt.
 *
 * A qualifying file Stop's row did not name is added; one it did name has its
 * section re-measured from the turn's start to the live tree (`./gen.sh >>
 * src/mine.py` after Stop is +11, as on main). Every other file keeps Stop's
 * section. `filesChanged`, the diff and the line counts move together.
 *
 * `windowDiff` is the turn-start → live-tree diff when the caller already has
 * it (the retroactive capture does), which saves a working-tree snapshot.
 * The files are recorded on the turn's end entry (`lateFiles`) so later Stops
 * re-derive them the same way (`turnWindowLateWork`). Returns the files added
 * or re-measured. Never throws.
 */
export function extendClosedTurnWithLateWork(
  repoPath: string,
  state: EndShadowState,
  localTurn: number,
  row: LateWorkRow | undefined,
  opts: {
    excluded?: Iterable<string>;
    windowDiff?: string;
    log?: (event: string, data: Record<string, unknown>) => void;
  } = {},
): string[] {
  try {
    const endEntry = (state.turnEndShadows || []).find((s) => s.promptIndex === localTurn);
    const start = (state.promptShadows || []).find((s) => s.promptIndex === localTurn);
    if (!repoPath || !row || !endEntry?.shadowSha || !start?.shadowSha) return [];
    if (!HEX.test(endEntry.shadowSha) || !HEX.test(start.shadowSha)) return [];
    if (start.completeBaseline === false || endEntry.completeBaseline === false) return [];
    let windowText = opts.windowDiff;
    if (typeof windowText !== 'string') {
      const win = captureShadowWindow(repoPath, start.shadowSha, null, { completeBaseline: start.completeBaseline });
      if (win.status !== 'changed') return [];
      windowText = win.diff;
    }
    const windowFiles = [...new Set(diffSections(windowText).map((x) => x.file).filter((f): f is string => !!f))]
      .filter((f) => !path.isAbsolute(f));
    if (windowFiles.length === 0) return [];
    const excluded = new Set([...(opts.excluded || [])].map(norm));
    const ask = windowFiles.filter((f) => !excluded.has(f)).slice(0, MAX_PATHS);
    const skipped = windowFiles.filter((f) => excluded.has(f));
    if (ask.length === 0) return [];
    const [atStop, atStart] = blobsAt(repoPath, [endEntry.shadowSha, start.shadowSha], ask);
    const live = blobsInWorkingTree(repoPath, ask);
    const candidates = ask.filter((f) => atStop.get(f) !== live.get(f) && atStart.get(f) !== live.get(f));
    if (candidates.length === 0) return [];
    const stopFiles = rowFileSet(row);
    if (skipped.length > 0) {
      opts.log?.('files another claimant owns not added to the closed turn', {
        localTurn, files: skipped.slice(0, 20), count: skipped.length,
      });
    }
    // History from Stop's tree itself: its own commit adds only the blobs Stop
    // saw, which a candidate (moved after Stop) cannot equal, and it saves the
    // shadow-parent lookup.
    const restored = filesRestoredFromHistory(repoPath, endEntry.shadowSha, null, candidates, {
      start: atStop, end: live, tip: endEntry.shadowSha,
    });
    if (restored.size > 0) {
      opts.log?.('files changed after Stop only restored from history — not added', {
        localTurn, files: [...restored].slice(0, 20), count: restored.size,
      });
    }
    const late = candidates.filter((f) => !restored.has(f));
    if (late.length === 0) return [];

    const lateSet = new Set(late);
    const d = spliceSections(row.diff, windowText, lateSet);
    row.diff = d.text;
    if (typeof row.uncommittedDiff === 'string' && diffSections(row.uncommittedDiff).some((x) => x.file && lateSet.has(x.file))) {
      // The same file's section in the uncommitted half would be Stop's stale
      // view of it; the diff above now carries the file.
      row.uncommittedDiff = diffSections(row.uncommittedDiff).filter((x) => !(x.file && lateSet.has(x.file))).map((x) => x.text).join('');
    }
    const files = Array.isArray(row.filesChanged) ? row.filesChanged.filter((f): f is string => typeof f === 'string') : [];
    const added = late.filter((f) => !stopFiles.has(f));
    const remeasured = late.filter((f) => stopFiles.has(f));
    row.filesChanged = [...files, ...added.filter((f) => !files.includes(f))];
    row.linesAdded = Math.max(0, (Number(row.linesAdded) || 0) + d.added);
    row.linesRemoved = Math.max(0, (Number(row.linesRemoved) || 0) + d.removed);
    if (Array.isArray(row.contentUnavailableFiles)) row.contentUnavailableFiles = row.contentUnavailableFiles.filter((f) => !lateSet.has(norm(f)));
    delete row.chatOnly;
    endEntry.lateFiles = [...new Set([...(endEntry.lateFiles || []), ...late])].sort();
    opts.log?.('files a background job changed after Stop added to the closed turn', {
      localTurn, added: added.slice(0, 20), remeasured: remeasured.slice(0, 20), count: late.length,
      linesAdded: d.added, linesRemoved: d.removed,
    });
    return late;
  } catch {
    return [];
  }
}

/**
 * Where LOCAL turn `localTurn`'s late work ends: the next turn's start shadow,
 * for the files `extendClosedTurnWithLateWork` added. Undefined when there are
 * none, or no next turn yet.
 */
export function turnWindowLateWork(
  state: EndShadowState,
  localTurn: number,
): { files: string[]; shadowSha: string; completeBaseline?: boolean } | undefined {
  const entry = (state.turnEndShadows || []).find((s) => s.promptIndex === localTurn);
  if (!entry?.shadowSha || !Array.isArray(entry.lateFiles) || entry.lateFiles.length === 0) return undefined;
  const next = (state.promptShadows || []).find((s) => s.promptIndex === localTurn + 1);
  if (!next?.shadowSha) return undefined;
  return { files: entry.lateFiles, shadowSha: next.shadowSha, completeBaseline: next.completeBaseline };
}

/**
 * A closed turn's window (start → Stop's tree) with each late file's section
 * taken from its late window (start → the next turn's start): added when the
 * first window does not name it, re-measured when it does.
 */
export function withLateWork(
  win: ShadowWindowCapture,
  late: ShadowWindowCapture,
  lateFiles: string[],
): ShadowWindowCapture {
  const lateHas = new Set(late.filesChanged.map(norm));
  const want = new Set(lateFiles.map(norm).filter((f) => lateHas.has(f)));
  if (want.size === 0) return win;
  const changed = win.status === 'changed';
  const d = spliceSections(changed ? win.diff : '', late.diff, want);
  const files = changed ? win.filesChanged : [];
  const have = new Set(files.map(norm));
  return {
    status: 'changed',
    diff: d.text,
    filesChanged: [...files, ...[...want].filter((f) => !have.has(f))],
    linesAdded: Math.max(0, (changed ? win.linesAdded : 0) + d.added),
    linesRemoved: Math.max(0, (changed ? win.linesRemoved : 0) + d.removed),
  };
}

/** Stop closed LOCAL turn `localIndex` with the tree at `shadowSha`. Latest Stop wins. */
export function recordTurnEndShadow(
  state: EndShadowState,
  localIndex: number,
  shadowSha: string | null | undefined,
  opts?: { completeBaseline?: boolean; now?: () => string },
): void {
  if (!shadowSha || !HEX.test(shadowSha) || !Number.isInteger(localIndex) || localIndex < 0) return;
  const entry = {
    promptIndex: localIndex,
    shadowSha,
    capturedAt: (opts?.now ?? (() => new Date().toISOString()))(),
    ...(opts?.completeBaseline !== undefined ? { completeBaseline: opts.completeBaseline } : {}),
  };
  state.turnEndShadows = [...(state.turnEndShadows || []).filter((s) => s.promptIndex !== localIndex), entry];
}

/**
 * At the next prompt: a turn Stop closed keeps its end; a turn agent activity
 * re-opened after that Stop (and no Stop closed again) ended somewhere later
 * that nobody recorded, so its end falls back to the next prompt's shadow.
 */
export function settleTurnEndShadow(state: EndShadowState, localIndex: number, closedByStop: boolean): void {
  if (closedByStop || !Array.isArray(state.turnEndShadows)) return;
  state.turnEndShadows = state.turnEndShadows.filter((s) => s.promptIndex !== localIndex);
}

/**
 * Where LOCAL turn `localIndex`'s window ends: the tree its Stop closed with,
 * once the next turn has started; else the next turn's start shadow; else
 * undefined (the turn is still in flight). A recorded end is ignored while no
 * next turn exists, so a re-opened turn's re-Stop never reads a stale end.
 */
export function turnWindowEndShadow(
  state: EndShadowState,
  localIndex: number,
): { shadowSha: string; completeBaseline?: boolean } | undefined {
  const next = (state.promptShadows || []).find((s) => s.promptIndex === localIndex + 1);
  if (!next) return undefined;
  const end = (state.turnEndShadows || []).find((s) => s.promptIndex === localIndex);
  return end?.shadowSha ? end : next;
}

/** No agent activity since Stop closed LOCAL turn `localIndex`. */
export function turnClosedByStop(
  state: { activeTurn?: { index: number } | null; lastClosedTurnIndex?: number },
  localIndex: number,
): boolean {
  return !state.activeTurn
    && Number.isInteger(state.lastClosedTurnIndex as number)
    && (state.lastClosedTurnIndex as number) >= localIndex;
}
