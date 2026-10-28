// ---------------------------------------------------------------------------
// Origin CLI — `origin export --format=line-claims <commit>` (OR-21 / M1)
// ---------------------------------------------------------------------------
// The offline materialisation boundary for hosting integrations. For one
// commit C it answers, for every file C itself changed, which of its lines are
// still proven to be a contribution's — the OR-46 re-anchoring result in
// C's own coordinates — as one JSON document (`origin-line-claims/1`).
//
// Why only the files C changed ("anchor paths"): a later revision Y shows a
// file P exactly as the last commit L that changed it (`git rev-list -1 Y -- P`),
// so a reader looks P up under L. Materialising every path of every pushed tree
// would redo the same blame for every unchanged file.
//
//   1. candidates  one `git diff-tree -r -z --no-renames --root -c --name-only C`:
//                  a root commit's whole tree, a commit's changed paths, a
//                  merge's paths that differ from EVERY parent (combined diff);
//                  read as bytes, each path strict UTF-8 or the export fails
//   2. filter      one strict batch `ls-tree`: only paths with an entry in C
//                  (100644, 100755, 120000, 160000) — deletions and a path that
//                  became a directory are dropped before anything is counted
//   3. notes       one `notes list`: the snapshot every note is read through
//   4. resolve     `resolveFilesAtRevision` — the OR-46 proof, never redone here;
//                  a listed note it needs but cannot read fails the export
//   5. document    claims whose identity and record fingerprint the same note
//                  snapshot proves; every other line stays `unresolved`
//
// Read-only and offline: no fetch, no network, no note or ref is written. The
// document carries no source or target text, prompt, session id, author or
// note payload — only revisions, paths, line numbers, record indices, the
// agent/model ids and the record fingerprints a reader needs to re-check them.
// ---------------------------------------------------------------------------

import { ATTRIBUTION_RECORD_PRODUCER } from './attribution-note.js';
import { ProjectionTimeout } from './attribution-line-ranges.js';
import {
  UnreadableNoteError,
  resolveFilesAtRevision,
  type FileReanchorResult,
  type LineReanchorReason,
  type ReanchoredLineClaim,
  type ResolvedFileAtRevision,
} from './attribution-line-reanchor.js';
import { parseRecordFingerprint } from './attribution-record-fingerprint.js';
import { cliVersion } from './cli-version.js';
import { GitBatchError, gitWithin, noteBlobs, treeEntries } from './git-object-batch.js';
import { gitDetailed } from './utils/exec.js';

export const LINE_CLAIMS_PROTOCOL = 'origin-line-claims/1';
export const LINE_CLAIMS_PATH_SELECTION = 'anchor/1';
export const DEFAULT_MAX_PATHS = 1000;
export const HARD_MAX_PATHS = 5000;
/** A document larger than this is not printed: `output_over_limit` instead. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const NOTES_REF = 'refs/notes/origin';
const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The modes a file view can show; a tree (040000) is not a file. */
const FILE_MODES = new Set(['100644', '100755', '120000', '160000']);
const DIFF_TREE_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_CAP_MS = 60_000;

/** Why the line-claims export produced no document. Never raised for one file's failure. */
export class LineClaimsExportError extends Error {
  constructor(readonly kind: 'usage' | 'git', message: string) {
    super(message);
    this.name = 'LineClaimsExportError';
  }
}

/** Reasons this module adds to OR-46's for a claim it cannot export. */
export type LineClaimsUnresolvedReason = LineReanchorReason | 'identity_unproven' | 'fingerprint_unavailable';

export interface LineClaimsClaim {
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
  agent_id: string | null;
  model_id: string | null;
}

export interface LineClaimsUnresolved {
  start_line: number;
  end_line: number;
  reason: LineClaimsUnresolvedReason;
}

export type LineClaimsFile =
  | { path: string; status: 'resolved'; line_count: number; claims: LineClaimsClaim[]; unresolved: LineClaimsUnresolved[] }
  | { path: string; status: 'failed'; failure: string };

