// A saved row's diffs fitted to the storage budget, and the files the cut
// left without their content — the rule budgetedTurnCapture (stop.ts) applies
// at Stop, for every other producer that wrote a row.
//
// Five producers still stored `diff.slice(0, 200_000)`: Cursor's
// after-file-edit, user-prompt-submit's previous-turn row, session-start's
// reuse row, session-end's last row and the Codex prompt mapping. A byte
// offset cuts MID-HUNK and drops whole files off the end while the row goes on
// naming them. Session ac7e1559 turn 4 (Cursor, 2026-09-23): after-file-edit
// built a 309 KB diff and stored exactly 200000 bytes — stop.ts cut mid-hunk,
// transcript-adapters.ts gone — which `origin verify-capture` reports as
// diff_unparseable + claimed_file_absent_from_diff. The same shape as
// d5cc625b, fixed at Stop and never carried to these.
//
// A file whose content did not fit is still a file the turn changed: callers
// keep it in filesChanged and name it in contentUnavailableFiles.
import { fitDiffToBudget } from './diff-budget.js';
import { MAX_PROMPT_DIFF_LEN } from './git-capture.js';

export function budgetRowDiffs(
  diff: string | null | undefined,
  uncommittedDiff?: string | null,
): { diff: string; uncommittedDiff: string; cutFiles: string[] } {
  const primary = fitDiffToBudget(diff || '', MAX_PROMPT_DIFF_LEN);
  const uncommitted = fitDiffToBudget(uncommittedDiff || '', MAX_PROMPT_DIFF_LEN);
  return {
    diff: primary.diff,
    uncommittedDiff: uncommitted.diff,
    cutFiles: [...new Set([
      ...primary.omittedFiles, ...primary.partialFiles,
      ...uncommitted.omittedFiles, ...uncommitted.partialFiles,
    ])],
  };
}

/** `contentUnavailableFiles` with the cut files added, or nothing when empty. */
export function withCutFiles(existing: readonly string[] | undefined, cut: readonly string[]): { contentUnavailableFiles?: string[] } {
  const all = [...new Set([...(existing || []), ...cut])];
  return all.length > 0 ? { contentUnavailableFiles: all } : {};
}
