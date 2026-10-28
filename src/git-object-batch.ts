// ---------------------------------------------------------------------------
// Origin CLI — bounded batch reads of git objects (OR-46)
// ---------------------------------------------------------------------------
// The line re-anchor (attribution-line-reanchor.ts), acceptance tracking
// (attribution.ts) and the rewrite projection (rewrite-line-projection.ts)
// read many small objects. One subprocess per object is what makes them
// slow, so every read here is a batch whose subprocess count does not grow
// with the number of objects:
//
//   catFileCheck  — one `cat-file --batch-check` for any number of names
//   readObjects   — `cat-file --batch` by object id, in chunks of at most
//                   BATCH_CHUNK_BYTES of content, framed by the byte sizes
//                   git prints, so no content can shift a later object
//   readBlobs     — the two above, with a per-object and an aggregate cap
//   treeEntries   — `ls-tree` of exact paths, in argument-bounded chunks
//   noteBlobs     — commit → note blob, one `notes list` (a missing notes
//                   ref is an empty snapshot; any git error throws)
//
// Every failure throws: a git error or a stream that does not frame is a
// GitBatchError, a child killed by its timeout a ProjectionTimeout. Callers
// fail closed on either; nothing here returns a partial read.
// ---------------------------------------------------------------------------

import { ProjectionTimeout, checkDeadline, gitTimeoutMs, type ProjectionDeadline } from './attribution-line-ranges.js';
import { gitDetailed, type RunOptions } from './utils/exec.js';

/** Content bytes one `cat-file --batch` subprocess returns at most (one larger object is read alone). */
export const BATCH_CHUNK_BYTES = 8 * 1024 * 1024;
/** Bytes of pathspec arguments one `ls-tree` or `diff-tree` gets; more paths take another call. */
export const MAX_PATHSPEC_ARG_BYTES = 128 * 1024;
const NOTES_LIST_MAX_BUFFER = 64 * 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A git failure or an output stream that does not frame. Never a timeout. */
export class GitBatchError extends Error {}

/** The objects to read add up to more than the caller's aggregate cap. Nothing was read. */
export class BatchTooLarge extends Error {}

/**
 * `gitDetailed` under a deadline: the child's timeout is what is left of it
 * (at most `capMs`), and a child killed by that timeout is a
 * ProjectionTimeout whatever the clock says afterwards.
 */
export function gitWithin(
  args: string[],
  opts: RunOptions & { capMs: number },
  deadline: ProjectionDeadline | undefined,
): { stdout: string; stderr: string; status: number } {
  const { capMs, ...rest } = opts;
  const r = gitDetailed(args, { ...rest, timeoutMs: gitTimeoutMs(deadline, capMs) });
  if (r.timedOut) throw new ProjectionTimeout();
  checkDeadline(deadline);
  return r;
}

export type ObjectInfo =
  | { kind: 'object'; oid: string; type: string; size: number }
  | { kind: 'missing' };

/**
 * Type and size of every name (`<oid>` or `<rev>:<path>`), one subprocess.
 * A name with a control character cannot be framed on git's line protocol and
 * is `missing` without being sent.
 */
export function catFileCheck(repoPath: string, names: readonly string[], deadline: ProjectionDeadline | undefined): Map<string, ObjectInfo> {
  const out = new Map<string, ObjectInfo>();
  const sent = [...new Set(names)].filter((n) => {
    if (n && !/[\u0000-\u001f]/.test(n)) return true;
    out.set(n, { kind: 'missing' });
    return false;
  });
  if (sent.length === 0) return out;
  const input = Buffer.from(sent.join('\n') + '\n', 'utf-8');
  // A missing name is echoed back, so the output is at most the input plus one header per name.
  const r = gitWithin(['cat-file', '--batch-check'], {
    cwd: repoPath, input, capMs: 10_000, maxBuffer: input.length + sent.length * 160 + 1024,
  }, deadline);
  if (r.status !== 0) throw new GitBatchError('cat-file --batch-check failed');
  const rows = r.stdout.split('\n');
  if (rows.length !== sent.length + 1 || rows[sent.length] !== '') throw new GitBatchError('cat-file --batch-check unframed');
  sent.forEach((name, k) => {
    const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(rows[k]);
    out.set(name, m ? { kind: 'object', oid: m[1], type: m[2], size: Number(m[3]) } : { kind: 'missing' });
  });
  return out;
}

/**
 * Split one `cat-file --batch` output (latin1: one char per byte) into the
 * requested objects, in order. Pure. Throws GitBatchError unless every header
 * names the requested object with the size checked before, every body ends
 * with its newline and nothing follows the last one.
 */
export function parseBatchOutput(raw: string, wanted: ReadonlyArray<{ oid: string; size: number }>): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  for (const w of wanted) {
    const nl = raw.indexOf('\n', pos);
    if (nl < 0) throw new GitBatchError('cat-file --batch truncated');
    const m = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(raw.slice(pos, nl));
    if (!m || m[1] !== w.oid || Number(m[2]) !== w.size) throw new GitBatchError('cat-file --batch unframed');
    const start = nl + 1;
    if (raw.length < start + w.size + 1 || raw[start + w.size] !== '\n') throw new GitBatchError('cat-file --batch truncated');
    out.set(w.oid, Buffer.from(raw.slice(start, start + w.size), 'latin1').toString('utf-8'));
    pos = start + w.size + 1;
  }
  if (pos !== raw.length) throw new GitBatchError('cat-file --batch unframed');
  return out;
}

/**
 * The contents of blobs by object id, sizes known in advance (catFileCheck).
 * One `cat-file --batch` per chunk of at most BATCH_CHUNK_BYTES; `onChunk`
 * gets each chunk's texts, so a caller that keeps none holds one chunk at a
 * time. Returns nothing itself.
 */
