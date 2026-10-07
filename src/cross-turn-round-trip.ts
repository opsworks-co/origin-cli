/**
 * Work one turn took off the tree and the next turn put back is no turn's.
 *
 * A turn that removes a file's change and puts it back within itself already
 * nets to nothing: its window starts and ends on the same bytes. When a prompt
 * lands in between, the removal is one turn's window and the restore the
 * next's, and each window alone shows the whole change.
 *
 * Session df8cc9aa (2026-10-01): turn 8 wrote a fix (+311/-7). On turn 9 the
 * agent saved the fixed files to its scratchpad and reset them to main, to
 * prove the new test failed without the fix: +6/-306. Turn 10's prompt
 * arrived mid-work; the agent copied the fix back and committed it, and the
 * commit patch billed turn 10 +309/-9. verify-capture: "the same ordered
 * additions and deletions on turns 8, 10".
 *
 * For adjacent turns p and j, a file is a round trip when p changed it
 * (start(p) != end(p)), nothing touched it between them (end(p) == start(j)),
 * j ended on exactly the bytes p started from (end(j) == start(p)), AND those
 * bytes were an EARLIER turn's own work: walking back from p over turns that
 * left the file alone, some turn q wrote exactly start(p). That last
 * condition is what tells a put-back from a revert. Turn 8 writing the fix
 * and turn 9 removing it matches the first three by bytes, but what turn 9
 * removed is turn 8's NEW work — the discarded-work pill's case
 * (discarded-by-later-turn.ts), left alone here. Blob ids are the proof, so a
 * look-alike edit never qualifies. The file leaves
 * both rows: what is left is re-counted, the rows go out content-authoritative
 * like dropInheritedFilesFromTurns', and `inheritedFiles` takes the file's
 * watched-only edits off both cards (trim-watched-edits.ts). The turn this
 * Stop closes has no end shadow yet; its end is the live tree.
 *
 * Mutates in place, never throws. Returns how many rows changed.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { turnWindowEndShadow } from './restored-from-history.js';
import { localTurnForServerRow } from './turn-index.js';
import { withoutFiles, type InheritedFilesRow, type InheritedFilesState } from './drop-inherited-files.js';

export interface RoundTripDeps {
  /**
   * The blob id of each of `files` in the tree of commit `sha`, or in the live
   * working tree when `sha` is null. A file absent there maps to ''. A file
   * git could not answer for is left out of the map.
   */
  blobs: (sha: string | null, files: string[]) => Map<string, string>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const norm = (f: string) => f.replace(/\\/g, '/');

/** How far back a put-back's bytes are traced to the turn that wrote them. */
const MAX_LOOKBACK = 20;

function sectionFiles(diff: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of String(diff || '').split(/(?=^diff --git )/m)) {
    const m = part.match(/^diff --git a\/(.*?) b\/(.*)$/m);
    if (m) out.push(norm(m[2] || m[1]));
  }
  return out;
}

function rowFiles(pm: InheritedFilesRow): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(pm.filesChanged)) {
    for (const f of pm.filesChanged) if (typeof f === 'string' && f) out.add(norm(f));
  }
  for (const f of sectionFiles(pm.diff)) out.add(f);
  for (const f of sectionFiles(pm.uncommittedDiff)) out.add(f);
  return out;
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

function dropFromRow(pm: InheritedFilesRow, drop: Set<string>): void {
  pm.filesChanged = (Array.isArray(pm.filesChanged) ? pm.filesChanged : [])
    .filter((f) => typeof f === 'string' && !drop.has(norm(f)));
  pm.diff = withoutFiles(pm.diff, drop);
  if (typeof pm.uncommittedDiff === 'string') pm.uncommittedDiff = withoutFiles(pm.uncommittedDiff, drop);
  if (Array.isArray(pm.contentUnavailableFiles)) {
    pm.contentUnavailableFiles = pm.contentUnavailableFiles.filter((f) => !drop.has(norm(f)));
  }
  const { added, removed } = countLines(`${pm.diff}\n${pm.uncommittedDiff || ''}`);
  pm.linesAdded = added;
  pm.linesRemoved = removed;
  if ((pm.filesChanged as string[]).length === 0 && !pm.diff.trim() && !String(pm.uncommittedDiff || '').trim()) {
    pm.chatOnly = true;
    // Same marker as dropInheritedFilesFromTurns: later Stops re-send the
    // blank with the authority that makes the server drop its stale list.
    pm.emptiedOfInheritedFiles = true;
  }
  pm.contentAuthoritative = true;
  pm.inheritedFiles = [...new Set([...(pm.inheritedFiles || []), ...drop])].sort();
}

