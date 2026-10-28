// ---------------------------------------------------------------------------
// Origin CLI — commit-coordinate line claims for the canonical attribution record
// ---------------------------------------------------------------------------
// Attribution record v1.0 can say WHICH lines of a commit a contribution wrote:
// `contributions[].files[].ranges[]`, inclusive and 1-based in the tree of that
// commit. This module computes those ranges and nothing else. It writes no
// note, touches no state and calls no API; the writer decides what to do with
// an empty answer (stay commit-level).
//
// A line is claimed only when two independent facts agree (OR-43, section 6):
//
//   1. replaying the turns' own edit records over the commit's PARENT blob
//      says one of those turns wrote this line, and the line reaches the
//      commit's blob — at the same place when the replay reproduces the blob
//      byte for byte, or, when someone else also changed the file, at the one
//      blob line that every optimal line alignment pairs it with; and
//   2. git's own diff of the commit says this line is a new-side addition.
//
// Claims are partial by contract: a line left out is not thereby human.
//
// Positions are recomputed against the commit every time. `PromptEdit.oldStart`
// / `newStart` are best-effort content searches made at a different moment in
// the file's life, so they are never read here. Neither are added/removed line
// counts: a range must never be derived from diff totals.
//
// Everything degrades. A line another writer replaced, or one repeated content
// makes ambiguous, is dropped alone. An edit the evidence policy does not
// admit, an edit that matches the replay state twice, a replay none of whose
// lines reach the commit's blob, a binary or oversized file — each drops that
// FILE with a short reason (no source text, no prompt text), and the other
// files still project.
//
// Time is bounded too. A caller may pass one absolute deadline for its whole
// projection (ProjectionDeadline): every git subprocess gets only what is left
// of it, and the replay and alignment loops check it as they go. Expiry drops
// the whole commit with `timeout` — never a partial set of files.
// ---------------------------------------------------------------------------

import { readFileAtRev, isUnsafeGitShowPath } from './git-capture.js';
import { parseUnifiedZero } from './final-state-blame.js';
import { mandatoryAlignment } from './line-alignment.js';
import { gitOrNull, git } from './utils/exec.js';
import type { PromptEdit, PromptEditEvidence } from './prompt-capture/types.js';

/** How the commit was tied to this session's turns, strongest first. */
export type CommitBindingSource = 'post-commit' | 'trailer' | 'transcript' | 'inferred';

/** Why a file (or the whole commit) produced no line claim. Never carries content. */
export type ProjectionDropReason =
  | 'no_attested_binding'
  | 'bound_to_other_commit'
  | 'merge_commit'
  | 'inference_only'
  | 'weak_evidence'
  | 'competing_session'
  | 'path_only_edit'
  | 'capture_truncated'
  | 'commit_unreadable'
  | 'unsafe_path'
  | 'notebook'
  | 'binary_or_unreadable'
  | 'oversized'
  | 'conflicting_owner'
  | 'ambiguous_replay'
  | 'replay_mismatch'
  | 'not_new_side'
  | 'possible_rename'
  | 'timeout';

export interface ProjectionDiagnostic {
  reason: ProjectionDropReason;
  /** The repo-relative path concerned; absent for a commit-wide reason. */
  path?: string;
}

/** One prompt's edits, in the order the prompt made them. */
export interface CapturedTurn {
  /** Orders turns within the session; replay follows it. */
  promptIndex: number;
  /**
   * The contribution iteration this turn is, when the caller has PROVEN it.
   * Absent means "this session, prompt unknown": ranges then omit
   * `iteration_index` rather than guess one.
   */
  iterationIndex?: number;
  edits: PromptEdit[];
  /** The turn's edit list was cut (the notes' 16 KiB `editsJson` cap). */
  truncated?: boolean;
}

export interface ProjectedLineRange {
  start_line: number;
  end_line: number;
  iteration_index?: number;
}

export interface ProjectedLineFile {
  path: string;
  ranges: ProjectedLineRange[];
}

export interface CommitLineProjection {
  files: ProjectedLineFile[];
  diagnostics: ProjectionDiagnostic[];
}