export interface LineClaimsDocument {
  protocol: typeof LINE_CLAIMS_PROTOCOL;
  path_selection: typeof LINE_CLAIMS_PATH_SELECTION;
  revision: { vcs: 'git'; id: string };
  producer: { name: string; version: string };
  status: 'complete' | 'paths_over_limit' | 'output_over_limit';
  sources: Record<string, { record_fingerprint: string }>;
  files: LineClaimsFile[];
}

export interface LineClaimsExportOptions {
  /** Paths after the tree-entry filter above which nothing is resolved; 1..HARD_MAX_PATHS. */
  maxPaths?: number;
  /** Test seam; defaults to MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
}

/** Byte order of the UTF-8 encoding: the order the document lists paths and sources in. */
function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

/** Throws a `usage` error unless `arg` is one full, lowercase-able commit id. */
export function validateLineClaimsCommit(arg: unknown): string {
  if (typeof arg !== 'string' || !FULL_COMMIT_ID.test(arg.toLowerCase())) {
    throw new LineClaimsExportError('usage', 'line-claims takes exactly one full 40- or 64-character commit id, not a range, ref or abbreviation.');
  }
  return arg.toLowerCase();
}

/** Throws a `usage` error unless `value` is an integer from 1 to HARD_MAX_PATHS. */
export function parseMaxPaths(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_PATHS;
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(n) || n < 1 || n > HARD_MAX_PATHS) {
    throw new LineClaimsExportError('usage', `--max-paths must be an integer from 1 to ${HARD_MAX_PATHS}.`);
  }
  return n;
}

function gitFailure(what: string, r: { stderr: string; status: number }): LineClaimsExportError {
  // stderr of rev-parse/diff-tree/ls-tree names refs and paths, never note text.
  const detail = r.stderr.trim().split('\n')[0] || `exit status ${r.status}`;
  return new LineClaimsExportError('git', `${what}: ${detail}`);
}

/** The directory git paths are relative to: the work tree's top level, or the git dir of a bare repository. */
function repositoryRoot(cwd: string): string {
  const bare = gitDetailed(['rev-parse', '--is-bare-repository'], { cwd });
  if (bare.status !== 0) throw gitFailure('not a git repository', bare);
  const arg = bare.stdout.trim() === 'true' ? '--absolute-git-dir' : '--show-toplevel';
  const r = gitDetailed(['rev-parse', arg], { cwd });
  if (r.status !== 0 || !r.stdout.trim()) throw gitFailure('could not locate the repository', r);
  return r.stdout.trim();
}

/** `commit` names a commit object of this repository, exactly. */
function verifyCommit(repoPath: string, commit: string): void {
  // `commit` is validated hex, so it can never be read as an option.
  const r = gitDetailed(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { cwd: repoPath });
  if (r.status !== 0 || r.stdout.trim() !== commit) {
    throw new LineClaimsExportError('git', `${commit} is not a commit of this repository.`);
  }
}

/**
 * The NUL-terminated paths of `diff-tree -z`, each decoded as strict UTF-8.
 * `raw` is git's output read byte for byte (latin1). Empty output is no path;
 * otherwise every field must be non-empty and end with NUL — a missing final
 * NUL or an empty field is a stream that does not frame, never a path. A path
 * whose bytes are not UTF-8 cannot be written into the document or named back
 * to git as a string. Either fails the whole export, redacted: the bytes are
 * never echoed. A valid path that contains U+FFFD itself is an ordinary path.
 */
export function decodeGitPaths(raw: string, commit: string): string[] {
  const bytes = Buffer.from(raw, 'latin1');
  const unframed = () => new LineClaimsExportError('git', `git listed the paths ${commit} changed in a stream that does not frame.`);
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0) throw unframed();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue;
    if (i === start) throw unframed();
    try {
      out.push(decoder.decode(bytes.subarray(start, i)));
    } catch {
      throw new LineClaimsExportError('git', `${commit} changes a path whose name is not valid UTF-8.`);
    }
    start = i + 1;
  }
  return out;
}

