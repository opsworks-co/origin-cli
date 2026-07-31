// Regression: a turn claimed files it never touched, inflating its +/- counts
// and crediting it with another session's work.
//
// Reported live (session 06636136, repo `suchara`). Its state recorded:
//   sessionStartDirtyFiles: [".devin/rules/origin.md","CLAUDE.md","popcorn","utils.js"]
// yet turn 3 ("make 3 more chanegs") was stored as:
//   filesChanged: ["popcorn","text-rows.txt","utils.js"]
// `popcorn` and `utils.js` were already dirty when the session STARTED — they
// were the previous session's uncommitted leftovers, not this turn's work.
//
// Cause: the per-prompt mapping ran the pre-existing-dirt exclusion
// (uncommittedExcludeUnion → filterUncommittedDiff) on the plain uncommitted
// diff, but when the baseline was a SHADOW commit it used
// `gitCapture.workingTreeDiff` RAW — skipping the filter entirely for both the
// stored diff and the derived filesChanged list. These pin the primitive that
// both branches now share.

import { describe, it, expect } from 'vitest';
import { filterUncommittedDiff } from '../commands/hooks.js';

// A working-tree diff shaped like the reported session: one file this turn
// really edited (three-lines.txt) plus two inherited-dirty files.
const WORKING_TREE_DIFF = `diff --git a/three-lines.txt b/three-lines.txt
index 1111111..2222222 100644
--- a/three-lines.txt
+++ b/three-lines.txt
@@ -1,3 +1,6 @@
 one
 two
 three
+four
+five
+six
diff --git a/popcorn b/popcorn
index 3333333..4444444 100644
--- a/popcorn
+++ b/popcorn
@@ -0,0 +1,11 @@
+row1
+row2
+row3
+row4
+row5
+row6
+row7
+row8
+row9
+row10
+row11
diff --git a/utils.js b/utils.js
index 5555555..6666666 100644
--- a/utils.js
+++ b/utils.js
@@ -1,2 +1,3 @@
 export const a = 1;
+export const b = 2;
 export const c = 3;
`;

const filesIn = (diff: string): string[] =>
  [...diff.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1]);

describe('shadow-baseline working-tree diff — pre-existing dirt exclusion', () => {
  // The union the caller passes: session-start dirt (+ per-prompt dirt).
  const sessionStartDirty = ['.devin/rules/origin.md', 'CLAUDE.md', 'popcorn', 'utils.js'];

  it('strips files that were already dirty at session start, keeping this turn\'s real work', () => {
    const filtered = filterUncommittedDiff(WORKING_TREE_DIFF, sessionStartDirty);
    expect(filesIn(filtered)).toEqual(['three-lines.txt']);
    // The inherited +11 `popcorn` rows must not be counted against this turn.
    expect(filtered).not.toContain('row11');
    expect(filtered).toContain('+four');
  });

  it('leaves the diff untouched when nothing was dirty at start', () => {
    const filtered = filterUncommittedDiff(WORKING_TREE_DIFF, []);
    expect(filesIn(filtered)).toEqual(['three-lines.txt', 'popcorn', 'utils.js']);
  });

  it('returns empty when EVERY changed file was inherited (turn authored nothing)', () => {
    const filtered = filterUncommittedDiff(WORKING_TREE_DIFF, ['three-lines.txt', 'popcorn', 'utils.js']);
    expect(filesIn(filtered)).toEqual([]);
  });
});