// Bounds per file. Past them the file is dropped, never truncated: a cut file
// cannot be checked against the commit blob. The line bound matches
// `lineLevelDiff` (transcript.ts), which stops aligning past it. Exported so a
// reader of these claims (attribution-line-reanchor.ts) is never looser.
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILE_LINES = 4000;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// ─── Wall-clock budget ──────────────────────────────────────────────────────

/** One absolute expiry shared by every step of a writer's projection. */
export interface ProjectionDeadline {
  /** When the budget runs out, in the units of `now`. */
  readonly at: number;
  readonly now: () => number;
}

export class ProjectionTimeout extends Error {
  constructor() {
    super('line projection deadline expired');
  }
}

export function createProjectionDeadline(budgetMs: number, now: () => number = () => performance.now()): ProjectionDeadline {
  return { at: now() + budgetMs, now };
}

/** Throws ProjectionTimeout once the deadline has passed. No deadline: never. */
export function checkDeadline(deadline: ProjectionDeadline | undefined): void {
  if (deadline && deadline.now() >= deadline.at) throw new ProjectionTimeout();
}

/** The timeout for one git subprocess: what is left of the deadline, at most `capMs`. */
export function gitTimeoutMs(deadline: ProjectionDeadline | undefined, capMs: number): number {
  if (!deadline) return capMs;
  const left = Math.floor(deadline.at - deadline.now());
  if (left <= 0) throw new ProjectionTimeout();
  return Math.min(capMs, left);
}

// ─── Evidence admission ─────────────────────────────────────────────────────

/**
 * Which kind of proof admitted an edit. Kept internal to the producer: the v1
 * record has no field for it (OR-43, decision 6).
 */
export type LineClaimTier = 'tool_call' | 'commit_patch' | 'scoped' | 'ambiguous';

export interface LineClaimAdmissionContext {
  /** The commit being projected (full SHA). */
  commitSha: string;
  /** How this session is tied to the commit; null when nothing ties it. */
  binding: CommitBindingSource | null;
  /** The commit has two or more parents. */
  isMerge: boolean;
  /**
   * The caller proved no other session contributed this file to this commit.
   * Unknown must be passed as false.
   */
  soleSessionForFile: boolean;
}

export type LineClaimAdmission =
  | { admitted: true; tier: LineClaimTier }
  | { admitted: false; reason: ProjectionDropReason };

/** `stamp` names `target`: the full SHA, or an abbreviation of at least 7 hex digits. */
function namesCommit(stamp: string, target: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(stamp) && target.toLowerCase().startsWith(stamp.toLowerCase());
}

function isAttested(binding: CommitBindingSource | null): boolean {
  return binding === 'post-commit' || binding === 'trailer';
}

/** Content a replay can apply. A path-only record (the Copilot watcher fallback) has none. */
function hasReplayableContent(edit: PromptEdit): boolean {
  if (edit.op === 'delete' || edit.op === 'rename') return true;
  return typeof edit.newContent === 'string';
}

/**
 * The one definition of which captured edits may open a canonical line claim
 * (OR-43 section 5, conservative reading). Admission is necessary, not
 * sufficient: an admitted edit still has to replay onto the commit's blob.
 *
 *   • `turn_window` — inference; never.
 *   • no content, or content Origin back-filled (`backfillSource`) — a
 *     path-only record; never.
 *   • `source: 'commit'` — the commit patch itself: only for this commit, only
 *     when the binding is attested, never for a merge (the first-parent patch
 *     carries the merged branch's lines too).
 *   • `tool_call` (or a tool-call source with no evidence recorded, which is
 *     what transcript extraction writes) — with an attested binding; with a
 *     transcript binding only when no other session touched the file. Allowed
 *     on a merge, where only an exact replay from the first parent proves it.
 *   • `edit_hook`, `command_named` — as `tool_call`, but not on a merge.
 *   • `command_probe`, `write_journal` — only with an attested binding AND no
 *     competing session for the file.
 *   • an `inferred` (file-overlap arithmetic) binding unlocks nothing.
 *   • any edit stamped with ANOTHER commit's SHA, whatever its source: one
 *     prompt can produce several commits, and replaying commit A's edit while
 *     projecting commit B would only make B's replay fail. An unstamped edit is
 *     not assumed to be this commit's; it goes through the rules above.
 */
