// ---------------------------------------------------------------------------
// Origin CLI — re-anchor canonical line claims onto a later revision (OR-46)
// ---------------------------------------------------------------------------
// A v1 record's `contributions[].files[].ranges[]` are coordinates in the tree
// of the commit the note sits on (OR-45), and stay that forever. This module
// answers a different, read-only question:
//
//   Which line of file P at revision Y is still THE line a contribution was
//   proven to have written at revision X?
//
// A target line carries a claim only when three facts agree:
//
//   1. strict `git blame` of Y says the line originates at (X, path, line) —
//      no `-w`, `-M` or `-C`, no ignore-revs list: a whitespace reformat, a
//      move or a copy belongs to the commit that made it;
//   2. the valid canonical record of exactly X has one claim (one contribution,
//      one iteration identity) covering that source path and line; and
//   3. every optimal line alignment of X's blob onto Y's blob pairs that source
//      line with this target line (line-alignment.ts). Repeated content that
//      could pair either way loses its claim.
//
// Everything else is `unresolved` with a reason, never "human": a commit-level
// record, a line-level record that does not cover the line, a legacy note, a
// broken or foreign record, an uncommitted line all say only "no proof here".
//
// The result is derived. It never writes a note, never changes a stored range
// and carries no source text, prompt text or note payload — only revisions,
// paths, line numbers and indices into the source record.
//
// Layers, so the proof can be tested without git:
//
//   parseBlamePorcelain  — strict `--line-porcelain` parser (pure)
//   sourceRecordView     — one note → the line claims of its exact revision (pure)
//   matchSourceClaim     — record view + source path/line → claim | none | ambiguous (pure)
//   reanchorFileClaims   — origins + blobs → target claims (pure, injected providers)
//   reanchorFileAtRevision — the bounded git orchestration around them
//
// One deadline covers a whole invocation. Running out returns no claims at all
// (`timeout`), never a timing-dependent subset.
// ---------------------------------------------------------------------------

import { readRecord } from './attribution-record.js';
import { ATTRIBUTION_RECORD_NOTE_KEY } from './attribution-note.js';
import {
  MAX_FILE_BYTES,
  MAX_FILE_LINES,
  ProjectionTimeout,
  checkDeadline,
  createProjectionDeadline,
  isCanonicalRepoPath,
  withinBounds,
  type ProjectionDeadline,
} from './attribution-line-ranges.js';
import { mandatoryAlignment } from './line-alignment.js';
import { recordFingerprint } from './attribution-record-fingerprint.js';
import { GitBatchError, catFileCheck, gitWithin, noteBlobs, readBlobs, readObjects, treeEntries, type BlobRead } from './git-object-batch.js';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_SHA = /^0+$/;

/** Default wall-clock budget of one `reanchorFileAtRevision` call. */
export const REANCHOR_BUDGET_MS = 5_000;

/**
 * At most this many distinct (source revision, source path) pairs are aligned
 * for one target file. Past it the file fails as a whole (`too_many_sources`):
 * a deterministic refusal, not a timing-dependent subset.
 */
export const MAX_ALIGNED_SOURCES = 64;

/** Notes larger than this are not parsed; their claims are `record_invalid`. */
const MAX_NOTE_BYTES = MAX_FILE_BYTES;
const BLAME_MAX_BUFFER = 32 * 1024 * 1024;
const NOTES_REF = 'refs/notes/origin';

// ─── Public result ──────────────────────────────────────────────────────────

/**
 * One proven run of target lines. Target coordinates (`start_line`..`end_line`
 * in `target_path` at `target_revision`) and source coordinates
 * (`source_start_line`..`source_end_line` in `source_path` at
 * `source_revision`) are kept apart and both inclusive, 1-based. The indices
 * name the claim inside the source revision's record.
 */
export interface ReanchoredLineClaim {
  target_revision: string;
  target_path: string;
  start_line: number;
  end_line: number;
  source_revision: string;
  source_path: string;
  source_start_line: number;
  source_end_line: number;
  contribution_index: number;
  file_index: number;
  range_index: number;
  iteration_index?: number;
}

/** Why one target line carries no claim. Never carries content. */
export type LineReanchorReason =
  | 'uncommitted'          // the zero SHA: a working-tree line
  | 'boundary'             // blame stopped at a boundary (shallow history)
  | 'unsafe_path'          // a source path git had to quote, or a non-canonical one
  | 'no_record'            // no note, or a note without a canonical record (legacy)
  | 'commit_level'         // a valid record without line claims
  | 'no_line_claim'        // a line-level record that does not cover this line
  | 'record_invalid'
  | 'record_unsupported'
  | 'record_wrong_revision'
  | 'ambiguous_claim'      // several contributions or iterations cover the source line
  | 'source_unreadable'    // the source blob is missing, binary or not a blob
  | 'source_oversized'
  | 'source_mismatch'      // the source blob's line is not the text blame reported
  | 'ambiguous_alignment'  // not every optimal alignment pins the source line here
  | 'duplicate_source';    // two target lines claim the same source line

/** Why the whole file produced nothing. */
export type FileReanchorFailure =
  | 'not_full_sha'
  | 'unsafe_path'
  | 'notebook'
  | 'target_unreadable'
  | 'non_text'
  | 'oversized'
  | 'blame_unreadable'
  | 'blame_malformed'
  | 'blame_mismatch'
  | 'too_many_sources'
  | 'timeout'
  | 'internal_error';

export interface UnresolvedLines {
  start_line: number;
  end_line: number;
  reason: LineReanchorReason;
}

export interface FileReanchorResult {
  target_revision: string;
  target_path: string;
  status: 'resolved' | 'failed';
  /** Set only with `status: 'failed'`; `claims` and `unresolved` are then empty. */
  failure?: FileReanchorFailure;
  /** Sorted by `start_line`, non-overlapping. */
  claims: ReanchoredLineClaim[];
  /** Target lines without a claim, merged into runs of one reason. */
  unresolved: UnresolvedLines[];
}