export function readObjects(
  repoPath: string,
  objects: ReadonlyArray<{ oid: string; size: number }>,
  deadline: ProjectionDeadline | undefined,
  onChunk: (texts: Map<string, string>) => void,
  chunkBytes: number = BATCH_CHUNK_BYTES,
): void {
  const unique = new Map<string, number>();
  for (const o of objects) if (OBJECT_ID.test(o.oid)) unique.set(o.oid, o.size);
  let chunk: Array<{ oid: string; size: number }> = [];
  let bytes = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    // latin1 keeps one char per byte, so git's byte sizes index the string.
    const r = gitWithin(['cat-file', '--batch'], {
      cwd: repoPath, input: Buffer.from(chunk.map((o) => o.oid).join('\n') + '\n', 'utf-8'), encoding: 'latin1',
      capMs: 15_000, maxBuffer: bytes + chunk.length * 128 + 1024,
    }, deadline);
    if (r.status !== 0) throw new GitBatchError('cat-file --batch failed');
    onChunk(parseBatchOutput(r.stdout, chunk));
    chunk = [];
    bytes = 0;
  };
  for (const [oid, size] of [...unique].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (chunk.length > 0 && bytes + size > chunkBytes) flush();
    chunk.push({ oid, size });
    bytes += size;
  }
  flush();
}

export type BlobRead = { kind: 'text'; text: string } | { kind: 'missing' | 'not_blob' | 'oversized' };

/**
 * Read objects by name with one `--batch-check` and as few `--batch` chunks as
 * their sizes need. A blob larger than `maxBytes` is `oversized` and never
 * read. When the blobs to read add up to more than `totalBytes`, throws
 * BatchTooLarge before reading any.
 */
export function readBlobs(
  repoPath: string,
  names: readonly string[],
  limits: { maxBytes: number; totalBytes?: number },
  deadline: ProjectionDeadline | undefined,
): Map<string, BlobRead> {
  const out = new Map<string, BlobRead>();
  if (names.length === 0) return out;
  const info = catFileCheck(repoPath, names, deadline);
  const wanted = new Map<string, number>();
  for (const name of names) {
    const i = info.get(name)!;
    if (i.kind === 'missing') out.set(name, { kind: 'missing' });
    else if (i.type !== 'blob') out.set(name, { kind: 'not_blob' });
    else if (i.size > limits.maxBytes) out.set(name, { kind: 'oversized' });
    else wanted.set(i.oid, i.size);
  }
  let total = 0;
  for (const size of wanted.values()) total += size;
  if (limits.totalBytes !== undefined && total > limits.totalBytes) throw new BatchTooLarge();
  const texts = new Map<string, string>();
  readObjects(repoPath, [...wanted].map(([oid, size]) => ({ oid, size })), deadline, (chunk) => {
    for (const [oid, text] of chunk) texts.set(oid, text);
  });
  for (const name of names) {
    if (out.has(name)) continue;
    const text = texts.get((info.get(name) as { oid: string }).oid);
    if (text === undefined) throw new GitBatchError('cat-file --batch lost an object');
    out.set(name, { kind: 'text', text });
  }
  return out;
}

/** Arguments split so no call's pathspecs pass MAX_PATHSPEC_ARG_BYTES. */
export function pathspecChunks(specs: readonly string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const s of specs) {
    const b = Buffer.byteLength(s, 'utf-8') + 1;
    if (cur.length > 0 && bytes + b > MAX_PATHSPEC_ARG_BYTES) { out.push(cur); cur = []; bytes = 0; }
    cur.push(s);
    bytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * `<mode> <oid>` of each exact path at `rev` that is in its tree, from
 * `ls-tree` with literal pathspecs. A path that is not there is absent from
 * the map; a revision git cannot list leaves the map empty — or, with
 * `strict`, throws GitBatchError, for a caller that reads absence as deletion.
 */
export function treeEntries(
  repoPath: string,
  rev: string,
  paths: readonly string[],
  deadline: ProjectionDeadline | undefined,
  opts: { strict?: boolean } = {},
): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const wanted = new Set(paths);
  for (const chunk of pathspecChunks([...wanted])) {
    const r = gitWithin(['ls-tree', '-z', rev, '--', ...chunk], {
      cwd: repoPath, capMs: 10_000, env: { GIT_LITERAL_PATHSPECS: '1' }, maxBuffer: 64 * 1024 * 1024,
    }, deadline);
    if (r.status !== 0) {
      if (opts.strict) throw new GitBatchError('ls-tree failed');
      return new Map();
    }
    for (const entry of r.stdout.split('\u0000')) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]*)$/.exec(entry);
      if (m && wanted.has(m[4])) out.set(m[4], { mode: m[1], oid: m[3] });
    }
  }
  return out;
}

/**
 * commit SHA → note blob SHA on `ref`, in one subprocess. A ref that does not
 * exist lists nothing with status 0: an empty snapshot. A non-zero exit or a
 * row that is not `<note> <commit>` is a GitBatchError — never "no notes".
 */
export function noteBlobs(repoPath: string, ref: string, deadline: ProjectionDeadline | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const r = gitWithin(['notes', `--ref=${ref}`, 'list'], { cwd: repoPath, capMs: 10_000, maxBuffer: NOTES_LIST_MAX_BUFFER }, deadline);
  if (r.status !== 0) throw new GitBatchError('notes list failed');
  const rows = r.stdout.split('\n');
  if (rows.pop() !== '') throw new GitBatchError('notes list unframed');
  for (const row of rows) {
    const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64})$/.exec(row);
    if (!m) throw new GitBatchError('notes list unframed');
    out.set(m[2], m[1]);
  }
  return out;
}