export function admitEditForLineClaim(edit: PromptEdit, ctx: LineClaimAdmissionContext): LineClaimAdmission {
  const reject = (reason: ProjectionDropReason): LineClaimAdmission => ({ admitted: false, reason });
  const admit = (tier: LineClaimTier): LineClaimAdmission => ({ admitted: true, tier });

  if (edit.commitSha && !namesCommit(edit.commitSha, ctx.commitSha)) return reject('bound_to_other_commit');
  if (edit.evidence === 'turn_window') return reject('inference_only');
  // Content Origin recovered for the edit (a commit blob, the live file, a
  // working-tree window re-homed onto this turn) is not content the agent
  // sent: replaying it proves only that the commit equals itself.
  if (edit.backfillSource) return reject('path_only_edit');
  if (!hasReplayableContent(edit)) return reject('path_only_edit');
  if (ctx.binding === null || ctx.binding === 'inferred') return reject('no_attested_binding');
  const attested = isAttested(ctx.binding);

  if (edit.source === 'commit') {
    if (ctx.isMerge) return reject('merge_commit');
    if (!attested) return reject('no_attested_binding');
    if (!edit.commitSha || edit.commitSha.toLowerCase() !== ctx.commitSha.toLowerCase()) {
      return reject('bound_to_other_commit');
    }
    return admit('commit_patch');
  }

  const evidence: PromptEditEvidence | undefined =
    edit.evidence ?? (edit.source === 'tool_call' ? 'tool_call' : undefined);
  switch (evidence) {
    case 'tool_call':
      if (attested || ctx.soleSessionForFile) return admit('tool_call');
      return reject('competing_session');
    case 'edit_hook':
    case 'command_named':
      if (ctx.isMerge) return reject('merge_commit');
      if (attested || ctx.soleSessionForFile) return admit('scoped');
      return reject('competing_session');
    case 'command_probe':
    case 'write_journal':
      if (ctx.isMerge) return reject('merge_commit');
      if (!attested) return reject('no_attested_binding');
      if (!ctx.soleSessionForFile) return reject('competing_session');
      return admit('ambiguous');
    default:
      return reject('weak_evidence');
  }
}

// ─── The commit's own diff ──────────────────────────────────────────────────

export interface CommitFileDiff {
  /** New-side path; null for a deletion or a header that could not be read. */
  path: string | null;
  /** Old-side path; null for an addition. Differs from `path` on a rename. */
  oldPath: string | null;
  /** Binary content, a symlink or a submodule: no source lines to claim. */
  nonText: boolean;
  /** A quoted (escaped) path git would not print plainly. */
  unparseable: boolean;
  /** 1-based new-side line numbers this commit added to `path`. */
  addedLines: Set<number>;
}

function unprefix(raw: string, prefix: 'a/' | 'b/'): { path: string | null; quoted: boolean } {
  // A path with spaces gets a trailing tab on `---`/`+++` from some gits.
  const value = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (value === '/dev/null') return { path: null, quoted: false };
  if (value.startsWith('"')) return { path: null, quoted: true };
  return value.startsWith(prefix) ? { path: value.slice(prefix.length), quoted: false } : { path: null, quoted: true };
}

/** `diff --git a/P b/P`: recover P when both sides name the same path. */
function samePathFromHeader(header: string): string | null {
  const rest = header.slice('diff --git '.length);
  if ((rest.length - 5) % 2 !== 0) return null;
  const p = rest.slice(2, 2 + (rest.length - 5) / 2);
  return rest === `a/${p} b/${p}` ? p : null;
}

/**
 * Split a multi-file `-U0` patch (as printed by `git diff-tree -p -U0 -M`) into
 * one entry per file with its new-side added lines. Hunk bodies are read by the
 * shared `parseUnifiedZero`; this only reads the per-file headers that it does
 * not: renames, deletions, binaries and file modes.
 */
