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
import { captureShadowWindow, MAX_PROMPT_DIFF_LEN } from './git-capture.js';
import { fitDiffToBudget } from './diff-budget.js';
import { turnWindowEndShadow, turnWindowLateWork, withLateWork } from './restored-from-history.js';
import { localTurnForServerRow } from './turn-index.js';
import type { TurnObservation } from './resolve-turn.js';

export interface ShadowRangeState {
  /** LOCAL-numbered: index L is this launch's turn L. */
  promptShadows?: Array<{ promptIndex: number; shadowSha: string; completeBaseline?: boolean }>;
  /** Server row of this launch's turn 0 — see turn-index.ts. */
  promptIndexBase?: number | null;
  /** LOCAL prompt list — the last index is the turn still in flight. */
  prompts?: unknown[];
  contendingSessionIds?: string[];
  /** LOCAL-numbered: the tree Stop closed turn L with — see restored-from-history.ts. */
  turnEndShadows?: Array<{ promptIndex: number; shadowSha: string; capturedAt: string; completeBaseline?: boolean; lateFiles?: string[] }>;
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
  /** The source that establishes this turn's content and file coverage. */
  diffSource?: 'ledger' | 'turn-window';
  /** A complete snapshot window, not a partial transcript or a metadata update. */
  turnWindowCaptured?: boolean;
  contentAuthoritative?: boolean;
  editsJson?: string;
  commitSha?: string | null;
}

export interface PreferShadowRangeDeps {
  log?: (event: string, data: Record<string, unknown>) => void;
  /**
   * Did commits the turn did not make land between these two shadows (`to`
   * null = the live worktree)? A pull, checkout, rebase or merge inside the
   * window rewrites files on disk, and the window's tree delta cannot tell
   * those bytes from the turn's own.
   */
  windowInheritsCommits?: (fromShadow: string, toShadow: string | null, localTurn: number) => boolean;
  /**
   * What the window said for each row, before this pass weighs it against the
   * row it already holds — see resolve-turn.ts.
   */
  observe?: (promptIndex: number, observation: TurnObservation) => void;
}

function blank(pm: ShadowRangeMapping): void {
  pm.filesChanged = [];
  pm.diff = '';
  pm.uncommittedDiff = '';
  pm.linesAdded = 0;
  pm.linesRemoved = 0;
  pm.chatOnly = true;
  pm.contentUnavailableFiles = [];
  pm.commitSha = null;
}