// ─── Blame porcelain ────────────────────────────────────────────────────────

export interface BlameOrigin {
  /** 1-based line in the blamed (target) file. */
  targetLine: number;
  /** Full SHA of the commit the line originates in; all zeros when uncommitted. */
  sourceRevision: string;
  /** 1-based line in `sourcePath` at `sourceRevision`. */
  sourceLine: number;
  /** The file at `sourceRevision`; null when git printed it quoted. */
  sourcePath: string | null;
  author: string;
  /** The line's text, as blame printed it (no trailing newline). */
  content: string;
  /** Blame stopped here without reaching the true origin. */
  boundary: boolean;
}

export type BlameParse = { ok: true; origins: BlameOrigin[] } | { ok: false };

const BLAME_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) ([1-9][0-9]*) ([1-9][0-9]*)(?: ([1-9][0-9]*))?$/;

/**
 * Strict parser of `git blame --line-porcelain`. Every final line must come
 * with its own header, `author`, `filename` and a tab-prefixed content row;
 * final lines must run 1..N with no gap; a group announced as K lines must
 * deliver K consecutive lines of one commit. Anything else — a truncated
 * stream, a header without content, repeated `filename`, an unknown header
 * shape — rejects the WHOLE output: one bad row could have shifted every row
 * after it. Unknown metadata keys are ignored (git may add more).
 */
export function parseBlamePorcelain(output: string): BlameParse {
  if (output === '') return { ok: true, origins: [] };
  if (!output.endsWith('\n')) return { ok: false };
  const rows = output.slice(0, -1).split('\n');
  const origins: BlameOrigin[] = [];
  let groupSha = '';
  let groupLeft = 0;
  let lastSourceLine = 0;

  let i = 0;
  while (i < rows.length) {
    const h = BLAME_HEADER.exec(rows[i]);
    if (!h) return { ok: false };
    const sha = h[1];
    const sourceLine = Number(h[2]);
    const targetLine = Number(h[3]);
    if (targetLine !== origins.length + 1) return { ok: false };
    if (h[4] !== undefined) {
      if (groupLeft !== 0) return { ok: false };
      groupSha = sha;
      groupLeft = Number(h[4]);
    } else if (groupLeft === 0 || sha !== groupSha || sourceLine !== lastSourceLine + 1) {
      return { ok: false };
    }
    groupLeft--;
    lastSourceLine = sourceLine;
    i++;

    let author: string | null = null;
    let filename: string | null = null;
    let boundary = false;
    for (; i < rows.length && !rows[i].startsWith('\t'); i++) {
      const row = rows[i];
      if (BLAME_HEADER.test(row)) return { ok: false }; // a header that never got its content row
      const sp = row.indexOf(' ');
      const key = sp < 0 ? row : row.slice(0, sp);
      const value = sp < 0 ? '' : row.slice(sp + 1);
      if (key === 'author') {
        if (author !== null) return { ok: false };
        author = value;
      } else if (key === 'filename') {
        if (filename !== null) return { ok: false };
        filename = value;
      } else if (row === 'boundary') {
        boundary = true;
      }
    }
    if (i >= rows.length || author === null || !filename) return { ok: false };
    origins.push({
      targetLine,
      sourceRevision: sha,
      sourceLine,
      sourcePath: filename.startsWith('"') ? null : filename,
      author,
      content: rows[i].slice(1),
      boundary,
    });
    i++;
  }
  if (groupLeft !== 0) return { ok: false };
  return { ok: true, origins };
}

/** A blame origin without the line's text: what `--incremental` reports. */
export type BlameOriginWithoutContent = Omit<BlameOrigin, 'content'>;

const INCREMENTAL_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*)$/;

/**
 * Strict parser of `git blame --incremental` for a file of `lineCount` lines.
 * Its output grows with the number of blame groups, not with line length or
 * line count, which is what the bounded commit-only path of large files needs
 * (attribution.ts). Groups come in any order; each must end with its own
 * `filename`, and together they must cover 1..lineCount exactly once. Commit
 * metadata (`author`, `boundary`) is printed with a commit's first group and
 * applies to all of its groups. Anything else rejects the whole output.
 * Carries no line text: these origins can never feed a line proof.
 */
export function parseBlameIncremental(output: string, lineCount: number): { ok: true; origins: BlameOriginWithoutContent[] } | { ok: false } {
  if (!Number.isSafeInteger(lineCount) || lineCount < 0) return { ok: false };
  if (output === '') return lineCount === 0 ? { ok: true, origins: [] } : { ok: false };
  if (!output.endsWith('\n')) return { ok: false };
  const rows = output.slice(0, -1).split('\n');
  const groups: Array<{ sha: string; sourceLine: number; targetLine: number; count: number; sourcePath: string | null }> = [];
  const authors = new Map<string, string>();
  const boundaries = new Set<string>();

  let i = 0;
  while (i < rows.length) {
    const h = INCREMENTAL_HEADER.exec(rows[i]);
    if (!h) return { ok: false };
    const sha = h[1];
    i++;
    let filename: string | null = null;
    for (; i < rows.length; i++) {
      const row = rows[i];
      if (INCREMENTAL_HEADER.test(row)) return { ok: false }; // a group that never named its file
      if (row.startsWith('filename ')) { filename = row.slice('filename '.length); i++; break; }
      const sp = row.indexOf(' ');
      const key = sp < 0 ? row : row.slice(0, sp);
      if (key === 'author') {
        if (authors.has(sha)) return { ok: false };
        authors.set(sha, sp < 0 ? '' : row.slice(sp + 1));
      } else if (row === 'boundary') {
        boundaries.add(sha);
      }
    }
    if (!filename) return { ok: false };
    groups.push({
      sha,
      sourceLine: Number(h[2]),
      targetLine: Number(h[3]),
      count: Number(h[4]),
      sourcePath: filename.startsWith('"') ? null : filename,
    });
  }

  const origins: Array<BlameOriginWithoutContent | undefined> = new Array(lineCount);
  for (const g of groups) {
    const author = authors.get(g.sha);
    if (author === undefined) return { ok: false };
    if (g.targetLine + g.count - 1 > lineCount) return { ok: false };
    for (let k = 0; k < g.count; k++) {
      const t = g.targetLine + k;
      if (origins[t - 1] !== undefined) return { ok: false };
      origins[t - 1] = {
        targetLine: t,
        sourceRevision: g.sha,
        sourceLine: g.sourceLine + k,
        sourcePath: g.sourcePath,
        author,
        boundary: boundaries.has(g.sha),
      };
    }
  }
  for (let k = 0; k < lineCount; k++) if (origins[k] === undefined) return { ok: false };
  return { ok: true, origins: origins as BlameOriginWithoutContent[] };
}