export function parseCommitPatch(patch: string): CommitFileDiff[] {
  const out: CommitFileDiff[] = [];
  for (const section of (patch || '').split(/^(?=diff --git )/m)) {
    if (!section.startsWith('diff --git ')) continue;
    const lines = section.split('\n');
    const headerEnd = lines.findIndex((l) => l.startsWith('@@'));
    const header = headerEnd < 0 ? lines : lines.slice(0, headerEnd);

    let oldPath: string | null = null;
    let newPath: string | null = null;
    let sawOld = false;
    let sawNew = false;
    let unparseable = false;
    let nonText = false;
    let added = false;
    let deleted = false;
    for (const l of header) {
      if (l.startsWith('--- ')) {
        const r = unprefix(l.slice(4), 'a/');
        oldPath = r.path; sawOld = true; unparseable ||= r.quoted;
      } else if (l.startsWith('+++ ')) {
        const r = unprefix(l.slice(4), 'b/');
        newPath = r.path; sawNew = true; unparseable ||= r.quoted;
      } else if (l.startsWith('rename from ')) {
        oldPath = l.slice('rename from '.length); sawOld = true; unparseable ||= oldPath.startsWith('"');
      } else if (l.startsWith('rename to ')) {
        newPath = l.slice('rename to '.length); sawNew = true; unparseable ||= newPath.startsWith('"');
      } else if (l.startsWith('new file mode ')) {
        added = true;
      } else if (l.startsWith('deleted file mode ')) {
        deleted = true;
      } else if (l.startsWith('Binary files ') || l === 'GIT binary patch') {
        nonText = true;
      }
      // A symlink (120000) or a submodule (160000) on either side.
      if (/^(?:new file mode|deleted file mode|old mode|new mode|index \S+) 1[26]0000$/.test(l)) nonText = true;
    }
    // A binary, a mode change or an empty file prints no `---`/`+++`.
    if (!sawOld || !sawNew) {
      const same = samePathFromHeader(lines[0]);
      if (!same) unparseable = true;
      if (!sawOld) oldPath = added ? null : same;
      if (!sawNew) newPath = deleted ? null : same;
    }
    if (unparseable) { oldPath = null; newPath = null; }

    const addedLines = new Set<number>();
    if (!nonText && newPath !== null) {
      for (const h of parseUnifiedZero(section)) for (const a of h.added) addedLines.add(a.line);
    }
    out.push({ path: newPath, oldPath, nonText, unparseable, addedLines });
  }
  return out;
}

// ─── Replay with ownership ──────────────────────────────────────────────────

/**
 * A file's text as lines, keeping the piece after the last newline (empty for a
 * file that ends in one), so `lines.join('\n')` gives back the exact bytes.
 */
interface ReplayState {
  lines: string[];
  /** Index into the sorted turns of the line's writer; null for inherited lines. */
  owners: Array<number | null>;
}

type ReplayStep = { ok: true } | { ok: false; reason: 'ambiguous_replay' | 'replay_mismatch' };

function stateOf(text: string): ReplayState {
  const lines = text.split('\n');
  return { lines, owners: lines.map(() => null) };
}

type LineOp = { type: 'context' | 'add' | 'remove'; line: string };

/**
 * `lineLevelDiff` (transcript.ts), op for op — the same LCS, the same
 * tie-break, the same all-remove/all-add answer past MAX_FILE_LINES — over
 * Uint16 tables of interned lines, checking `deadline` once per row so one
 * 4000×4000 alignment cannot outlive the writer's budget.
 */