/**
 * Anchor paths of `commit` (see the header): candidates from one combined
 * `diff-tree`, kept only when the commit's tree has a file entry for them.
 */
export function selectAnchorPaths(repoPath: string, commit: string): string[] {
  const r = gitWithin(['diff-tree', '-r', '-z', '--no-commit-id', '--no-renames', '--root', '-c', '--name-only', commit, '--'], {
    cwd: repoPath, capMs: GIT_CAP_MS, maxBuffer: DIFF_TREE_MAX_BUFFER, encoding: 'latin1',
  }, undefined);
  if (r.status !== 0) throw gitFailure(`git could not list the paths ${commit} changed`, r);
  const candidates = [...new Set(decodeGitPaths(r.stdout, commit))];
  const entries = treeEntries(repoPath, commit, candidates, undefined, { strict: true });
  return candidates.filter((p) => FILE_MODES.has(entries.get(p)?.mode ?? ''));
}

function mergeRuns(runs: LineClaimsUnresolved[]): LineClaimsUnresolved[] {
  const out: LineClaimsUnresolved[] = [];
  for (const run of [...runs].sort((a, b) => a.start_line - b.start_line)) {
    const last = out[out.length - 1];
    if (last && last.reason === run.reason && last.end_line === run.start_line - 1) last.end_line = run.end_line;
    else out.push({ ...run });
  }
  return out;
}

/**
 * The number of lines a resolved result covers, or null when its claims and
 * unresolved runs do not partition 1..N exactly (never expected from OR-46;
 * the file then fails closed instead of exporting a shifted partition).
 */
function partitionLength(result: FileReanchorResult): number | null {
  const runs = [...result.claims, ...result.unresolved].map((r) => [r.start_line, r.end_line] as const)
    .sort((a, b) => a[0] - b[0]);
  let next = 1;
  for (const [s, e] of runs) {
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || s !== next || e < s) return null;
    next = e + 1;
  }
  return next - 1;
}

/**
 * One file's entry and the sources its exported claims prove. A claim is
 * exported only when the snapshot it was proven on re-proves its identity AND
 * gives its record a `/1` fingerprint; otherwise its lines are unresolved.
 */
function fileEntry(path: string, resolved: ResolvedFileAtRevision | undefined): { file: LineClaimsFile; sources: Map<string, string> } {
  const sources = new Map<string, string>();
  if (!resolved) return { file: { path, status: 'failed', failure: 'internal_error' }, sources };
  const { result } = resolved;
  if (result.status === 'failed') return { file: { path, status: 'failed', failure: result.failure ?? 'internal_error' }, sources };
  const lineCount = partitionLength(result);
  if (lineCount === null) return { file: { path, status: 'failed', failure: 'internal_error' }, sources };

  const claims: LineClaimsClaim[] = [];
  const unresolved: LineClaimsUnresolved[] = result.unresolved.map((u) => ({ ...u }));
  const drop = (c: ReanchoredLineClaim, reason: LineClaimsUnresolvedReason) =>
    unresolved.push({ start_line: c.start_line, end_line: c.end_line, reason });
  for (const c of result.claims) {
    const identity = resolved.identityOf(c);
    if (!identity) { drop(c, 'identity_unproven'); continue; }
    const fingerprint = identity.recordFingerprint;
    if (parseRecordFingerprint(fingerprint).kind !== 'ok') { drop(c, 'fingerprint_unavailable'); continue; }
    const known = sources.get(c.source_revision);
    // One call reads one note snapshot per revision: two fingerprints for one
    // source would mean two records, and neither can be trusted.
    if (known !== undefined && known !== fingerprint) return { file: { path, status: 'failed', failure: 'internal_error' }, sources: new Map() };
    sources.set(c.source_revision, fingerprint!);
    claims.push({
      start_line: c.start_line,
      end_line: c.end_line,
      source_revision: c.source_revision,
      source_path: c.source_path,
      source_start_line: c.source_start_line,
      source_end_line: c.source_end_line,
      contribution_index: c.contribution_index,
      file_index: c.file_index,
      range_index: c.range_index,
      ...(c.iteration_index !== undefined ? { iteration_index: c.iteration_index } : {}),
      agent_id: identity.agentId ?? null,
      model_id: identity.modelId ?? null,
    });
  }
  return { file: { path, status: 'resolved', line_count: lineCount, claims, unresolved: mergeRuns(unresolved) }, sources };
}