export function dropCrossTurnRoundTrips(
  state: InheritedFilesState,
  mappings: InheritedFilesRow[],
  deps: RoundTripDeps,
): number {
  const shadows = state.promptShadows || [];
  if (!Array.isArray(mappings) || shadows.length < 2) return 0;
  const byLocal = new Map<number, InheritedFilesRow>();
  for (const pm of mappings) {
    if (!pm || !Number.isInteger(pm.promptIndex)) continue;
    const local = localTurnForServerRow(pm.promptIndex, state.promptIndexBase);
    if (local !== null) byLocal.set(local, pm);
  }
  const lastLocal = Array.isArray(state.prompts) ? state.prompts.length - 1 : -1;
  const changedRows = new Set<number>();
  // One git read per (tree, file set) however many pairs ask.
  const cache = new Map<string, Map<string, string>>();
  const blobs = (sha: string | null, files: string[]) => {
    const key = `${sha ?? 'live'}\0${files.join('\0')}`;
    let hit = cache.get(key);
    if (!hit) { hit = deps.blobs(sha, files); cache.set(key, hit); }
    return hit;
  };
  // Some turn before `p` wrote exactly `bytes` into `file`, and every turn in
  // between left it alone.
  const writtenByEarlierTurn = (p: number, file: string, bytes: string): boolean => {
    let expected = bytes;
    for (let q = p - 1; q >= 0 && q >= p - MAX_LOOKBACK; q--) {
      const startQ = shadows.find((s) => s.promptIndex === q);
      const endQ = turnWindowEndShadow(state, q);
      if (!startQ?.shadowSha || !endQ?.shadowSha) return false;
      const e = blobs(endQ.shadowSha, [file]).get(file);
      if (e === undefined || e !== expected) return false;
      const st = blobs(startQ.shadowSha, [file]).get(file);
      if (st === undefined) return false;
      if (st !== e) return true;
      expected = st;
    }
    return false;
  };
  for (const [p, rowP] of byLocal) {
    try {
      const j = p + 1;
      const rowJ = byLocal.get(j);
      if (!rowJ) continue;
      const startP = shadows.find((s) => s.promptIndex === p);
      const startJ = shadows.find((s) => s.promptIndex === j);
      const endP = turnWindowEndShadow(state, p);
      const endJ = turnWindowEndShadow(state, j);
      // j's end is its Stop's tree, or the live tree for the turn this Stop closes.
      if (!startP?.shadowSha || !startJ?.shadowSha || !endP?.shadowSha) continue;
      if (!endJ?.shadowSha && j !== lastLocal) continue;
      if ([startP, startJ, endP, endJ].some((s) => s && s.completeBaseline === false)) continue;
      // The restoring row's files. Not "in both rows": a later Stop rebuilds
      // j from its commit while p comes back as the row an earlier run of
      // this pass already emptied. The blobs prove p changed the file.
      const candidates = [...rowFiles(rowJ)];
      if (candidates.length === 0) continue;
      const sP = blobs(startP.shadowSha, candidates);
      const eP = blobs(endP.shadowSha, candidates);
      const sJ = blobs(startJ.shadowSha, candidates);
      const eJ = blobs(endJ?.shadowSha ?? null, candidates);
      const drop = new Set(candidates.filter((f) => {
        const a = sP.get(f); const b = eP.get(f); const c = sJ.get(f); const d = eJ.get(f);
        if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
        return a !== b && b === c && d === a && writtenByEarlierTurn(p, f, a);
      }));
      if (drop.size === 0) continue;
      if ([...rowFiles(rowP)].some((f) => drop.has(f))) {
        dropFromRow(rowP, drop);
        changedRows.add(rowP.promptIndex);
      }
      dropFromRow(rowJ, drop);
      changedRows.add(rowJ.promptIndex);
      deps.log?.('a change one turn took off and the next put back left both rows', {
        rows: [rowP.promptIndex, rowJ.promptIndex], files: [...drop].slice(0, 20), count: drop.size,
        remaining: [(rowP.filesChanged as string[]).length, (rowJ.filesChanged as string[]).length],
      });
    } catch { /* leave both rows as they were */ }
  }
  return changedRows.size;
}

/**
 * `RoundTripDeps.blobs` from git, run in `root`: `ls-tree` for a commit's
 * tree, `hash-object` for the live tree. Any git failure answers for no file.
 */
export function gitBlobs(root: string): RoundTripDeps['blobs'] {
  const opts = { cwd: root, windowsHide: true, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 10_000 };
  return (sha, files) => {
    const out = new Map<string, string>();
    if (files.length === 0) return out;
    try {
      if (sha) {
        const listed = execFileSync('git', ['ls-tree', '-r', '-z', sha, '--', ...files], opts);
        const found = new Map<string, string>();
        for (const entry of listed.split('\0')) {
          const m = entry.match(/^\d+ blob ([0-9a-f]+)\t(.*)$/s);
          if (m) found.set(norm(m[2]), m[1]);
        }
        for (const f of files) out.set(f, found.get(f) ?? '');
        return out;
      }
      const present = files.filter((f) => {
        try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; }
      });
      const ids = present.length > 0
        ? execFileSync('git', ['hash-object', '--', ...present], opts).split('\n').filter(Boolean)
        : [];
      if (ids.length !== present.length) return new Map();
      present.forEach((f, i) => out.set(f, ids[i]));
      for (const f of files) if (!out.has(f)) out.set(f, '');
      return out;
    } catch {
      return new Map();
    }
  };
}
