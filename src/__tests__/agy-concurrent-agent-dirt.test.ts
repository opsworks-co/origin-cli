// Regression: an Antigravity (Gemini) read-only turn ("did you commit it?") was
// stored as "+22 lines, 1 file, uncommitted" — but the file was `gratitude_prompt.py`,
// an untracked file a DIFFERENT concurrent agent created in the shared working
// tree ~90s earlier. A read-only agy turn is seen only by the watcher, which is
// barred from refreshing the per-prompt baseline, so captureAgyDiff diffed a
// STALE end-of-previous-prompt shadow against the live tree and swept the other
// agent's file in.
//
// Fix: scope the agy capture to files THIS conversation actually edited (from its
// own transcript). scopeAgyDiffToSessionEdits pins that behavior.

import { describe, it, expect } from 'vitest';
import path from 'path';
import { scopeAgyDiffToSessionEdits, computeAgySessionCorrections } from '../commands/hooks.js';

const REPO = '/tmp/origin-demo-1';

// captureAgyDiff output for the read-only turn: one file (the concurrent agent's
// untracked gratitude_prompt.py) that this session never touched.
const FOREIGN_DIFF = `diff --git a/gratitude_prompt.py b/gratitude_prompt.py
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/gratitude_prompt.py
@@ -0,0 +1,3 @@
+#!/usr/bin/env python3
+import argparse
+print("be grateful")
`;

// A mixed diff: one file this session DID edit (snake_game.py) plus the foreign one.
const MIXED_DIFF = `diff --git a/snake_game.py b/snake_game.py
index 2222222..3333333 100644
--- a/snake_game.py
+++ b/snake_game.py
@@ -1,2 +1,4 @@
 import curses
 import random
+# tweak
+SPEED = 5
${FOREIGN_DIFF}`;

describe('scopeAgyDiffToSessionEdits — concurrent-agent dirt exclusion', () => {
  it('drops a file the session never edited (the read-only-turn bug)', () => {
    const r = scopeAgyDiffToSessionEdits(
      REPO,
      ['gratitude_prompt.py'],
      FOREIGN_DIFF,
      3, 0,
      [path.join(REPO, 'snake_game.py')], // session only ever edited the snake game
    );
    expect(r.dropped).toEqual(['gratitude_prompt.py']);
    expect(r.filesChanged).toEqual([]);
    expect(r.diff).toBe('');
    expect(r.linesAdded).toBe(0);
    expect(r.linesRemoved).toBe(0);
  });

  it('keeps this session\'s file and strips the foreign one from a mixed diff', () => {
    const r = scopeAgyDiffToSessionEdits(
      REPO,
      ['snake_game.py', 'gratitude_prompt.py'],
      MIXED_DIFF,
      5, 0,
      [path.join(REPO, 'snake_game.py')],
    );
    expect(r.dropped).toEqual(['gratitude_prompt.py']);
    expect(r.filesChanged).toEqual(['snake_game.py']);
    expect(r.diff).toContain('snake_game.py');
    expect(r.diff).not.toContain('gratitude_prompt.py');
    expect(r.linesAdded).toBe(2);   // only snake_game.py's two added lines
    expect(r.linesRemoved).toBe(0);
  });

  it('is a no-op when every changed file was edited by this session', () => {
    const r = scopeAgyDiffToSessionEdits(
      REPO,
      ['snake_game.py'],
      MIXED_DIFF, // diff content irrelevant here; nothing is foreign
      5, 0,
      [path.join(REPO, 'snake_game.py'), path.join(REPO, 'gratitude_prompt.py')],
    );
    expect(r.dropped).toEqual([]);
    expect(r.filesChanged).toEqual(['snake_game.py']);
    expect(r.diff).toBe(MIXED_DIFF);      // untouched
    expect(r.linesAdded).toBe(5);         // original counts preserved
  });

  it('is a no-op (never zeroes a real turn) when the session recorded no edits', () => {
    // A parser miss → empty filesEdited must NOT strip everything.
    const r = scopeAgyDiffToSessionEdits(REPO, ['snake_game.py'], MIXED_DIFF, 5, 0, []);
    expect(r.dropped).toEqual([]);
    expect(r.filesChanged).toEqual(['snake_game.py']);
    expect(r.linesAdded).toBe(5);
  });

  it('ignores edited paths outside the repo when building the allowlist', () => {
    // A file agy edited in ANOTHER repo must not accidentally allow a same-named
    // path here; and an out-of-repo abs path must not throw.
    const r = scopeAgyDiffToSessionEdits(
      REPO,
      ['gratitude_prompt.py'],
      FOREIGN_DIFF,
      3, 0,
      ['/some/other/repo/snake_game.py'],
    );
    // editedRel is empty (path is '../..'), so guard makes it a no-op — the turn
    // is left intact rather than wrongly zeroed on an empty allowlist.
    expect(r.dropped).toEqual([]);
    expect(r.filesChanged).toEqual(['gratitude_prompt.py']);
  });
});

