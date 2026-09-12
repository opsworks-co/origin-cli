/**
 * A turn's diff is the tree between its shadow and the next one.
 *
 * Stop, the heartbeat and session-end each reconstruct a turn from
 * `HEAD..worktree` or from the write journal. Both lie in the same two ways:
 *
 *   1. A question turn whose shadow window is empty still inherits leftover
 *      dirty files vs HEAD. Session 4b51bd70 turn "how many edits": the two
 *      shadows were different objects over the same tree, git said nothing
 *      moved, and the row still shipped +154 of earlier uncommitted work.
 *   2. The journal renders a mid-file insert from two snapshots that are
 *      fragments of the file, so the hunk header is `@@ -1,6 +1,86 @@` for a
 *      change at line 820. Git, given the two trees, emits a real hunk.
 *
 * `captureShadowRangeDiff` cannot tell (1) from "we don't know" — same-tree
 * and same-sha and git-failure are all empty, and its callers leave data
 * alone. This pass uses `captureShadowWindow`, which distinguishes them.
 *
 * Same shape as preferCommitPatchForCommittedTurns: mutate in place, never
 * throw, wholesale replace. Runs AFTER the ledger and BEFORE the commit
 * patch, so a committed-clean turn still gets git's commit-scoped rendering.
 */
import { captureShadowWindow } from './git-capture.js';
import { localTurnForServerRow } from './turn-index.js';

export interface ShadowRangeState {
  /** LOCAL-numbered: index L is this launch's turn L. */
  promptShadows?: Array<{ promptIndex: number; shadowSha: string }>;
  /** Server row of this launch's turn 0 — see turn-index.ts. */
  promptIndexBase?: number | null;
  /** LOCAL prompt list — the last index is the turn still in flight. */
  prompts?: unknown[];
}

export interface ShadowRangeMapping {
  promptIndex: number;
  filesChanged?: unknown;
  diff?: string;
  uncommittedDiff?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  chatOnly?: boolean;
  contentUnavailableFiles?: string[];
  /** Set by applyLedgerToMappings — this row came from the write journal. */
  diffSource?: 'ledger';
}

export interface PreferShadowRangeDeps {
  log?: (event: string, data: Record<string, unknown>) => void;
}

function blank(pm: ShadowRangeMapping): void {
  pm.filesChanged = [];
  pm.diff = '';
  pm.uncommittedDiff = '';
  pm.linesAdded = 0;
  pm.linesRemoved = 0;
  pm.chatOnly = true;
  delete pm.contentUnavailableFiles;
}

/**
 * Replace each turn that has a usable shadow window with that window's git
 * diff, or blank it when the window is empty. Returns how many mappings
 * changed. Never throws.
 */
export function preferShadowRangeForTurns(
  state: ShadowRangeState,
  mappings: ShadowRangeMapping[],
  repoPath: string,
  deps: PreferShadowRangeDeps = {},
): number {
  const shadows = state.promptShadows || [];
  if (shadows.length === 0 || !repoPath || !Array.isArray(mappings)) return 0;
  const currentLocal = Number.isInteger(state.prompts?.length)
    ? Math.max((state.prompts as unknown[]).length - 1, 0)
    : Math.max(...shadows.map((s) => s.promptIndex), 0);

  let changed = 0;
  try {
    for (const pm of mappings) {
      if (!pm || !Number.isInteger(pm.promptIndex)) continue;
      const local = localTurnForServerRow(pm.promptIndex, state.promptIndexBase);
      if (local === null) continue;
      const from = shadows.find((s) => s.promptIndex === local)?.shadowSha || null;
      const to = shadows.find((s) => s.promptIndex === local + 1)?.shadowSha || null;
      // A completed turn without the next shadow cannot be scoped to the
      // current worktree — that tree includes later turns. Only the in-flight
      // turn (no next shadow yet) diffs against the live tree.
      const end = to || (local === currentLocal ? null : undefined);
      if (!from || end === undefined) continue;

      const win = captureShadowWindow(repoPath, from, end);
      if (win.status === 'identical-sha' || win.status === 'unavailable' || win.status === 'not-shadow') {
        continue;
      }
      if (win.status === 'empty') {
        const had = !!(pm.diff || '').trim() || (Array.isArray(pm.filesChanged) && pm.filesChanged.length > 0);
        // An empty window is only evidence of "no work" when the shadow really
        // is this turn's START state. For a turn nobody announced, it is not:
        // after-file-edit cuts the shadow at DISCOVERY (after-file-edit.ts:141),
        // which is already after the turn wrote the file that revealed it. The
        // window then compares that late shadow against a tree it already
        // contains, reads empty, and blanking would delete the very edit that
        // found the turn — `capture-e2e-cursor-binary` turn 2 exactly.
        //
        // The ledger does not guess: it has the journal marks bounding this
        // turn, so where it produced the row, it outranks the window. The
        // 4b51bd70 dump this pass exists to drop carries no such evidence.
        if (pm.diffSource === 'ledger' && had) {
          deps.log?.('shadow window empty but the ledger captured this turn — kept', {
            promptIndex: pm.promptIndex,
          });
          continue;
        }
        blank(pm);
        if (had) {
          changed += 1;
          deps.log?.('shadow window empty — dropped leftover HEAD..worktree dump', {
            promptIndex: pm.promptIndex,
          });
        }
        continue;
      }

      const prevDiff = pm.diff || '';
      const prevFiles = Array.isArray(pm.filesChanged) ? pm.filesChanged.join('\0') : '';
      pm.filesChanged = win.filesChanged;
      pm.diff = win.diff;
      pm.uncommittedDiff = '';
      pm.linesAdded = win.linesAdded;
      pm.linesRemoved = win.linesRemoved;
      if (win.filesChanged.length > 0 || win.diff) delete pm.chatOnly;
      if (prevDiff !== win.diff || prevFiles !== win.filesChanged.join('\0')) {
        changed += 1;
        deps.log?.('shadow window replaced reconstructed diff with git', {
          promptIndex: pm.promptIndex,
          files: win.filesChanged.length,
          linesAdded: win.linesAdded,
          linesRemoved: win.linesRemoved,
        });
      }
    }
  } catch {
    return changed;
  }
  return changed;
}
