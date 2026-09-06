// Turning two recorded snapshots into a unified diff.
//
// This is the step that gets EASY once writes are observed instead of
// reconstructed, and it is worth saying why. apps/api's synthesizePromptDiff is
// ~650 lines because it solves a much harder problem: it receives a SEQUENCE OF
// PARTIAL EDITS with no reliable before-image and has to stitch them into
// something diff-shaped, inventing hunk offsets and de-duplicating edits that
// overlap. Every defect stage 0 found in stored diffs — hunk headers whose
// counts do not match their bodies, a created file whose diff removes lines,
// two diff texts concatenated — comes from that stitching.
//
// With a content-addressed journal there is nothing to stitch. The turn's
// before-state and after-state are both known exactly, so the diff is the plain
// answer to "what changed between these two strings", and it is correct by
// construction.
//
// Bounded on purpose: Myers is O(ND), so a pathological pair (a minified bundle
// rewritten wholesale) is capped and degrades to a whole-file replacement,
// which is TRUE — just less compact. It never degrades to a truncated hunk,
// because a truncated unified diff is not a worse diff, it is a corrupt one.

/** Above this edit distance, stop searching and emit a whole-file replace. */
export const MAX_EDIT_DISTANCE = 5000;
/** Context lines either side of a change, matching git's default. */
export const CONTEXT_LINES = 3;

type Op = { kind: 'eq' | 'del' | 'ins'; line: string };

/** The marker git writes when a file's final line has no terminating newline. */
const NO_EOL = '\\ No newline at end of file';

/** Does this content end without a terminating newline? */
function lacksEol(text: string | null): boolean {
  return text !== null && text !== '' && !text.endsWith('\n');
}

/**
 * Split content into lines for diffing.
 *
 * A trailing newline is a terminator, not an empty final line — treating it as
 * one makes every file look like it ends with a spurious blank that shows up as
 * a change the moment the newline is added or removed.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Myers' O(ND) diff, returning an edit script.
 *
 * Returns null when the edit distance exceeds `maxDistance` — the caller then
 * emits a whole-file replacement rather than an approximate diff.
 */
export function diffLines(a: string[], b: string[], maxDistance = MAX_EDIT_DISTANCE): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];

  const max = Math.min(n + m, maxDistance);
  // v[k] = furthest x reached on diagonal k. Offset so k can be negative.
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]; // down — an insertion
      } else {
        x = v[k - 1 + offset] + 1; // right — a deletion
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d, offset);
    }
  }
  return null; // exceeded the budget
}

/** Walk the recorded frontiers backwards into an edit script. */
function backtrack(a: string[], b: string[], trace: Int32Array[], d: number, offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let step = d; step > 0; step--) {
    const v = trace[step];
    const k = x - y;
    let prevK: number;
    if (k === -step || (k !== step && v[k - 1 + offset] < v[k + 1 + offset])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ kind: 'eq', line: a[x - 1] }); x--; y--; }
    if (x === prevX) { ops.push({ kind: 'ins', line: b[y - 1] }); y--; }
    else { ops.push({ kind: 'del', line: a[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ kind: 'eq', line: a[x - 1] }); x--; y--; }
  while (y > 0) { ops.push({ kind: 'ins', line: b[y - 1] }); y--; }
  while (x > 0) { ops.push({ kind: 'del', line: a[x - 1] }); x--; }
  return ops.reverse();
}

export interface FileDiffInput {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** Content before the turn. Null when the file did not exist. */
  before: string | null;
  /** Content after the turn. Null when the file was deleted. */
  after: string | null;
}

/**
 * Render one file's change as a `diff --git` section.
 *
 * Returns '' when nothing changed — a turn that wrote a file and put it back
 * produces no section, which is the correct rendering of a net-zero change.
 */
export function renderFileDiff(input: FileDiffInput, contextLines = CONTEXT_LINES): string {
  const { file } = input;
  const before = input.before;
  const after = input.after;
  if (before === null && after === null) return '';
  if (before === after) return '';

  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const header = [`diff --git a/${file} b/${file}`];
  if (before === null) header.push('new file mode 100644');
  else if (after === null) header.push('deleted file mode 100644');
  header.push(before === null ? '--- /dev/null' : `--- a/${file}`);
  header.push(after === null ? '+++ /dev/null' : `+++ b/${file}`);

  const beforeNoEol = lacksEol(before);
  const afterNoEol = lacksEol(after);

  let ops = diffLines(a, b);
  // Content differs but the LINES are identical, so the only change is the
  // trailing newline. That is a real change — git renders it by replacing the
  // final line with itself, differing only in the no-newline marker — and
  // rendering nothing here would silently lose it.
  if (ops !== null && !ops.some((o) => o.kind !== 'eq') && beforeNoEol !== afterNoEol && a.length > 0) {
    ops = [
      ...ops.slice(0, -1),
      { kind: 'del', line: a[a.length - 1] },
      { kind: 'ins', line: b[b.length - 1] },
    ];
  }

  const hunks = ops === null
    // Over budget: say so plainly as one replacement of the whole file. This is
    // an accurate diff, just not a minimal one.
    ? [renderWholeFile(a, b, beforeNoEol, afterNoEol)]
    : groupHunks(ops, contextLines, { beforeNoEol, afterNoEol });
  if (hunks.length === 0) return '';

  return `${header.join('\n')}\n${hunks.join('\n')}\n`;
}

