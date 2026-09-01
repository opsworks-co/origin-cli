/**
 * A turn's working-tree window is measured against a shadow baseline created on
 * a POLL. An agent that fires no lifecycle hooks (Antigravity) can be several
 * edits into a turn before the watcher first sees it, and everything written
 * before the baseline lands is already IN the baseline — it reads as context,
 * not as this turn's work.
 *
 * Session a4d0708a turn 3: the window reported `monitor.html` +126/-12 and
 * `monitor_server.py` +33/-8, while the commit it produced is +150/-12 and
 * +44/-8. Hunk for hunk the two agree — same 16 hunks, same deletions, same
 * structure — with 24 added lines simply missing from the early hunks. 35 lines
 * of real work were recorded as pre-existing.
 *
 * The transcript diff has no baseline to race, so when it measures MORE the
 * window missed something. The gate matters as much as the rule: for adapters
 * that do NOT chain whole-file writes, "more" is routine and meaningless.
 */
import { describe, it, expect } from 'vitest';
import { transcriptDiffBeatsWindow } from '../transcript-watch.js';
import { antigravityAdapter, claudeAdapter, cursorAdapter } from '../transcript-adapters.js';

const d = (linesAdded: number, linesRemoved: number, diff = 'diff --git a/x b/x\n@@ -1,1 +1,1 @@\n+x') =>
  ({ diff, linesAdded, linesRemoved });

describe('transcriptDiffBeatsWindow', () => {
  it('prefers the transcript when the window under-measured (a4d0708a turn 3)', () => {
    // The real numbers: transcript 563/26 across the turn's five repo files,
    // window 489/92 — and the commit says the transcript is right.
    expect(transcriptDiffBeatsWindow(d(563, 26), d(489, 92), true)).toBe(true);
  });

  it('keeps the window when it measures at least as much', () => {
    expect(transcriptDiffBeatsWindow(d(10, 2), d(10, 2), true)).toBe(false);
    expect(transcriptDiffBeatsWindow(d(10, 2), d(40, 30), true)).toBe(false);
  });

  it('never fires for an adapter whose transcript diff is not a delta', () => {
    // A whole-file write counts the entire file as added, so the transcript
    // number is a ceiling: a one-line change to a 400-row file reads +401 and
    // would beat every honest window.
    expect(transcriptDiffBeatsWindow(d(401, 0), d(1, 0), false)).toBe(false);
  });

  it('ignores a transcript that has no diff body', () => {
    expect(transcriptDiffBeatsWindow(d(999, 0, ''), d(1, 0), true)).toBe(false);
    expect(transcriptDiffBeatsWindow(d(999, 0, '   '), d(1, 0), true)).toBe(false);
  });

  it('is opt-in: only the adapter that chains whole-file writes declares it', () => {
    expect(antigravityAdapter.transcriptDiffIsDelta).toBe(true);
    // Everyone else builds turn diffs straight from raw edit records.
    expect(claudeAdapter.transcriptDiffIsDelta).toBeUndefined();
    expect(cursorAdapter.transcriptDiffIsDelta).toBeUndefined();
  });
});
