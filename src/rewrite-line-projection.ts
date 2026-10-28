// ---------------------------------------------------------------------------
// Origin CLI — canonical line claims across an exact history rewrite (OR-46)
// ---------------------------------------------------------------------------
// An amend, a rebase, a cherry-pick or a squash makes a NEW commit out of old
// ones, and git (or CI) hands Origin the exact old→new mapping. The new commit
// is not a descendant of the old one, so ordinary re-anchoring through blame
// (attribution-line-reanchor.ts) cannot reach it. This module projects the old
// commits' canonical line claims onto the new commit, and nothing else; it
// writes no note. `rebuildRewrittenNote` (history-rewrite.ts) decides what the
// projected lines become.
//
// A line of the new commit carries a source claim only when all of these hold:
//
//   1. the source commit's own canonical record (readRecord, exact revision)
//      has exactly one claim on that source line (matchSourceClaim);
//   2. the file is the same path in the new commit, or an EXACT rename: git's
//      diff between the two trees pairs the path with exactly one new path at
//      100% similarity — or, when the old path now holds another blob, the
//      ONE path the new commit adds with exactly the source blob (a unique
//      exact-blob relocation; several such paths map nowhere). No similarity
//      threshold, no copy detection, no search for a "similar" file;
//   3. every optimal line alignment of the source blob onto the new blob pairs
//      the source line with this line (mandatoryAlignment), and the texts are
//      equal;
//   4. the new commit's own diff (against its first parent) adds the line.
//      A line the new commit inherited from its parent is not the rewritten
//      work, whatever it looks like.
//
// A merge commit as the target projects nothing (conflict resolution has no
// unique mapping). Claims of different sources or contributions that land on
// one line are left for the builder to drop: no winner is picked here.
//
// Bounded: one deadline for the whole projection (all-or-nothing, `timeout`),
// checked while claims are collected and while lines are swept; source notes
// bounded in bytes before they are parsed; declared ranges COUNTED before any
// is sorted or merged, and declared lines measured before a single one is
// walked; OR-45 file bounds on every blob, and the blobs of one projection
// bounded in total before any is read. Any limit gives an empty projection,
// and the rewrite stays commit-level exactly as OR-11 wrote it.
//
// Git work does not grow with the number of claimed files: one `rev-list`,
// one `cat-file --batch-check` for every claimed path in both trees, one
// exact-rename `diff-tree` per source commit that lost a path, one patch of
// the target restricted to the paths that matter, and chunked size-framed
// `cat-file --batch` reads of the blobs (git-object-batch.ts).
// ---------------------------------------------------------------------------

import {
  MAX_FILE_BYTES,
  MAX_FILE_LINES,
  ProjectionTimeout,
  checkDeadline,
  createProjectionDeadline,
  isCanonicalRepoPath,
  parseCommitPatch,
  withinBounds,
  type ProjectionDeadline,
} from './attribution-line-ranges.js';
import { linesOf, matchSourceClaim, sourceRecordView, type SourceLineRange } from './attribution-line-reanchor.js';
import { BatchTooLarge, catFileCheck, gitWithin, pathspecChunks, readObjects, type ObjectInfo } from './git-object-batch.js';
import { mandatoryAlignment } from './line-alignment.js';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Default budget of one projection: it runs inside the post-rewrite hook. */
export const REWRITE_PROJECTION_BUDGET_MS = 2_000;
/** Declared source lines one projection may walk; past it nothing is projected. */
export const MAX_REWRITE_CLAIM_LINES = 50_000;
/** Claimed source files one projection may read; past it nothing is projected. */
export const MAX_REWRITE_CLAIM_FILES = 500;
/** Declared source ranges one projection may sort; past it nothing is projected. */
export const MAX_REWRITE_CLAIM_RANGES = 20_000;
/** Bytes of one source note a projection parses; a larger note projects nothing. */
export const MAX_REWRITE_NOTE_BYTES = 1024 * 1024;
/** Bytes of all source and target blobs one projection reads; past it nothing is projected. */
export const MAX_REWRITE_BLOB_BYTES = 64 * 1024 * 1024;
/**
 * Bytes of one blob a projection reads. The OR-45 bound (withinBounds) counts
 * UTF-16 units, and a unit is at most three UTF-8 bytes; withinBounds still
 * decides on the text.
 */
const MAX_REWRITE_BLOB_READ_BYTES = 3 * MAX_FILE_BYTES;