function renderWholeFile(a: string[], b: string[], beforeNoEol: boolean, afterNoEol: boolean): string {
  const body: string[] = [];
  a.forEach((l, i) => { body.push(`-${l}`); if (i === a.length - 1 && beforeNoEol) body.push(NO_EOL); });
  b.forEach((l, i) => { body.push(`+${l}`); if (i === b.length - 1 && afterNoEol) body.push(NO_EOL); });
  return `@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@\n${body.join('\n')}`;
}

/**
 * Group an edit script into hunks with context.
 *
 * The hunk header's declared counts are computed from the body that is actually
 * emitted, never from the intended range — a header that disagrees with its
 * body is the single most common corruption stage 0 found, and it can only
 * happen when the two are derived separately.
 */
export function groupHunks(
  ops: Op[],
  contextLines = CONTEXT_LINES,
  eol: { beforeNoEol?: boolean; afterNoEol?: boolean } = {},
): string[] {
  // The last op consuming a line from each side — where a missing-newline
  // marker belongs. Computed from the script, so it stays correct however the
  // hunks are later grouped.
  let lastOld = -1;
  let lastNew = -1;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind !== 'ins') lastOld = i;
    if (ops[i].kind !== 'del') lastNew = i;
  }
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].kind !== 'eq') changed.push(i);
  if (changed.length === 0) return [];

  // Merge change positions into ranges that share context.
  const ranges: Array<[number, number]> = [];
  let lo = Math.max(0, changed[0] - contextLines);
  let hi = Math.min(ops.length - 1, changed[0] + contextLines);
  for (const idx of changed.slice(1)) {
    if (idx - contextLines <= hi + 1) {
      hi = Math.min(ops.length - 1, idx + contextLines);
    } else {
      ranges.push([lo, hi]);
      lo = Math.max(0, idx - contextLines);
      hi = Math.min(ops.length - 1, idx + contextLines);
    }
  }
  ranges.push([lo, hi]);

  // Line numbers are 1-based and advance over the WHOLE script, so each hunk
  // header starts where its first line actually sits in each file.
  const oldAt: number[] = new Array(ops.length);
  const newAt: number[] = new Array(ops.length);
  let oi = 1;
  let ni = 1;
  for (let i = 0; i < ops.length; i++) {
    oldAt[i] = oi;
    newAt[i] = ni;
    if (ops[i].kind !== 'ins') oi++;
    if (ops[i].kind !== 'del') ni++;
  }

  const out: string[] = [];
  for (const [start, end] of ranges) {
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i <= end; i++) {
      const op = ops[i];
      if (op.kind === 'eq') { body.push(` ${op.line}`); oldCount++; newCount++; }
      else if (op.kind === 'del') { body.push(`-${op.line}`); oldCount++; }
      else { body.push(`+${op.line}`); newCount++; }
      // The marker annotates the line just emitted and counts toward neither
      // side's line total, which is why it is appended here and not counted.
      const endsOld = i === lastOld && !!eol.beforeNoEol && op.kind !== 'ins';
      const endsNew = i === lastNew && !!eol.afterNoEol && op.kind !== 'del';
      if (endsOld || endsNew) body.push(NO_EOL);
    }
    const oldStart = oldCount === 0 ? Math.max(0, oldAt[start] - 1) : oldAt[start];
    const newStart = newCount === 0 ? Math.max(0, newAt[start] - 1) : newAt[start];
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join('\n')}`);
  }
  return out;
}

/** Render a whole turn: every file's section, concatenated in the given order. */
export function renderTurnDiff(files: readonly FileDiffInput[], contextLines = CONTEXT_LINES): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    // One section per file, always. Two sections for one path is not an
    // applyable patch — `capture-verify` reports it, so never emit it.
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    const s = renderFileDiff(f, contextLines);
    if (s) parts.push(s);
  }
  return parts.join('');
}
