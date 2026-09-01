/**
 * A session's remembered line totals must count the same work its remembered
 * file list does.
 *
 * The memory entry summed the adapter's raw per-turn counts, which cover every
 * section of the diff the adapter built — including files written OUTSIDE the
 * repo. `filesChanged` on the same entry drops those (isInsideRepo), so an
 * Antigravity session, which writes an implementation plan and a walkthrough
 * into its own brain dir on most turns, remembered a total that its own file
 * list could not account for.
 */
import { describe, it, expect } from 'vitest';
import os from 'os';
import { scopedMemoryLineCounts } from '../transcript-watch.js';

const HOME = os.homedir().replace(/\\/g, '/');
const ROOT = `${HOME}/.gemini/antigravity/worktrees/kotleta/generate_additional_clean_code`;
const headerPath = (abs: string) => abs.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');

const section = (p: string, adds: number, dels: number) => [
  `diff --git a/${p} b/${p}`,
  `--- a/${p}`,
  `+++ b/${p}`,
  `@@ -1,${dels} +1,${adds} @@`,
  ...Array.from({ length: dels }, (_, i) => `-old ${i}`),
  ...Array.from({ length: adds }, (_, i) => `+new ${i}`),
  '',
].join('\n');

describe('scopedMemoryLineCounts', () => {
  it('excludes lines written outside the repo', () => {
    const diff = section(headerPath(`${ROOT}/pretty.py`), 70, 5)
      + section(headerPath(`${HOME}/.gemini/antigravity/brain/c/walkthrough.md`), 46, 30);
    // What the adapter reports for the turn: everything it wrote, anywhere.
    const promptDiffs = [{ diff, linesAdded: 116, linesRemoved: 35 }];

    expect(scopedMemoryLineCounts(ROOT, promptDiffs)).toEqual({ linesAdded: 70, linesRemoved: 5 });
  });

  it('sums across turns', () => {
    const promptDiffs = [
      { diff: section(headerPath(`${ROOT}/a.py`), 10, 1), linesAdded: 10, linesRemoved: 1 },
      { diff: section(headerPath(`${ROOT}/b.py`), 4, 2), linesAdded: 4, linesRemoved: 2 },
    ];
    expect(scopedMemoryLineCounts(ROOT, promptDiffs)).toEqual({ linesAdded: 14, linesRemoved: 3 });
  });

  it('keeps the adapter numbers for a turn that reports counts but no patch', () => {
    // Not every agent ships a diff body; scoping has nothing to act on and must
    // not silently zero the turn.
    expect(scopedMemoryLineCounts(ROOT, [{ diff: '', linesAdded: 12, linesRemoved: 3 }]))
      .toEqual({ linesAdded: 12, linesRemoved: 3 });
  });

  it('keeps the adapter numbers when scoping changed nothing, even if the body disagrees', () => {
    // The adapter's counts are authoritative for the diff it produced and are
    // NOT required to be derivable from its body — several agents report a
    // total alongside a partial patch. Recounting a diff we did not alter
    // replaces good numbers with whatever the body happened to hold.
    const promptDiffs = [{ diff: section('apps/web/src/App.tsx', 1, 0), linesAdded: 24, linesRemoved: 3 }];
    expect(scopedMemoryLineCounts(ROOT, promptDiffs)).toEqual({ linesAdded: 24, linesRemoved: 3 });
  });

  it('is zero for a session that changed nothing', () => {
    expect(scopedMemoryLineCounts(ROOT, [])).toEqual({ linesAdded: 0, linesRemoved: 0 });
    expect(scopedMemoryLineCounts(ROOT, undefined)).toEqual({ linesAdded: 0, linesRemoved: 0 });
  });
});