/** One target line that carries one source contribution's claim. */
export interface ProjectedRewriteLine {
  /** The old commit whose record holds the claim. */
  sourceSha: string;
  /** Index of the contribution in that record. */
  contributionIndex: number;
  /** Path in the NEW commit. */
  path: string;
  /** 1-based line in the new commit's blob. */
  line: number;
}

export type RewriteProjectionReason =
  | 'target_not_commit'
  | 'merge_target'
  | 'too_many_claim_lines'
  | 'too_many_claim_files'
  | 'too_many_claim_ranges'
  | 'note_too_large'
  | 'too_many_claim_bytes'
  | 'timeout'
  | 'git_failed';

export interface RewriteLineProjection {
  lines: ProjectedRewriteLine[];
  /** Set when the projection as a whole produced nothing for a reason. */
  reason?: RewriteProjectionReason;
}

export interface ProjectRewriteInput {
  repoPath: string;
  /** Full sha of the new commit. */
  targetSha: string;
  /** The old commits' notes, exactly as the builder will read them. */
  sources: ReadonlyArray<{ sha: string; note: string }>;
  deadline?: ProjectionDeadline;
}

function mergedIntervals(ranges: readonly SourceLineRange[]): Array<[number, number]> {
  const sorted = ranges.map((r) => [r.startLine, r.endLine] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** A blob's lines within the OR-45 bounds; null when binary or oversized. */
function boundedLines(text: string | undefined): string[] | null {
  if (text === undefined || text.includes('\u0000') || !withinBounds(text)) return null;
  return linesOf(text);
}

/**
 * Project the canonical line claims of `sources` onto `targetSha` (see the
 * module comment). Never throws; an empty `lines` with or without `reason`
 * means the rewrite stays commit-level.
 */
export function projectRewriteLineClaims(input: ProjectRewriteInput): RewriteLineProjection {
  const deadline = input.deadline ?? createProjectionDeadline(REWRITE_PROJECTION_BUDGET_MS);
  const { repoPath } = input;
  const target = (input.targetSha || '').toLowerCase();
  const none = (reason?: RewriteProjectionReason): RewriteLineProjection => (reason ? { lines: [], reason } : { lines: [] });

  try {
    if (!FULL_SHA.test(target)) return none('target_not_commit');

    // 1. The claims, measured before any is walked.
    type ClaimFile = { sha: string; path: string; view: ReturnType<typeof sourceRecordView>; ranges: readonly SourceLineRange[] };
    const files: ClaimFile[] = [];
    let declared = 0;
    let rangeCount = 0;
    for (const s of input.sources) {
      checkDeadline(deadline);
      const sha = (s.sha || '').toLowerCase();
      if (!FULL_SHA.test(sha) || sha === target) continue;
      if (typeof s.note !== 'string' || Buffer.byteLength(s.note, 'utf8') > MAX_REWRITE_NOTE_BYTES) return none('note_too_large');
      const view = sourceRecordView(s.note, sha);
      if (view.kind !== 'line_claims') continue;
      for (const [filePath, ranges] of view.byPath) {
        checkDeadline(deadline);
        if (files.length >= MAX_REWRITE_CLAIM_FILES) return none('too_many_claim_files');
        // Counted before anything is sorted or merged: many overlapping ranges
        // can keep the union small and still cost the whole budget.
        rangeCount += ranges.length;
        if (rangeCount > MAX_REWRITE_CLAIM_RANGES) return none('too_many_claim_ranges');
        for (const [a, b] of mergedIntervals(ranges)) {
          declared += b - a + 1;
          if (declared > MAX_REWRITE_CLAIM_LINES) return none('too_many_claim_lines');
        }
        files.push({ sha, path: filePath, view, ranges });
      }
    }
    if (files.length === 0) return none();
    checkDeadline(deadline);

    // 2. The target: one commit, not a merge.
    const parentsLine = gitWithin(['rev-list', '--parents', '-n', '1', target], { cwd: repoPath, capMs: 10_000 }, deadline);
    if (parentsLine.status !== 0) return none('target_not_commit');
    const parents = parentsLine.stdout.trim().split(/\s+/).slice(1);
    if (parents.length > 1) return none('merge_target');

    // 3. Where each claimed path is: one check of every path in both trees.
    //    A source path outside the canonical contract has no readable blob.
    const claimed = files.filter((f) => isCanonicalRepoPath(f.path));
    const info = catFileCheck(repoPath, claimed.flatMap((f) => [`${target}:${f.path}`, `${f.sha}:${f.path}`]), deadline);

    // Exact renames source tree → target tree: old path → the ONE new path,
    // one diff-tree per source commit whose claimed path is gone or changed.
    // The same output also gives the paths the target ADDS, by blob: a unique
    // exact-blob relocation. When the old path is not deleted (a human wrote a
    // new file there), git shows M old + A new, never R100, though the agent's
    // blob moved unchanged to the new path.
    const treeDiffBySource = new Map<string, { renames: Map<string, string | null>; addedByOid: Map<string, string[]> }>();
    const treeDiff = (sha: string) => {
      if (!treeDiffBySource.has(sha)) {
        const r = gitWithin(['diff-tree', '-r', '-z', '--find-renames=100%', '--diff-filter=RA', '--no-ext-diff', sha, target],
          { cwd: repoPath, capMs: 15_000, maxBuffer: 16 * 1024 * 1024 }, deadline);
        if (r.status !== 0) throw new Error('diff-tree failed');
        const renames = new Map<string, string | null>();
        const addedByOid = new Map<string, string[]>();
        // Raw -z output: ":<modes> <oids> R100\0old\0new\0" per rename,
        // ":<modes> <oids> A\0new\0" per added path.
        const parts = r.stdout.split('\u0000');
        for (let i = 0; i < parts.length - 1;) {
          const header = parts[i].split(' ');
          const status = header[header.length - 1] ?? '';
          if (/^R\d*$/.test(status)) {
            if (status === 'R100') {
              const from = parts[i + 1];
              // A path git pairs twice is not paired at all.
              renames.set(from, renames.has(from) ? null : parts[i + 2]);
            }
            i += 3;
          } else {
            if (status === 'A' && header[3]) addedByOid.set(header[3], [...(addedByOid.get(header[3]) ?? []), parts[i + 1]]);
            i += 2;
          }
        }
        treeDiffBySource.set(sha, { renames, addedByOid });
      }
      return treeDiffBySource.get(sha)!;
    };
    const mapped: Array<ClaimFile & { targetPath: string }> = [];
    for (const f of [...claimed].sort((x, y) => (x.sha + x.path < y.sha + y.path ? -1 : 1))) {
      checkDeadline(deadline);
      const atTarget = info.get(`${target}:${f.path}`);
      const atSource = info.get(`${f.sha}:${f.path}`);
      let targetPath: string | null;
      if (atTarget?.kind !== 'object') {
        targetPath = treeDiff(f.sha).renames.get(f.path) ?? null;
      } else if (atSource?.kind === 'object' && atTarget.oid === atSource.oid) {
        targetPath = f.path;
      } else {
        // The old path holds another blob. One added path with exactly the
        // source blob is where the claimed lines went; none leaves the
        // modified old path to the mandatory alignment; several are not told
        // apart by order or similarity: the file maps nowhere (fail-closed).
        const exact = treeDiff(f.sha).renames.get(f.path) ?? null;
        const added = atSource?.kind === 'object' ? treeDiff(f.sha).addedByOid.get(atSource.oid) ?? [] : [];
        if (exact) targetPath = exact;
        else if (added.length === 1) targetPath = added[0];
        else if (added.length === 0) targetPath = f.path;
        else continue;
      }
      if (!targetPath || !isCanonicalRepoPath(targetPath) || targetPath.toLowerCase().endsWith('.ipynb')) continue;
      mapped.push({ ...f, targetPath });
    }
    if (mapped.length === 0) return { lines: [] };
    // Git tree-entry identity: canonical repo paths compare exactly, case-sensitive even on a case-insensitive host (A.ts and a.ts are two entries).
    // A case-only rename is a rename: its target entry must be checked too.
    const renamedTo = mapped.filter((f) => f.targetPath !== f.path).map((f) => `${target}:${f.targetPath}`); // path-compare-ok
    for (const [name, i] of catFileCheck(repoPath, renamedTo, deadline)) info.set(name, i);

    // 4. The lines the target itself adds (against its first parent): one
    //    patch, restricted to the target paths that matter.
    const targetPaths = [...new Set(mapped.map((f) => f.targetPath))].sort();
    const addedByPath = new Map<string, Set<number> | null>();
    for (const chunk of pathspecChunks(targetPaths.map((p) => `:(literal)${p}`))) {
      const r = gitWithin(
        ['-c', 'core.quotePath=false', 'diff-tree', '-r', '-p', '-U0', '--root', '--no-renames', '--no-color', '--no-ext-diff',
          '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', target, '--', ...chunk],
        { cwd: repoPath, capMs: 15_000, maxBuffer: 2 * MAX_REWRITE_BLOB_BYTES + 1024 * 1024 },
        deadline,
      );
      if (r.status !== 0) throw new Error('diff-tree failed');
      for (const fd of parseCommitPatch(r.stdout)) {
        if (fd.path === null || addedByPath.has(fd.path)) continue;
        addedByPath.set(fd.path, !fd.nonText && !fd.unparseable ? fd.addedLines : null);
      }
    }
    const addedLines = (p: string): Set<number> | null => addedByPath.get(p) ?? null;

    // 5. The blobs that can carry a line, bounded in total before any is read.
    const readable = (name: string): Extract<ObjectInfo, { kind: 'object' }> | null => {
      const i = info.get(name);
      return i?.kind === 'object' && i.type === 'blob' && i.size <= MAX_REWRITE_BLOB_READ_BYTES ? i : null;
    };
    const wanted = new Map<string, number>();
    for (const f of mapped) {
      const added = addedLines(f.targetPath);
      if (!added || added.size === 0) continue;
      const src = readable(`${f.sha}:${f.path}`);
      const tgt = readable(`${target}:${f.targetPath}`);
      if (!src || !tgt) continue;
      wanted.set(src.oid, src.size);
      wanted.set(tgt.oid, tgt.size);
    }
    let total = 0;
    for (const size of wanted.values()) total += size;
    if (total > MAX_REWRITE_BLOB_BYTES) throw new BatchTooLarge();
    const texts = new Map<string, string>();
    readObjects(repoPath, [...wanted].map(([oid, size]) => ({ oid, size })), deadline, (chunk) => {
      for (const [oid, text] of chunk) texts.set(oid, text);
    });
    const linesCache = new Map<string, string[] | null>();
    const blobLines = (name: string): string[] | null => {
      const i = readable(name);
      if (!i) return null;
      if (!linesCache.has(i.oid)) linesCache.set(i.oid, boundedLines(texts.get(i.oid)));
      return linesCache.get(i.oid)!;
    };

    // 6. Each claimed file, mapped on its own.
    const out: ProjectedRewriteLine[] = [];
    for (const f of mapped) {
      checkDeadline(deadline);
      const { targetPath } = f;
      const added = addedLines(targetPath);
      if (!added || added.size === 0) continue;
      const src = blobLines(`${f.sha}:${f.path}`);
      const tgt = blobLines(`${target}:${targetPath}`);
      if (!src || !tgt) continue;
      // A record whose ranges run past its own blob cannot hold the claim it states.
      if (f.ranges.some((r) => r.endLine > src.length)) continue;
      const toTarget = src.join('\n') === tgt.join('\n')
        ? src.map((_, k) => k)
        : mandatoryAlignment(src, tgt, { maxLines: MAX_FILE_LINES + 1, tick: () => checkDeadline(deadline) });

      // A sweep over the ranges sorted by start, so each line meets only the ranges covering it.
      const byStart = [...f.ranges].sort((a, b) => a.startLine - b.startLine);
      let next = 0;
      let active: SourceLineRange[] = [];
      for (const [a, b] of mergedIntervals(f.ranges)) {
        for (let line = a; line <= b; line++) {
          if ((line & 1023) === 0) checkDeadline(deadline);
          while (next < byStart.length && byStart[next].startLine <= line) active.push(byStart[next++]);
          active = active.filter((r) => r.endLine >= line);
          const m = matchSourceClaim({ kind: 'line_claims', byPath: new Map([[f.path, active]]) }, f.path, line);
          if (m.kind !== 'claim') continue;
          const j = toTarget[line - 1];
          if (j === undefined || j < 0 || src[line - 1] !== tgt[j] || !added.has(j + 1)) continue;
          out.push({ sourceSha: f.sha, contributionIndex: m.range.contributionIndex, path: targetPath, line: j + 1 });
        }
      }
    }
    return { lines: out };
  } catch (err) {
    if (err instanceof ProjectionTimeout) return none('timeout');
    if (err instanceof BatchTooLarge) return none('too_many_claim_bytes');
    return none('git_failed');
  }
}