function alignLines(oldLines: string[], newLines: string[], deadline: ProjectionDeadline | undefined): LineOp[] {
  const m = oldLines.length;
  const n = newLines.length;
  if (m > MAX_FILE_LINES || n > MAX_FILE_LINES) {
    return [
      ...oldLines.map((line) => ({ type: 'remove' as const, line })),
      ...newLines.map((line) => ({ type: 'add' as const, line })),
    ];
  }
  const ids = new Map<string, number>();
  const idOf = (line: string) => { let id = ids.get(line); if (id === undefined) ids.set(line, id = ids.size); return id; };
  const oi = Int32Array.from(oldLines, idOf);
  const ni = Int32Array.from(newLines, idOf);
  // dp[i][j] = LCS length of oldLines[i..] and newLines[j..]
  const w = n + 1;
  const dp = new Uint16Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    checkDeadline(deadline);
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] = oi[i] === ni[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oi[i] === ni[j]) {
      ops.push({ type: 'context', line: oldLines[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ type: 'remove', line: oldLines[i++] });
    } else {
      ops.push({ type: 'add', line: newLines[j++] });
    }
  }
  while (i < m) ops.push({ type: 'remove', line: oldLines[i++] });
  while (j < n) ops.push({ type: 'add', line: newLines[j++] });
  return ops;
}

/**
 * Replace lines [at, at+count) with `replacement`. An LCS between the two keeps
 * untouched lines with their earlier owner, so a whole-file rewrite does not
 * re-credit the lines it left alone (the same rule as edit-replay-map.ts).
 */
function replaceBlock(
  s: ReplayState, at: number, count: number, replacement: string[], owner: number, deadline: ProjectionDeadline | undefined,
): void {
  const removedOwners = s.owners.slice(at, at + count);
  const nextLines: string[] = [];
  const nextOwners: Array<number | null> = [];
  let oi = 0;
  for (const op of alignLines(s.lines.slice(at, at + count), replacement, deadline)) {
    if (op.type === 'context') {
      nextLines.push(op.line);
      nextOwners.push(removedOwners[oi++] ?? null);
    } else if (op.type === 'remove') {
      oi++;
    } else {
      nextLines.push(op.line);
      nextOwners.push(owner);
    }
  }
  s.lines.splice(at, count, ...nextLines);
  s.owners.splice(at, count, ...nextOwners);
}

function countOccurrences(haystack: string, needle: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    if (first < 0) first = i;
    if (++count > 1) break;
  }
  return { count, first };
}

function lineOfOffset(text: string, offset: number): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * Apply one edit the way the agent's tool did: `oldContent` is a substring that
 * must occur exactly ONCE in the replayed text (a second match means we cannot
 * know which one was edited), and is swapped for `newContent`. Ownership is then
 * carried at line granularity over the lines the substring spans.
 *
 * A whole-file replacement (`write`, `create`, or any edit with no anchor) is
 * proven only against the exact state it replaced. The agent may have read a
 * file that already held a human's, another session's or an earlier turn's
 * uncommitted lines and written them back with its own: aligning its content
 * against the parent would hand it all of them. So:
 *
 *   • no captured pre-image over a non-empty state — `ambiguous_replay`;
 *   • a captured pre-image that is not byte for byte the whole state —
 *     `replay_mismatch` (never a substring search);
 *   • only then is the state replaced, keeping the owners of lines it left
 *     alone. An empty state needs no pre-image: a new or emptied file.
 */
function applyEdit(s: ReplayState, edit: PromptEdit, owner: number, deadline: ProjectionDeadline | undefined): ReplayStep {
  if (edit.op === 'rename') return { ok: true }; // content moves with the lineage
  if (edit.op === 'delete') {
    s.lines = [''];
    s.owners = [null];
    return { ok: true };
  }
  const text = s.lines.join('\n');
  const before = typeof edit.oldContent === 'string' ? edit.oldContent : '';
  const after = String(edit.newContent ?? '');

  if (edit.op === 'write' || edit.op === 'create' || before === '') {
    if (before === '' && text !== '') return { ok: false, reason: 'ambiguous_replay' };
    if (before !== text) return { ok: false, reason: 'replay_mismatch' };
    replaceBlock(s, 0, s.lines.length, after.split('\n'), owner, deadline);
    return { ok: true };
  }

  const { count, first } = countOccurrences(text, before);
  if (count === 0) return { ok: false, reason: 'replay_mismatch' };
  if (count > 1) return { ok: false, reason: 'ambiguous_replay' };

  const nextText = text.slice(0, first) + after + text.slice(first + before.length);
  const nextLines = nextText.split('\n');
  const a = lineOfOffset(text, first);
  const b = Math.min(lineOfOffset(text, first + before.length), s.lines.length - 1);
  const tail = s.lines.length - 1 - b; // lines after the edit, unchanged
  replaceBlock(s, a, b - a + 1, nextLines.slice(a, nextLines.length - tail), owner, deadline);
  return { ok: true };
}