// ─── Source record ──────────────────────────────────────────────────────────

/** One stored range of the source record, by its position in that record. */
export interface SourceLineRange {
  contributionIndex: number;
  fileIndex: number;
  rangeIndex: number;
  startLine: number;
  endLine: number;
  iterationIndex?: number;
}

export type SourceRecordView =
  | { kind: 'line_claims'; byPath: ReadonlyMap<string, readonly SourceLineRange[]> }
  | { kind: 'no_record' | 'commit_level' | 'invalid' | 'unsupported' | 'wrong_revision' };

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The canonical record of the note on `revision`: the one parse every reader
 * below starts from. Only `attribution_record` is read, through `readRecord`
 * (exact or projected 1.x), and only when it names exactly this git revision.
 * The legacy payload of the note is never consulted.
 */
type SourceRecordRead =
  | { kind: 'record'; record: any }
  | { kind: 'no_record' | 'invalid' | 'unsupported' | 'wrong_revision' };

function readSourceRecord(noteText: string | null, revision: string): SourceRecordRead {
  if (noteText === null) return { kind: 'no_record' };
  let envelope: unknown;
  try {
    envelope = JSON.parse(noteText);
  } catch {
    return { kind: 'no_record' };
  }
  if (!isPlainObject(envelope) || !(ATTRIBUTION_RECORD_NOTE_KEY in envelope)) return { kind: 'no_record' };
  const read = readRecord(envelope[ATTRIBUTION_RECORD_NOTE_KEY]);
  if (read.status === 'unsupported') return { kind: 'unsupported' };
  if (read.status === 'invalid') return { kind: 'invalid' };
  const rev = read.record.revision;
  if (rev?.vcs !== 'git' || rev?.id !== revision) return { kind: 'wrong_revision' };
  return { kind: 'record', record: read.record };
}

/**
 * What the note on `revision` proves, line by line (readSourceRecord). The
 * view holds positions, not the record.
 */
export function sourceRecordView(noteText: string | null, revision: string): SourceRecordView {
  const read = readSourceRecord(noteText, revision);
  return read.kind === 'record' ? viewOfRecord(read.record) : { kind: read.kind };
}

function viewOfRecord(record: any): SourceRecordView {
  const byPath = new Map<string, SourceLineRange[]>();
  (record.contributions as any[]).forEach((c, contributionIndex) => {
    (c.files ?? []).forEach((f: any, fileIndex: number) => {
      const list = byPath.get(f.path) ?? [];
      (f.ranges as any[]).forEach((r, rangeIndex) => {
        const range: SourceLineRange = { contributionIndex, fileIndex, rangeIndex, startLine: r.start_line, endLine: r.end_line };
        if (r.iteration_index !== undefined) range.iterationIndex = r.iteration_index;
        list.push(range);
      });
      byPath.set(f.path, list);
    });
  });
  return byPath.size === 0 ? { kind: 'commit_level' } : { kind: 'line_claims', byPath };
}

export type SourceClaimMatch =
  | { kind: 'claim'; range: SourceLineRange }
  | { kind: 'ambiguous' }
  | { kind: 'none'; reason: LineReanchorReason };

const VIEW_REASON: Record<Exclude<SourceRecordView['kind'], 'line_claims'>, LineReanchorReason> = {
  no_record: 'no_record',
  commit_level: 'commit_level',
  invalid: 'record_invalid',
  unsupported: 'record_unsupported',
  wrong_revision: 'record_wrong_revision',
};

/**
 * The one claim of the source record on (path, line). Ranges of the SAME
 * contribution and the same iteration identity (both absent counts as the same)
 * are one claim, reported by its first range in record order — they say the
 * same thing. Ranges of different contributions, or of one contribution with
 * different iterations, are `ambiguous`: no winner is picked by array order.
 */
export function matchSourceClaim(view: SourceRecordView, path: string, line: number): SourceClaimMatch {
  if (view.kind !== 'line_claims') return { kind: 'none', reason: VIEW_REASON[view.kind] };
  const covering = (view.byPath.get(path) ?? []).filter((r) => r.startLine <= line && line <= r.endLine);
  if (covering.length === 0) return { kind: 'none', reason: 'no_line_claim' };
  const identities = new Set(covering.map((r) => `${r.contributionIndex}:${r.iterationIndex ?? ''}`));
  if (identities.size > 1) return { kind: 'ambiguous' };
  const first = [...covering].sort((x, y) => x.fileIndex - y.fileIndex || x.rangeIndex - y.rangeIndex)[0];
  return { kind: 'claim', range: first };
}

/** Who a proven claim belongs to: identifiers only, no prompt, hash or usage. */
export interface ContributionIdentity {
  sessionId?: string;
  agentId?: string;
  modelId?: string;
  /**
   * The `/1` fingerprint of the whole record the identity was read from
   * (attribution-record-fingerprint.ts). Absent when that record has no
   * canonical form; the identity itself is unaffected.
   */
  recordFingerprint?: string;
}

/**
 * The identity of `contributions[contributionIndex]` in the canonical record
 * of the note on `revision` — read through the same `readRecord` and exact
 * revision check as `sourceRecordView`, so a claim and its identity can never
 * come from two different records. Null when that record does not prove it.
 */