function document(commit: string, status: LineClaimsDocument['status'], sources: Map<string, string>, files: LineClaimsFile[]): LineClaimsDocument {
  const sorted: Record<string, { record_fingerprint: string }> = {};
  for (const rev of [...sources.keys()].sort(byBytes)) sorted[rev] = { record_fingerprint: sources.get(rev)! };
  return {
    protocol: LINE_CLAIMS_PROTOCOL,
    path_selection: LINE_CLAIMS_PATH_SELECTION,
    revision: { vcs: 'git', id: commit },
    producer: { name: ATTRIBUTION_RECORD_PRODUCER, version: cliVersion() },
    status,
    sources: sorted,
    files,
  };
}

const serialize = (doc: LineClaimsDocument) => JSON.stringify(doc) + '\n';

/**
 * The `origin-line-claims/1` document of `commitArg` in the repository at
 * `cwd`, and its exact serialisation (one line of JSON). Throws
 * LineClaimsExportError — `usage` before anything is read, `git` when the
 * repository, the commit, its tree, a changed path's name (not UTF-8), the
 * notes ref or a listed note of a revision the files need cannot be read. A
 * file that cannot be resolved otherwise is a `failed` entry, never an error
 * of the whole.
 */
export function exportLineClaims(
  cwd: string,
  commitArg: string,
  opts: LineClaimsExportOptions = {},
): { document: LineClaimsDocument; output: string } {
  const commit = validateLineClaimsCommit(commitArg);
  const maxPaths = parseMaxPaths(opts.maxPaths);
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  const repoPath = repositoryRoot(cwd);
  verifyCommit(repoPath, commit);
  let paths: string[];
  let notes: ReadonlyMap<string, string>;
  try {
    paths = selectAnchorPaths(repoPath, commit);
    // The export's one notes snapshot: the resolver reads every note through
    // it. A broken ref fails here; a missing ref is an empty snapshot.
    notes = noteBlobs(repoPath, NOTES_REF, undefined);
  } catch (err) {
    if (err instanceof LineClaimsExportError) throw err;
    if (err instanceof GitBatchError || err instanceof ProjectionTimeout) {
      throw new LineClaimsExportError('git', `git could not read ${commit}'s tree or ${NOTES_REF}`);
    }
    throw err;
  }

  if (paths.length > maxPaths) {
    const doc = document(commit, 'paths_over_limit', new Map(), []);
    return { document: doc, output: serialize(doc) };
  }

  // No shared deadline: each file keeps OR-46's own per-file budget, so one
  // slow file cannot change another file's result. strictNotes: a note the
  // snapshot lists for a revision these files need but git cannot read fails
  // the whole export, never one file as `internal_error`.
  let resolved: Map<string, ResolvedFileAtRevision>;
  try {
    resolved = resolveFilesAtRevision({ repoPath, targetRevision: commit, targetPaths: paths, notes, strictNotes: true });
  } catch (err) {
    if (err instanceof UnreadableNoteError) throw new LineClaimsExportError('git', err.message);
    throw err;
  }
  const sources = new Map<string, string>();
  const files: LineClaimsFile[] = [];
  for (const path of paths) {
    const entry = fileEntry(path, resolved.get(path));
    for (const [rev, fp] of entry.sources) sources.set(rev, fp);
    files.push(entry.file);
  }
  files.sort((a, b) => byBytes(a.path, b.path));

  const doc = document(commit, 'complete', sources, files);
  const output = serialize(doc);
  if (Buffer.byteLength(output, 'utf-8') > maxOutputBytes) {
    const over = document(commit, 'output_over_limit', new Map(), []);
    return { document: over, output: serialize(over) };
  }
  return { document: doc, output };
}
