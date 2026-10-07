// OR-12/A6: the read boundary behind `origin export --format=json <range>`.
//
// A consumer gets the canonical v1 attribution records of a commit range and
// nothing else: not the note envelope, not the legacy `origin` payload, not the
// ref they live on. Every record goes through readRecord(), so a newer 1.x
// minor comes out as its 1.0 projection, and an unsupported or invalid record
// never reaches a consumer as a claim: it is reported as skipped. Whether a
// skip fails the whole export (`--strict`) is the command's decision, not the
// reader's; a Git failure always does.
//
// Read-only and offline: one `git rev-list`, one `git notes list`, and one
// `git cat-file` per commit that has a note. No fetch, no fold, no write.
import { gitDetailed } from './utils/exec.js';
import { readRecord } from './attribution-record.js';

/** The live attribution notes ref. Never a staging ref, memory notes or the API. */
export const ATTRIBUTION_NOTES_REF = 'refs/notes/origin';

/** Where a canonical record sits inside the note envelope. */
const RECORD_KEY = 'attribution_record';

const GIT_TIMEOUT_MS = 120_000;

// The characters `origin ci check --range` accepts (ci-integration.ts), with
// one optional `..`/`...`. Neither side may start with `-`, so a range can
// never turn into a git option; `--end-of-options` and the trailing `--` make
// that hold even if this pattern is ever widened.
const RANGE_CHARS = /^[A-Za-z0-9_./~^-]+$/;

export type AttributionExportErrorKind =
  /** The range itself is not acceptable; nothing was read. */
  | 'usage'
  /** Git failed: an unresolvable range, not a repository, a broken notes ref, an unreadable note. */
  | 'git';

/** A failure of the export itself. Never raised for one commit's unusable note. */
export class AttributionExportError extends Error {
  constructor(readonly kind: AttributionExportErrorKind, message: string) {
    super(message);
    this.name = 'AttributionExportError';
  }
}

/** Why a commit's note carries a record that cannot be exported. */
export type UnusableReason = 'not-json' | 'not-object' | 'unsupported' | 'invalid' | 'revision-mismatch';

/**
 * One note: no canonical record (no `attribution_record` key — a legacy-only
 * note), a record to export, or a record that must not be used. `message` is
 * built from fixed text and never quotes the note.
 */
export type NoteRead =
  | { status: 'none' }
  | { status: 'record'; record: Record<string, unknown> }
  | { status: 'unusable'; reason: UnusableReason; message: string };

export interface SkippedRecord { sha: string; reason: UnusableReason; message: string }

export interface AttributionExport {
  /** Exported records, oldest first. */
  records: Record<string, unknown>[];
  /** Commits whose note carries an unusable record, in the same order. */
  skipped: SkippedRecord[];
}

/** Throws a `usage` error unless `range` is a plain revision or `A..B` / `A...B`. */
export function validateExportRange(range: string): string {
  if (typeof range !== 'string' || range.length === 0) {
    throw new AttributionExportError('usage', 'The range is empty.');
  }
  if (!RANGE_CHARS.test(range)) {
    throw new AttributionExportError(
      'usage',
      `Unsupported range "${printable(range)}": use a revision, A..B or A...B made of letters, digits and _ . / ~ ^ -.`,
    );
  }
  const sides = range.split(/\.{2,3}/);
  if (sides.length > 2 || /\.{4,}/.test(range)) {
    throw new AttributionExportError('usage', `Unsupported range "${range}": at most one .. or ... is allowed.`);
  }
  if (sides.some((side) => side.startsWith('-'))) {
    throw new AttributionExportError('usage', `Unsupported range "${range}": a revision may not start with "-".`);
  }
  return range;
}

function printable(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function gitError(what: string, r: { stderr: string; status: number }): AttributionExportError {
  const detail = r.stderr.trim().split('\n')[0] || `exit status ${r.status}`;
  return new AttributionExportError('git', `${what}: ${detail}`);
}

/** Full commit shas of `range`, parents before children, each once. */
export function listRangeCommits(repoPath: string, range: string): string[] {
  validateExportRange(range);
  const r = gitDetailed(
    ['rev-list', '--topo-order', '--reverse', '--end-of-options', range, '--'],
    { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (r.status !== 0) throw gitError(`git could not resolve the range "${range}"`, r);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** annotated commit → note blob, for every note on the live ref. */
function listNotes(repoPath: string): Map<string, string> {
  // A missing ref lists nothing with status 0; a broken one fails.
  const r = gitDetailed(['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'list'], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
  if (r.status !== 0) throw gitError(`git could not list ${ATTRIBUTION_NOTES_REF}`, r);
  const notes = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const [blob, annotated] = line.trim().split(/\s+/);
    if (blob && annotated) notes.set(annotated.toLowerCase(), blob);
  }
  return notes;
}

function readNoteBlob(repoPath: string, sha: string, blob: string): string {
  const r = gitDetailed(['cat-file', 'blob', blob], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
  if (r.status !== 0) throw gitError(`git could not read the note of ${sha}`, r);
  return r.stdout;
}

const unusable = (reason: UnusableReason, message: string): NoteRead => ({ status: 'unusable', reason, message });

/** Reads the note attached to `sha`. Never throws: storage is Git's, the note is data. */
export function recordFromNote(sha: string, noteText: string): NoteRead {
  let envelope: unknown;
  try {
    envelope = JSON.parse(noteText);
  } catch {
    return unusable('not-json', 'the note is not JSON');
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return unusable('not-object', 'the note is not a JSON object');
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, RECORD_KEY)) return { status: 'none' };

  const read = readRecord((envelope as Record<string, unknown>)[RECORD_KEY]);
  // readRecord reports `unsupported` only for a parsed MAJOR.MINOR, so the
  // version is digits and a dot, safe to repeat.
  if (read.status === 'unsupported') return unusable('unsupported', `unsupported schema_version ${read.version}`);
  if (read.status === 'invalid') {
    return unusable('invalid', read.reason === 'schema_version'
      ? 'the attribution record has no valid schema_version'
      : 'the attribution record fails validation');
  }
  const record = read.record;
  if (record.revision?.vcs !== 'git' || record.revision?.id !== sha) {
    return unusable('revision-mismatch', 'the attribution record names another revision');
  }
  // A projection is already a copy; an exact record is the parsed envelope's.
  return { status: 'record', record: read.status === 'projected' ? record : structuredClone(record) };
}

/**
 * Canonical v1 records of `range`, oldest first, and the commits whose note
 * carries an unusable record. Commits without a note, or whose note carries no
 * record, appear in neither. A Git failure throws an AttributionExportError
 * and returns nothing.
 */
export function exportAttributionRecords(repoPath: string, range: string): AttributionExport {
  const result: AttributionExport = { records: [], skipped: [] };
  const commits = listRangeCommits(repoPath, range);
  if (commits.length === 0) return result;
  const notes = listNotes(repoPath);
  for (const sha of commits) {
    const blob = notes.get(sha);
    if (!blob) continue;
    const read = recordFromNote(sha, readNoteBlob(repoPath, sha, blob));
    if (read.status === 'record') result.records.push(read.record);
    else if (read.status === 'unusable') result.skipped.push({ sha, reason: read.reason, message: read.message });
  }
  return result;
}