export function contributionIdentity(noteText: string | null, revision: string, contributionIndex: number): ContributionIdentity | null {
  const read = readSourceRecord(noteText, revision);
  if (read.kind !== 'record') return null;
  return identityInRecord(read.record, contributionIndex, recordFingerprint(read.record));
}

/** The identity of one contribution of an already read record, with that record's fingerprint. */
function identityInRecord(record: any, contributionIndex: number, fingerprint: string | null): ContributionIdentity | null {
  const c = (record.contributions as any[])[contributionIndex];
  if (!isPlainObject(c)) return null;
  const out: ContributionIdentity = {};
  if (typeof c.session?.id === 'string') out.sessionId = c.session.id;
  if (typeof c.agent?.id === 'string') out.agentId = c.agent.id;
  if (typeof c.model?.id === 'string') out.modelId = c.model.id;
  if (fingerprint !== null) out.recordFingerprint = fingerprint;
  return out;
}

/**
 * Who the canonical record of the note on `revision` says worked on that
 * commit, as a whole: the commit-confidence identity (OR-46 CR1). A field is
 * set only when every contribution names it and all name the same value —
 * several sessions, agents or models leave it unset; no owner is picked by
 * array order. Null when the note has no valid record of exactly this
 * revision, or the record has no contribution.
 */
export function commitRecordIdentity(noteText: string | null, revision: string): ContributionIdentity | null {
  if (noteText === null) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(noteText);
  } catch {
    return null;
  }
  if (!isPlainObject(envelope) || !(ATTRIBUTION_RECORD_NOTE_KEY in envelope)) return null;
  const read = readRecord(envelope[ATTRIBUTION_RECORD_NOTE_KEY]);
  if (read.status !== 'exact' && read.status !== 'projected') return null;
  if (read.record.revision?.vcs !== 'git' || read.record.revision?.id !== revision) return null;
  const contributions = (read.record.contributions as any[]).filter(isPlainObject);
  if (contributions.length === 0) return null;
  const only = (pick: (c: Record<string, any>) => unknown): string | undefined => {
    const values = contributions.map(pick);
    return values.every((v) => typeof v === 'string' && v === values[0]) ? (values[0] as string) : undefined;
  };
  const out: ContributionIdentity = {};
  const sessionId = only((c) => c.session?.id);
  const agentId = only((c) => c.agent?.id);
  const modelId = only((c) => c.model?.id);
  if (sessionId !== undefined) out.sessionId = sessionId;
  if (agentId !== undefined) out.agentId = agentId;
  if (modelId !== undefined) out.modelId = modelId;
  return out;
}

/** The per-line reason a record view without line claims gives (`no_record`, `commit_level`, …). */
export function recordViewReason(view: Exclude<SourceRecordView, { kind: 'line_claims' }>): LineReanchorReason {
  return VIEW_REASON[view.kind];
}

/**
 * Every source line of the claim's run matches, in `view`, exactly the
 * claim's contribution, file entry, range and iteration. Checked per claim:
 * another claim of the same contribution proves nothing about this one.
 */
function claimProvenBy(view: SourceRecordView, claim: ReanchoredLineClaim): boolean {
  for (let line = claim.source_start_line; line <= claim.source_end_line; line++) {
    const m = matchSourceClaim(view, claim.source_path, line);
    if (m.kind !== 'claim'
      || m.range.contributionIndex !== claim.contribution_index
      || m.range.fileIndex !== claim.file_index
      || m.range.rangeIndex !== claim.range_index
      || m.range.iterationIndex !== claim.iteration_index) return false;
  }
  return true;
}

/**
 * The identity behind one re-anchored claim, read from `noteText` only after
 * that text is shown to prove the WHOLE claim again: every source line of the
 * run must match, in this same record, exactly the claim's contribution, file
 * entry, range and iteration. A note replaced by another valid record of the
 * same revision — one that no longer covers the path, the lines or the range —
 * gives null, never the new record's contribution under the old claim.
 */
export function claimIdentity(noteText: string | null, claim: ReanchoredLineClaim): ContributionIdentity | null {
  const read = readSourceRecord(noteText, claim.source_revision);
  const view: SourceRecordView = read.kind === 'record' ? viewOfRecord(read.record) : { kind: read.kind };
  if (!claimProvenBy(view, claim) || read.kind !== 'record') return null;
  return identityInRecord(read.record, claim.contribution_index, recordFingerprint(read.record));
}

// ─── The pure resolver ──────────────────────────────────────────────────────

/** A file's lines as blame numbers them: no trailing empty piece after the last newline. */
export function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function textProblem(text: string): 'non_text' | 'oversized' | null {
  if (text.includes('\u0000')) return 'non_text';
  return withinBounds(text) ? null : 'oversized';
}

export interface ReanchorFileInput {
  /** Full SHA of the revision whose file is viewed. */
  targetRevision: string;
  /** Repo-relative path of the file at `targetRevision`. */
  targetPath: string;
  /** The file's text at `targetRevision`. */
  targetText: string;
  /** Strict blame of that file at that revision (parseBlamePorcelain). */
  origins: readonly BlameOrigin[];
  /** The record view of a source revision. Called at most once per revision. */
  sourceRecord: (revision: string) => SourceRecordView;
  /** The source file's text; null when unreadable. Called at most once per pair. */
  sourceText: (revision: string, path: string) => string | null;
  deadline?: ProjectionDeadline;
}

type LineState =
  | { claim: SourceLineRange; origin: BlameOrigin }
  | { reason: LineReanchorReason };

/**
 * Re-anchor the claims of every source revision blame names onto one target
 * file. Pure: git, notes and blobs come in through `input`.
 *
 * Never throws. A target the blame does not describe line for line, an
 * oversized or binary target, more than MAX_ALIGNED_SOURCES pairs to align, or
 * the deadline running out fail the whole file. A source that cannot be read
 * fails only its own lines.
 */