export function withinBounds(text: string): boolean {
  if (text.length > MAX_FILE_BYTES) return false;
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (++lines > MAX_FILE_LINES + 1) return false;
  }
  return true;
}

// ─── The projector ──────────────────────────────────────────────────────────

/** Mirrors the schema's `repo_path` so a claim never fails validation on its path. */
export function isCanonicalRepoPath(p: string): boolean {
  if (!p || p.length > 4096 || isUnsafeGitShowPath(p)) return false;
  if (p.endsWith('/') || p.includes('//') || p.includes('\\')) return false;
  if (/[\u0000-\u001f]/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '.' || seg === '..');
}

function normalizePath(p: string | undefined): string {
  return String(p ?? '').replace(/\\/g, '/');
}

interface AdmittedEdit {
  edit: PromptEdit;
  tier: LineClaimTier;
  turn: number; // index into the sorted turns
  seq: number;  // capture order, for a stable sort within a turn
}

export interface ProjectCommitLineClaimsInput {
  repoPath: string;
  /** Full SHA of the commit to project. */
  commitSha: string;
  /** This session's turns bound to the commit. Order does not matter. */
  turns: CapturedTurn[];
  /** How the session is tied to the commit; null when nothing ties it. */
  binding: CommitBindingSource | null;
  /** Files for which the caller proved this is the only contributing session. */
  soleSessionFiles?: ReadonlySet<string>;
  /** The caller's budget; on expiry the commit projects nothing (`timeout`). */
  deadline?: ProjectionDeadline;
}

/**
 * The commit-coordinate line claims of one session's turns in one commit.
 *
 * Returns an empty `files` (never throws) when nothing can be proven; the
 * writer then keeps the contribution commit-level. Each returned file has at
 * least one range; ranges are sorted, inclusive, non-overlapping, and merge
 * only adjacent lines of the same `iteration_index`.
 *
 * Only the paths the admitted edits name are diffed and read — one
 * `diff-tree`, limited by literal pathspecs — so a large unrelated file in the
 * same commit costs nothing. Git applies a pathspec BEFORE rename detection, so
 * a rename is seen only when the capture names both sides (`oldPath`). Any
 * other path the commit adds may be the far side of a rename nobody captured:
 * its lines could be moved ones, so outside a root commit it degrades with
 * `possible_rename` instead of replaying from an empty file.
 */