/** Empty and nonempty answers use the same replacement contract on the wire. */
function markWindowCaptured(pm: ShadowRangeMapping): void {
  pm.turnWindowCaptured = true;
  pm.contentAuthoritative = true;
  // A partial agent extractor must not replace a complete tree delta on read.
  pm.diffSource = 'turn-window';
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
  const declined = (pm: ShadowRangeMapping, reason: string) =>
    deps.observe?.(pm.promptIndex, { source: 'turn-window', outcome: 'declined', reason });
  const declineAll = (reason: string) => {
    if (!deps.observe || !Array.isArray(mappings)) return;
    for (const pm of mappings) if (pm && Number.isInteger(pm.promptIndex)) declined(pm, reason);
  };
  if (state.contendingSessionIds?.length) {
    declineAll('another live session shares this working tree');
    return 0;
  }
  const shadows = state.promptShadows || [];
  if (shadows.length === 0 || !repoPath || !Array.isArray(mappings)) {
    declineAll('the session has no shadow window');
    return 0;
  }
  const currentLocal = Number.isInteger(state.prompts?.length)
    ? Math.max((state.prompts as unknown[]).length - 1, 0)
    : Math.max(...shadows.map((s) => s.promptIndex), 0);

  let changed = 0;
  try {
    for (const pm of mappings) {
      if (!pm || !Number.isInteger(pm.promptIndex)) continue;
      const local = localTurnForServerRow(pm.promptIndex, state.promptIndexBase);
      if (local === null) { declined(pm, 'row predates this launch'); continue; }
      const start = shadows.find((s) => s.promptIndex === local);
      if (start?.completeBaseline === false) { declined(pm, 'the start shadow is not a complete baseline'); continue; }
      const from = start?.shadowSha || null;
      // A closed turn ends where its Stop saw the tree, not where the next
      // prompt found it: a background job can rewrite the tree in between
      // (session 874ff028). Falls back to the next turn's start shadow.
      const next = turnWindowEndShadow(state, local);
      if (next?.completeBaseline === false) { declined(pm, 'the next shadow is not a complete baseline'); continue; }
      const to = next?.shadowSha || null;
      // A completed turn without the next shadow cannot be scoped to the
      // current worktree — that tree includes later turns. Only the in-flight
      // turn (no next shadow yet) diffs against the live tree.
      const end = to || (local === currentLocal ? null : undefined);
      if (!from || end === undefined) {
        declined(pm, !from ? 'the turn has no start shadow' : 'a completed turn has no next shadow');
        continue;
      }

      let win = captureShadowWindow(repoPath, from, end, { completeBaseline: start?.completeBaseline });
      // Files the turn's background job changed after its Stop, which the next
      // prompt added to the row (extendClosedTurnWithLateWork): their window
      // runs to the next turn's start. Any doubt keeps the stored row.
      const late = end ? turnWindowLateWork(state, local) : undefined;
      if (late && (win.status === 'changed' || win.status === 'empty' || win.status === 'identical-sha')) {
        if (late.completeBaseline === false) { declined(pm, 'the late-work shadow is not a complete baseline'); continue; }
        const lateWin = captureShadowWindow(repoPath, from, late.shadowSha, { completeBaseline: start?.completeBaseline });
        if (lateWin.status !== 'changed' && lateWin.status !== 'empty') { declined(pm, `late-work window ${lateWin.status}`); continue; }
        let lateInherits = false;
        try { lateInherits = !!deps.windowInheritsCommits?.(from, late.shadowSha, local); } catch { lateInherits = false; }
        if (lateInherits) { declined(pm, 'the late-work window spans commits the turn did not make'); continue; }
        win = withLateWork(win, lateWin, late.files);
      }
      if (win.status === 'identical-sha' || win.status === 'unavailable' || win.status === 'not-shadow') {
        declined(pm, `window ${win.status}`);
        continue;
      }
      if (win.status === 'empty') {
        deps.observe?.(pm.promptIndex, { source: 'turn-window', outcome: 'empty', completeBaseline: start?.completeBaseline === true });
        const had = !!(pm.diff || '').trim() || (Array.isArray(pm.filesChanged) && pm.filesChanged.length > 0);
        // An empty window is only evidence of "no work" when the shadow really
        // is this turn's START state. For a turn nobody announced, it is not:
        // after-file-edit cuts the shadow at DISCOVERY (after-file-edit.ts:141),
        // which is already after the turn wrote the file that revealed it. The
        // window then compares that late shadow against a tree it already
        // contains, reads empty, and blanking would delete the very edit that
        // found the turn — `capture-e2e-cursor-binary` turn 2 exactly.
        //
        // Legacy snapshots do not record boundary completeness. Preserve the
        // ledger for those; an explicitly complete start and end can prove
        // zero net work even when an earlier reconstruction carried content.
        // The ledger has the journal marks bounding this
        // turn, so where it produced the row, it outranks the window. The
        // 4b51bd70 dump this pass exists to drop carries no such evidence.
        if (pm.diffSource === 'ledger' && had && start?.completeBaseline !== true) {
          deps.log?.('shadow window empty but the ledger captured this turn — kept', {
            promptIndex: pm.promptIndex,
          });
          continue;
        }
        blank(pm);
        markWindowCaptured(pm);
        if (had) {
          changed += 1;
          deps.log?.('shadow window empty — dropped leftover HEAD..worktree dump', {
            promptIndex: pm.promptIndex,
          });
        }
        continue;
      }

      // A window that spans inherited commits is not the turn's authorship.
      // Session 9f8501f7 turn 2 ran `git merge --ff-only origin/main`, which
      // brought in #1593 (24 files, +404/-80). The ledger subtracted it —
      // `inherited:24, files:4` — and this pass then replaced that row with the
      // raw window: 26 files, +602/-88. The producers before this one already
      // exclude inherited commits (the ledger's before-states, the shell
      // window's foreign-file drop); keep what they built.
      let inherits = false;
      try { inherits = !!deps.windowInheritsCommits?.(from, to, local); } catch { inherits = false; }
      if (inherits) {
        declined(pm, 'the window spans commits the turn did not make');
        deps.log?.('shadow window spans commits the turn did not make — kept the capture', {
          promptIndex: pm.promptIndex, files: win.filesChanged.length,
        });
        continue;
      }

      markWindowCaptured(pm);
      const prevDiff = pm.diff || '';
      const prevFiles = Array.isArray(pm.filesChanged) ? pm.filesChanged.join('\0') : '';
      // A window is authoritative about WHICH files moved, but its diff is a
      // whole tree delta and can exceed the per-prompt budget. Cutting it
      // without saying so produces a row that names a file it cannot show —
      // the shape `capture-verify` flags as `files_without_content`, and the
      // one the legacy path avoids by declaring the shortfall (see
      // budgetedTurnCapture in hooks/stop.ts).
      //
      // So fit the diff, then name what did not fit. `filesChanged` keeps the
      // window's full list — the files are real either way; only their content
      // is missing — and `contentUnavailableFiles` is what lets the row
      // explain itself instead of reading as a broken capture.
      const budgeted = fitDiffToBudget(win.diff || '', MAX_PROMPT_DIFF_LEN);
      const cut = [...new Set([...budgeted.omittedFiles, ...budgeted.partialFiles])];
      pm.filesChanged = win.filesChanged;
      pm.diff = budgeted.diff;
      pm.uncommittedDiff = '';
      pm.linesAdded = win.linesAdded;
      pm.linesRemoved = win.linesRemoved;
      pm.contentUnavailableFiles = cut;
      if (win.filesChanged.length > 0 || win.diff) delete pm.chatOnly;
      deps.observe?.(pm.promptIndex, {
        source: 'turn-window', outcome: 'applied',
        files: [...win.filesChanged], diff: budgeted.diff, added: win.linesAdded, removed: win.linesRemoved, contentUnavailable: cut,
      });
      if (prevDiff !== budgeted.diff || prevFiles !== win.filesChanged.join('\0')) {
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