export function reanchorFileClaims(input: ReanchorFileInput): FileReanchorResult {
  const { targetRevision, targetPath, deadline } = input;
  const fail = (failure: FileReanchorFailure): FileReanchorResult =>
    ({ target_revision: targetRevision, target_path: targetPath, status: 'failed', failure, claims: [], unresolved: [] });

  try {
    if (!FULL_SHA.test(targetRevision)) return fail('not_full_sha');
    if (!isCanonicalRepoPath(targetPath)) return fail('unsafe_path');
    if (targetPath.toLowerCase().endsWith('.ipynb')) return fail('notebook');
    const problem = textProblem(input.targetText);
    if (problem) return fail(problem);
    checkDeadline(deadline);

    const targetLines = linesOf(input.targetText);
    const { origins } = input;
    if (origins.length !== targetLines.length) return fail('blame_mismatch');
    for (let k = 0; k < origins.length; k++) {
      if (origins[k].targetLine !== k + 1 || origins[k].content !== targetLines[k]) return fail('blame_mismatch');
    }

    // 1. Each line's source claim, from the record of its exact revision.
    const views = new Map<string, SourceRecordView>();
    const viewOf = (rev: string) => {
      let v = views.get(rev);
      if (!v) views.set(rev, v = input.sourceRecord(rev));
      return v;
    };
    const states: LineState[] = origins.map((o): LineState => {
      if (ZERO_SHA.test(o.sourceRevision)) return { reason: 'uncommitted' };
      if (o.boundary) return { reason: 'boundary' };
      if (o.sourcePath === null || !isCanonicalRepoPath(o.sourcePath)) return { reason: 'unsafe_path' };
      const match = matchSourceClaim(viewOf(o.sourceRevision), o.sourcePath, o.sourceLine);
      if (match.kind === 'none') return { reason: match.reason };
      if (match.kind === 'ambiguous') return { reason: 'ambiguous_claim' };
      return { claim: match.range, origin: o };
    });

    // 2. Every claimed line must be pinned to this target line by every
    //    optimal alignment of its source blob onto the target blob.
    const pairKey = (o: BlameOrigin) => `${o.sourceRevision}\u0000${o.sourcePath}`;
    const pairs = new Map<string, number[]>();
    states.forEach((s, k) => {
      if (!('claim' in s)) return;
      const key = pairKey(s.origin);
      const list = pairs.get(key) ?? [];
      list.push(k);
      pairs.set(key, list);
    });
    if (pairs.size > MAX_ALIGNED_SOURCES) return fail('too_many_sources');

    for (const key of [...pairs.keys()].sort()) {
      checkDeadline(deadline);
      const members = pairs.get(key)!;
      const first = states[members[0]] as { origin: BlameOrigin };
      const rev = first.origin.sourceRevision;
      const path = first.origin.sourcePath!;
      const dropAll = (reason: LineReanchorReason) => { for (const k of members) states[k] = { reason }; };

      // Git tree-entry identity: canonical repo paths compare exactly, case-sensitive even on a case-insensitive host (A.ts and a.ts are two entries).
      const sourceText = rev === targetRevision && path === targetPath ? input.targetText : input.sourceText(rev, path); // path-compare-ok
      if (sourceText === null) { dropAll('source_unreadable'); continue; }
      const sp = textProblem(sourceText);
      if (sp) { dropAll(sp === 'oversized' ? 'source_oversized' : 'source_unreadable'); continue; }
      const sourceLines = linesOf(sourceText);
      // Identical blobs have exactly one optimal alignment: the identity.
      const toTarget = sourceText === input.targetText
        ? sourceLines.map((_, k) => k)
        : mandatoryAlignment(sourceLines, targetLines, { maxLines: MAX_FILE_LINES + 1, tick: () => checkDeadline(deadline) });

      for (const k of members) {
        const { origin } = states[k] as { origin: BlameOrigin };
        if (sourceLines[origin.sourceLine - 1] !== origin.content) { states[k] = { reason: 'source_mismatch' }; continue; }
        if (toTarget[origin.sourceLine - 1] !== origin.targetLine - 1) states[k] = { reason: 'ambiguous_alignment' };
      }
    }

    // 3. One source line may back one target line at most.
    const bySource = new Map<string, number[]>();
    states.forEach((s, k) => {
      if (!('claim' in s)) return;
      const key = `${pairKey(s.origin)}\u0000${s.origin.sourceLine}`;
      bySource.set(key, [...(bySource.get(key) ?? []), k]);
    });
    for (const ks of bySource.values()) if (ks.length > 1) for (const k of ks) states[k] = { reason: 'duplicate_source' };

    checkDeadline(deadline);
    return {
      target_revision: targetRevision,
      target_path: targetPath,
      status: 'resolved',
      claims: mergeClaims(states, targetRevision, targetPath),
      unresolved: mergeUnresolved(states),
    };
  } catch (err) {
    return fail(err instanceof ProjectionTimeout ? 'timeout' : 'internal_error');
  }
}

/**
 * Adjacent target lines join one claim only when they continue the same
 * source run: same revision, path, contribution, file entry, range and
 * iteration, and consecutive source lines.
 */
function mergeClaims(states: LineState[], targetRevision: string, targetPath: string): ReanchoredLineClaim[] {
  const out: ReanchoredLineClaim[] = [];
  let open: ReanchoredLineClaim | null = null;
  states.forEach((s, k) => {
    if (!('claim' in s)) { open = null; return; }
    const { claim, origin } = s;
    const line = k + 1;
    if (open
      && open.end_line === line - 1
      && open.source_revision === origin.sourceRevision
      && open.source_path === origin.sourcePath
      && open.source_end_line === origin.sourceLine - 1
      && open.contribution_index === claim.contributionIndex
      && open.file_index === claim.fileIndex
      && open.range_index === claim.rangeIndex
      && open.iteration_index === claim.iterationIndex) {
      open.end_line = line;
      open.source_end_line = origin.sourceLine;
      return;
    }
    const next: ReanchoredLineClaim = {
      target_revision: targetRevision,
      target_path: targetPath,
      start_line: line,
      end_line: line,
      source_revision: origin.sourceRevision,
      source_path: origin.sourcePath!,
      source_start_line: origin.sourceLine,
      source_end_line: origin.sourceLine,
      contribution_index: claim.contributionIndex,
      file_index: claim.fileIndex,
      range_index: claim.rangeIndex,
    };
    if (claim.iterationIndex !== undefined) next.iteration_index = claim.iterationIndex;
    out.push(next);
    open = next;
  });
  return out;
}