describe('computeAgySessionCorrections — backfill over a session', () => {
  const edited = [path.join(REPO, 'snake_game.py'), path.join(REPO, 'calculator.py')];

  it('returns only the prompts that shed a foreign file, corrected & authoritative', () => {
    const promptChanges = [
      { promptIndex: 0, promptText: 'add calc', filesChanged: ['calculator.py'], diff: 'diff --git a/calculator.py b/calculator.py\n@@\n+x', linesAdded: 1, linesRemoved: 0 },
      // prompt 1: the snake turn with a leaked foreign file + a real one
      { promptIndex: 1, promptText: 'bigger script', filesChanged: ['gratitude_prompt.py', 'snake_game.py'], diff: MIXED_DIFF, linesAdded: 5, linesRemoved: 0, commitSha: 'deadbeef' },
      // prompt 2: pure read-only turn, only a foreign file
      { promptIndex: 2, promptText: 'did you commit it?', filesChanged: ['gratitude_prompt.py'], diff: FOREIGN_DIFF, linesAdded: 3, linesRemoved: 0 },
    ];
    const corr = computeAgySessionCorrections(promptChanges, edited, REPO);
    // prompt 0 is clean → not returned; prompts 1 and 2 shed the foreign file.
    expect(corr.map((c) => c.promptIndex)).toEqual([1, 2]);

    const p1 = corr.find((c) => c.promptIndex === 1)!;
    expect(p1.filesChanged).toEqual(['snake_game.py']);
    expect(p1.dropped).toEqual(['gratitude_prompt.py']);
    expect(p1.authoritative).toBe(true);
    expect(p1.commitSha).toBe('deadbeef');
    expect(p1.uncommittedDiff).toBe('');            // committed → no uncommitted diff
    expect(p1.linesAdded).toBe(2);                  // only snake_game.py's lines

    const p2 = corr.find((c) => c.promptIndex === 2)!;
    expect(p2.filesChanged).toEqual([]);            // read-only turn → nothing left
    expect(p2.diff).toBe('');
    expect(p2.linesAdded).toBe(0);
    expect(p2.uncommittedDiff).toBe('');            // uncommitted but now empty
  });

  it('accepts filesChanged stored as a JSON string (server serialization)', () => {
    const corr = computeAgySessionCorrections(
      [{ promptIndex: 0, promptText: 'x', filesChanged: JSON.stringify(['gratitude_prompt.py', 'snake_game.py']), diff: MIXED_DIFF, linesAdded: 5 }],
      edited, REPO,
    );
    expect(corr).toHaveLength(1);
    expect(corr[0].filesChanged).toEqual(['snake_game.py']);
    expect(corr[0].dropped).toEqual(['gratitude_prompt.py']);
  });

  it('returns nothing when the transcript recorded no edits (never zeroes a session)', () => {
    const corr = computeAgySessionCorrections(
      [{ promptIndex: 0, promptText: 'x', filesChanged: ['snake_game.py'], diff: MIXED_DIFF, linesAdded: 5 }],
      [], REPO,
    );
    expect(corr).toEqual([]);
  });

  it('returns nothing when every prompt only touched session-edited files', () => {
    const corr = computeAgySessionCorrections(
      [{ promptIndex: 0, promptText: 'x', filesChanged: ['snake_game.py'], diff: 'x', linesAdded: 1 }],
      edited, REPO,
    );
    expect(corr).toEqual([]);
  });
});