export function projectCommitLineClaims(input: ProjectCommitLineClaimsInput): CommitLineProjection {
  const diagnostics: ProjectionDiagnostic[] = [];
  const seen = new Set<string>();
  const drop = (reason: ProjectionDropReason, p?: string) => {
    const key = `${reason}\u0000${p ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(p === undefined ? { reason } : { reason, path: p });
  };
  const empty = (): CommitLineProjection => ({ files: [], diagnostics });

  const { deadline } = input;
  try {
    const { repoPath, commitSha } = input;
    if (!FULL_SHA.test(commitSha || '')) { drop('commit_unreadable'); return empty(); }
    // A cut edit list may have lost any edit to any file: nothing it touches can be replayed.
    if (input.turns.some((t) => t.truncated)) { drop('capture_truncated'); return empty(); }
    if (input.binding === null) { drop('no_attested_binding'); return empty(); }

    const parentsLine = gitOrNull(['rev-list', '--parents', '-n', '1', commitSha], { cwd: repoPath, timeoutMs: gitTimeoutMs(deadline, 10_000) });
    if (!parentsLine) { checkDeadline(deadline); drop('commit_unreadable'); return empty(); }
    const parents = parentsLine.split(/\s+/).slice(1);
    const isMerge = parents.length > 1;

    const turns = [...input.turns].sort((x, y) => x.promptIndex - y.promptIndex);
    const sole = input.soleSessionFiles ?? new Set<string>();
    const admitted: AdmittedEdit[] = [];
    let seq = 0;
    turns.forEach((t, turn) => {
      for (const edit of t.edits) {
        const file = normalizePath(edit.file);
        const verdict = admitEditForLineClaim(edit, {
          commitSha, binding: input.binding, isMerge, soleSessionForFile: sole.has(file),
        });
        if (verdict.admitted) admitted.push({ edit: { ...edit, file }, tier: verdict.tier, turn, seq: seq++ });
        else drop(verdict.reason, file || undefined);
      }
    });
    if (admitted.length === 0) return empty();

    // A merge is diffed against its first parent; `--root` diffs a root commit
    // against the empty tree. Only the edited paths are diffed.
    const base = isMerge ? [parents[0]] : [];
    const paths = diffPathsFor(admitted);
    if (paths.length === 0) return empty();
    let patch: string;
    try {
      patch = git(
        ['-c', 'core.quotePath=false', 'diff-tree', '-r', '-p', '-U0', '-M', '--root', '--no-color', '--no-ext-diff',
          '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', ...base, commitSha, '--', ...paths.map(literalPathspec)],
        { cwd: repoPath, timeoutMs: gitTimeoutMs(deadline, 15_000), maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (err) {
      if (err instanceof ProjectionTimeout) throw err;
      checkDeadline(deadline);
      drop('commit_unreadable');
      return empty();
    }
    const parentRev = parents[0] ?? null;

    const files: ProjectedLineFile[] = [];
    for (const fd of parseCommitPatch(patch)) {
      checkDeadline(deadline);
      // A path git had to quote cannot be matched to any edit; say so once for
      // the commit rather than let the file vanish without a reason.
      if (fd.unparseable) { drop('unsafe_path'); continue; }
      const lineage = admitted.filter((a) =>
        (fd.path !== null && a.edit.file === fd.path) || (fd.oldPath !== null && a.edit.file === fd.oldPath));
      if (lineage.length === 0) continue;
      if (fd.path === null) continue; // deleted: no new-side lines, nothing to claim
      if (!isCanonicalRepoPath(fd.path)) { drop('unsafe_path', fd.path); continue; }
      // Added here, paired with no captured old side: possibly a rename the
      // limited diff cannot see. Only a root commit adds for certain.
      if (fd.oldPath === null && parents.length > 0) { drop('possible_rename', fd.path); continue; }
      if (fd.path.toLowerCase().endsWith('.ipynb')) { drop('notebook', fd.path); continue; }
      if (fd.nonText) { drop('binary_or_unreadable', fd.path); continue; }
      if (fd.addedLines.size === 0) { drop('not_new_side', fd.path); continue; }

      const result = projectFile(repoPath, commitSha, parentRev, isMerge, { ...fd, path: fd.path }, lineage, turns, deadline);
      if ('reason' in result) { drop(result.reason, fd.path); continue; }
      if (result.ranges.length === 0) { drop('not_new_side', fd.path); continue; }
      files.push({ path: fd.path, ranges: result.ranges });
    }
    files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return { files, diagnostics };
  } catch (err) {
    // Best effort: a projection failure must never break the writer or a hook.
    // Out of time is all-or-nothing too: no file of the commit is kept.
    drop(err instanceof ProjectionTimeout ? 'timeout' : 'commit_unreadable');
    return { files: [], diagnostics };
  }
}

/** A path git must match exactly: no glob, no `:(magic)`, whatever it starts with. */
function literalPathspec(p: string): string {
  return `:(literal)${p}`;
}

/**
 * The paths the commit's patch covers: every canonical path an admitted edit
 * names, and the old path of a rename it captured, so `-M` can pair the two.
 * Nothing else — no scan of the whole commit for rename counterparts.
 */
function diffPathsFor(admitted: AdmittedEdit[]): string[] {
  const paths = new Set<string>();
  for (const a of admitted) {
    for (const p of [a.edit.file, a.edit.oldPath === undefined ? '' : normalizePath(a.edit.oldPath)]) {
      if (isCanonicalRepoPath(p)) paths.add(p);
    }
  }
  return [...paths].sort();
}

function projectFile(
  repoPath: string,
  commitSha: string,
  parentRev: string | null,
  isMerge: boolean,
  fd: CommitFileDiff & { path: string },
  lineage: AdmittedEdit[],
  turns: CapturedTurn[],
  deadline: ProjectionDeadline | undefined,
): { ranges: ProjectedLineRange[] } | { reason: ProjectionDropReason } {
  // The commit patch restates what tool calls already say, more coarsely:
  // replaying both would apply the change twice. Prefer the finer record.
  let edits = lineage.some((a) => a.tier !== 'commit_patch') ? lineage.filter((a) => a.tier !== 'commit_patch') : lineage;
  if (edits.every((a) => a.tier === 'commit_patch') && new Set(edits.map((a) => a.turn)).size > 1) {
    return { reason: 'conflicting_owner' };
  }
  edits = [...edits].sort((x, y) => x.turn - y.turn || x.seq - y.seq);

  let baseText = '';
  if (fd.oldPath !== null) {
    if (!parentRev) return { reason: 'binary_or_unreadable' };
    const read = readFileAtRev(repoPath, parentRev, fd.oldPath, { timeoutMs: gitTimeoutMs(deadline, 10_000) });
    if (read === null) { checkDeadline(deadline); return { reason: 'binary_or_unreadable' }; }
    baseText = read;
  }
  const target = readFileAtRev(repoPath, commitSha, fd.path, { timeoutMs: gitTimeoutMs(deadline, 10_000) });
  if (target === null) { checkDeadline(deadline); return { reason: 'binary_or_unreadable' }; }
  if (baseText.includes('\u0000') || target.includes('\u0000')) return { reason: 'binary_or_unreadable' };
  if (!withinBounds(baseText) || !withinBounds(target)) return { reason: 'oversized' };

  const state = stateOf(baseText);
  for (const a of edits) {
    checkDeadline(deadline);
    const step = applyEdit(state, a.edit, a.turn, deadline);
    if (!step.ok) return { reason: step.reason };
    if (state.lines.length > MAX_FILE_LINES + 1) return { reason: 'oversized' };
  }
  // Where each line of the agent-projected state sits in the commit's blob.
  // Fast path: the replay IS the blob. Otherwise someone else also changed the
  // file in this commit, and only the agent's lines that EVERY optimal
  // alignment pairs with the same blob line move forward; the rest drop. A merge accepts the exact replay only: there
  // the first-parent diff carries the merged branch, and nothing short of a
  // full replay proves which side wrote a line.
  const targetLines = target.split('\n');
  const exact = state.lines.join('\n') === target;
  if (!exact && isMerge) return { reason: 'replay_mismatch' };
  const toTarget = exact
    ? state.lines.map((_, i) => i)
    : mandatoryAlignment(state.lines, targetLines, { maxLines: MAX_FILE_LINES + 1, tick: () => checkDeadline(deadline) });

  const owners: Array<number | null> = targetLines.map(() => null);
  toTarget.forEach((j, i) => { if (j >= 0) owners[j] = state.owners[i]; });

  const ranges: ProjectedLineRange[] = [];
  let open: ProjectedLineRange | null = null;
  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i];
    const ln = i + 1;
    if (owner === null || owner === undefined || !fd.addedLines.has(ln)) { open = null; continue; }
    const iteration = turns[owner].iterationIndex;
    if (open && open.end_line === ln - 1 && open.iteration_index === iteration) {
      open.end_line = ln;
      continue;
    }
    open = iteration === undefined ? { start_line: ln, end_line: ln } : { start_line: ln, end_line: ln, iteration_index: iteration };
    ranges.push(open);
  }
  // A partial reconcile that kept nothing is a mismatch, not a clean "no additions".
  if (ranges.length === 0 && !exact) return { reason: 'replay_mismatch' };
  return { ranges };
}