function mergeUnresolved(states: LineState[]): UnresolvedLines[] {
  const out: UnresolvedLines[] = [];
  let open: UnresolvedLines | null = null;
  states.forEach((s, k) => {
    if (!('reason' in s)) { open = null; return; }
    const line = k + 1;
    if (open && open.reason === s.reason && open.end_line === line - 1) { open.end_line = line; return; }
    open = { start_line: line, end_line: line, reason: s.reason };
    out.push(open);
  });
  return out;
}

// ─── Git orchestration ──────────────────────────────────────────────────────

export interface ReanchorFileAtRevisionInput {
  /** The repository's top-level directory: paths are relative to it. */
  repoPath: string;
  /** Full SHA of the commit whose file is viewed. */
  targetRevision: string;
  /** Repo-relative path at `targetRevision`. */
  targetPath: string;
  /** One budget for the whole call; defaults to REANCHOR_BUDGET_MS from now. */
  deadline?: ProjectionDeadline;
}

/**
 * The canonical line claims that survive into `targetPath` at
 * `targetRevision`. A fixed number of git subprocesses per call — `ls-tree`,
 * `blame`, `notes list` and at most three `cat-file` pairs — never one per
 * line or per source commit.
 *
 * Blame is `--line-porcelain --root --no-textconv` with the ignore-revs list
 * cleared, and never `-w`, `-M` or `-C`. Git's own whole-file rename
 * following stays on: the source path comes from blame's `filename`.
 *
 * Readers in this CLI go through attribution.ts (resolveLineAttribution).
 */
export function reanchorFileAtRevision(input: ReanchorFileAtRevisionInput): FileReanchorResult {
  return resolveFileAtRevision(input).result;
}

/**
 * `reanchorFileAtRevision` plus what the CLI's own presentation needs next to
 * it: the target blob's text and the strict blame origins (git author and
 * blamed commit per line). Both are for local display only — never part of
 * the public result. Either is null when the call failed before reading it.
 */
export interface ResolvedFileAtRevision {
  result: FileReanchorResult;
  targetText: string | null;
  origins: readonly BlameOrigin[] | null;
  /**
   * The identity of one of `result.claims`, from the SAME note snapshot the
   * claim was proven on: the whole claim is re-checked, as by claimIdentity,
   * against that snapshot's record, which the call parsed once per source
   * revision; its fingerprint and contribution identities are prepared once
   * per revision too. No git call; null for a claim this call did not produce
   * or cannot re-prove.
   */
  identityOf: (claim: ReanchoredLineClaim) => ContributionIdentity | null;
  /**
   * The note of a revision blame named, from the SAME snapshot the claims were
   * proven on: its record view and its text (null when the revision has no
   * note, or its note was too large to read). Undefined for a revision this
   * call did not look up. No git call.
   */
  noteOf: (revision: string) => NoteSnapshotEntry | undefined;
}

/** One revision's note as one call read it. */
export interface NoteSnapshotEntry {
  view: SourceRecordView;
  text: string | null;
}

export function resolveFileAtRevision(input: ReanchorFileAtRevisionInput): ResolvedFileAtRevision {
  const deadline = input.deadline ?? createProjectionDeadline(REANCHOR_BUDGET_MS);
  return resolveFilesAtRevision({
    repoPath: input.repoPath, targetRevision: input.targetRevision, targetPaths: [input.targetPath], deadline,
  }).get(input.targetPath)!;
}

export interface ResolveFilesAtRevisionInput {
  /** The repository's top-level directory: paths are relative to it. */
  repoPath: string;
  /** Full SHA of the commit whose files are viewed. */
  targetRevision: string;
  /** Repo-relative paths at `targetRevision`; each gets its own result. */
  targetPaths: readonly string[];
  /**
   * One budget for the whole call. Without it each file's blame and each
   * file's alignment get REANCHOR_BUDGET_MS of their own, and the shared
   * batch reads only git's per-call caps.
   */
  deadline?: ProjectionDeadline;
  /**
   * A commit → note blob snapshot of refs/notes/origin (noteBlobs) the caller
   * already took. The call reads notes through it instead of listing them
   * again, so caller and call see one snapshot and git lists notes once.
   */
  notes?: ReadonlyMap<string, string>;
  /**
   * A note the snapshot lists for a revision this call needs that is missing,
   * not a blob or cannot be read throws UnreadableNoteError out of the call,
   * instead of failing the files of its group (`internal_error`).
   */
  strictNotes?: boolean;
}

/**
 * A note listed for a revision the call needed could not be read
 * (`strictNotes`). Names the revision when known; never carries note content.
 */
export class UnreadableNoteError extends Error {
  constructor(readonly revision?: string) {
    super(revision ? `the attribution note of ${revision} cannot be read` : 'an attribution note cannot be read');
    this.name = 'UnreadableNoteError';
  }
}

/** Target bytes resolved together; more files make another group. */
const GROUP_TARGET_BYTES = 32 * 1024 * 1024;
/** Source bytes held for alignment at once; more are read after these files resolve. */
const GROUP_SOURCE_BYTES = 32 * 1024 * 1024;
/**
 * Bytes of note bodies one call reads and keeps (they back `identityOf`).
 * Past it the files that need more notes fail (`internal_error`): no claim is
 * proven from a record that was not read.
 */
const CALL_NOTE_BYTES = 32 * 1024 * 1024;

/**
 * `resolveFileAtRevision` for many files of one revision, each with exactly
 * the result the single call gives. The git work is one strict `blame` per
 * file plus a fixed set of batch calls per group of files — `ls-tree`,
 * `cat-file --batch-check` and chunked `--batch` reads of targets, notes and
 * source blobs, one `notes list` — never one call per object.
 *
 * A failed batch fails every file of its group that it touches (`timeout`
 * when a deadline or a git timeout ran out, `internal_error` otherwise); it
 * never leaves a file half resolved.
 */
export function resolveFilesAtRevision(input: ResolveFilesAtRevisionInput): Map<string, ResolvedFileAtRevision> {
  const { repoPath, targetRevision, deadline } = input;
  const own = () => deadline ?? createProjectionDeadline(REANCHOR_BUDGET_MS);
  // Note texts exactly as the claims were proven on, by source revision.
  const noteSnapshot = new Map<string, string>();
  // By source revision, from the one parse of the note text this call read:
  // the view the claims were proven on, and the canonical record behind it.
  const views = new Map<string, SourceRecordView>();
  const records = new Map<string, any>();
  // Per source revision, prepared at most once and only when an identity is
  // asked for: the record's fingerprint and each contribution's identity.
  // Lives as long as this call's results; nothing is cached across calls.
  const prepared = new Map<string, { fingerprint: string | null; identities: Map<number, ContributionIdentity | null> }>();
  let notes: ReadonlyMap<string, string> | null = input.notes ?? null;
  let noteBytes = 0;
  const out = new Map<string, ResolvedFileAtRevision>();

  // claimIdentity against the cached view and record: every claim still
  // proves its own whole source run; only the per-record work is shared.
  const identityOf = (claim: ReanchoredLineClaim): ContributionIdentity | null => {
    const rev = claim.source_revision;
    const record = records.get(rev);
    const view = views.get(rev);
    if (record === undefined || view === undefined || !claimProvenBy(view, claim)) return null;
    let p = prepared.get(rev);
    if (!p) prepared.set(rev, p = { fingerprint: recordFingerprint(record), identities: new Map() });
    if (!p.identities.has(claim.contribution_index)) {
      p.identities.set(claim.contribution_index, identityInRecord(record, claim.contribution_index, p.fingerprint));
    }
    const id = p.identities.get(claim.contribution_index);
    return id ? { ...id } : null;
  };

  type FileState = {
    path: string;
    targetText: string | null;
    origins: readonly BlameOrigin[] | null;
    oid?: string;
    size?: number;
    blobNames?: string[];
  };
  const finish = (s: FileState, result: FileReanchorResult) => out.set(s.path, {
    result,
    targetText: s.targetText,
    origins: s.origins,
    identityOf: (claim) => (result.claims.includes(claim) ? identityOf(claim) : null),
    noteOf: (revision) => {
      const view = views.get(revision);
      return view ? { view, text: noteSnapshot.get(revision) ?? null } : undefined;
    },
  });
  const fail = (s: FileState, failure: FileReanchorFailure) => finish(s,
    { target_revision: targetRevision, target_path: s.path, status: 'failed', failure, claims: [], unresolved: [] });
  const failOn = (s: FileState, err: unknown, d: ProjectionDeadline | undefined) => {
    if (err instanceof ProjectionTimeout) return fail(s, 'timeout');
    try { checkDeadline(d); } catch { return fail(s, 'timeout'); }
    return fail(s, 'internal_error');
  };

  const pending: FileState[] = [];
  for (const path of new Set(input.targetPaths)) {
    const s: FileState = { path, targetText: null, origins: null };
    if (!FULL_SHA.test(targetRevision || '')) fail(s, 'not_full_sha');
    else if (!isCanonicalRepoPath(path)) fail(s, 'unsafe_path');
    else if (path.toLowerCase().endsWith('.ipynb')) fail(s, 'notebook');
    else pending.push(s);
  }
  if (pending.length === 0) return out;

  // 1. Which targets are regular text blobs within bounds: one ls-tree, one check.
  const ready: FileState[] = [];
  try {
    checkDeadline(deadline);
    const entries = treeEntries(repoPath, targetRevision, pending.map((s) => s.path), deadline);
    const regular: FileState[] = [];
    for (const s of pending) {
      const e = entries.get(s.path);
      if (!e) { fail(s, 'target_unreadable'); continue; }
      // A symlink (120000) or a submodule (160000) has no source lines.
      if (e.mode !== '100644' && e.mode !== '100755') { fail(s, 'non_text'); continue; }
      s.oid = e.oid;
      regular.push(s);
    }
    const info = catFileCheck(repoPath, regular.map((s) => s.oid!), deadline);
    for (const s of regular) {
      const i = info.get(s.oid!)!;
      if (i.kind === 'missing' || i.type !== 'blob') { fail(s, 'target_unreadable'); continue; }
      if (i.size > MAX_FILE_BYTES) { fail(s, 'oversized'); continue; }
      s.size = i.size;
      ready.push(s);
    }
  } catch (err) {
    for (const s of pending) if (!out.has(s.path)) failOn(s, err, deadline);
    return out;
  }

  const groups: FileState[][] = [];
  let group: FileState[] = [];
  let groupBytes = 0;
  for (const s of ready) {
    if (group.length > 0 && groupBytes + s.size! > GROUP_TARGET_BYTES) { groups.push(group); group = []; groupBytes = 0; }
    group.push(s);
    groupBytes += s.size!;
  }
  if (group.length > 0) groups.push(group);

  for (const files of groups) {
    try {
      // 2. The targets' text, then one strict blame per file.
      const texts = new Map<string, string>();
      readObjects(repoPath, files.map((s) => ({ oid: s.oid!, size: s.size! })), deadline, (chunk) => {
        for (const [oid, text] of chunk) texts.set(oid, text);
      });
      const blamed: FileState[] = [];
      for (const s of files) {
        const text = texts.get(s.oid!);
        if (text === undefined) throw new GitBatchError('cat-file --batch lost an object');
        const problem = textProblem(text);
        if (problem) { fail(s, problem); continue; }
        s.targetText = text;
        const d = own();
        try {
          const blame = gitWithin(
            ['-c', 'core.quotePath=false', 'blame', '--line-porcelain', '--root', '--no-textconv',
              '--ignore-revs-file', '', targetRevision, '--', s.path],
            { cwd: repoPath, capMs: 15_000, maxBuffer: BLAME_MAX_BUFFER },
            d,
          );
          if (blame.status !== 0) { fail(s, 'blame_unreadable'); continue; }
          const parsed = parseBlamePorcelain(blame.stdout);
          if (!parsed.ok) { fail(s, 'blame_malformed'); continue; }
          s.origins = parsed.origins;
          blamed.push(s);
        } catch (err) {
          failOn(s, err, d);
        }
      }

      // 3. The notes of every revision blame named: one snapshot, one batch,
      //    bounded over the call. A listed note that cannot be read, or the
      //    bound, fails the group like any batch error; only a revision
      //    without a note is `no_record`.
      const revisions = new Set<string>();
      for (const s of blamed) for (const o of s.origins!) if (!ZERO_SHA.test(o.sourceRevision)) revisions.add(o.sourceRevision);
      const fresh = [...revisions].filter((rev) => !views.has(rev));
      if (fresh.length > 0) {
        notes ??= noteBlobs(repoPath, NOTES_REF, deadline);
        const ids = [...new Set(fresh.map((rev) => notes!.get(rev)).filter((id): id is string => id !== undefined))];
        let reads: Map<string, BlobRead>;
        try {
          reads = readBlobs(repoPath, ids, { maxBytes: MAX_NOTE_BYTES, totalBytes: CALL_NOTE_BYTES - noteBytes }, deadline);
        } catch (err) {
          // strictNotes: a listed note that could not be read in this call —
          // a git error or the read running out of time — is the caller's
          // error. Lenient callers keep the group-level failure (`timeout`,
          // `internal_error`); BatchTooLarge stays a bound for both.
          if (input.strictNotes && (err instanceof GitBatchError || err instanceof ProjectionTimeout)) throw new UnreadableNoteError();
          throw err;
        }
        for (const read of reads.values()) if (read.kind === 'text') noteBytes += Buffer.byteLength(read.text, 'utf-8');
        for (const rev of fresh) {
          const id = notes.get(rev);
          const read = id === undefined ? undefined : reads.get(id);
          if (!read) { views.set(rev, { kind: 'no_record' }); continue; }
          if (read.kind === 'missing' || read.kind === 'not_blob') {
            if (input.strictNotes) throw new UnreadableNoteError(rev);
            throw new GitBatchError('a listed note is unreadable');
          }
          // A note past MAX_NOTE_BYTES is not parsed: its claims are `record_invalid`.
          if (read.kind !== 'text') { views.set(rev, { kind: 'invalid' }); continue; }
          noteSnapshot.set(rev, read.text);
          const source = readSourceRecord(read.text, rev);
          if (source.kind !== 'record') { views.set(rev, { kind: source.kind }); continue; }
          records.set(rev, source.record);
          views.set(rev, viewOfRecord(source.record));
        }
      }

      // 4. Source blobs only for pairs whose record claims lines in that path.
      const aligned: FileState[] = [];
      for (const s of blamed) {
        const names = new Set<string>();
        for (const o of s.origins!) {
          const v = views.get(o.sourceRevision);
          if (v?.kind !== 'line_claims' || o.sourcePath === null || !v.byPath.has(o.sourcePath)) continue;
          // Git tree-entry identity: canonical repo paths compare exactly, case-sensitive even on a case-insensitive host (A.ts and a.ts are two entries).
          if (o.sourceRevision === targetRevision && o.sourcePath === s.path) continue; // path-compare-ok
          if (isCanonicalRepoPath(o.sourcePath)) names.add(`${o.sourceRevision}:${o.sourcePath}`);
        }
        if (names.size > MAX_ALIGNED_SOURCES) { fail(s, 'too_many_sources'); continue; }
        s.blobNames = [...names].sort();
        aligned.push(s);
      }
      const info = catFileCheck(repoPath, aligned.flatMap((s) => s.blobNames!), deadline);
      const readable = (name: string) => {
        const i = info.get(name);
        return i?.kind === 'object' && i.type === 'blob' && i.size <= MAX_FILE_BYTES ? i : null;
      };

      // 5. Resolve, holding at most GROUP_SOURCE_BYTES of sources at a time.
      let batch: FileState[] = [];
      let batchBytes = 0;
      const flush = () => {
        const wanted = new Map<string, number>();
        for (const s of batch) for (const n of s.blobNames!) { const i = readable(n); if (i) wanted.set(i.oid, i.size); }
        const sources = new Map<string, string>();
        readObjects(repoPath, [...wanted].map(([oid, size]) => ({ oid, size })), deadline, (chunk) => {
          for (const [oid, text] of chunk) sources.set(oid, text);
        });
        for (const s of batch) {
          finish(s, reanchorFileClaims({
            targetRevision,
            targetPath: s.path,
            targetText: s.targetText!,
            origins: s.origins!,
            sourceRecord: (rev) => views.get(rev) ?? { kind: 'no_record' },
            sourceText: (rev, path) => {
              const i = readable(`${rev}:${path}`);
              return i ? sources.get(i.oid) ?? null : null;
            },
            deadline: own(),
          }));
        }
        batch = [];
        batchBytes = 0;
      };
      for (const s of aligned) {
        let bytes = 0;
        for (const n of s.blobNames!) bytes += readable(n)?.size ?? 0;
        if (batch.length > 0 && batchBytes + bytes > GROUP_SOURCE_BYTES) flush();
        batch.push(s);
        batchBytes += bytes;
      }
      if (batch.length > 0) flush();
    } catch (err) {
      // strictNotes: an unreadable note is the caller's error, not one file's.
      if (err instanceof UnreadableNoteError) throw err;
      for (const s of files) if (!out.has(s.path)) failOn(s, err, deadline);
    }
  }
  return out;
}
