// A mid-turn PATCH stamped the EDITING turn's line counts onto every turn.
//
// `after-file-edit` fires on every Cursor write and PATCHes the whole
// `completedPromptMappings` list. It computed one linesAdded/linesRemoved pair
// from `fullDiff` — the diff of the turn that had just written a file — and
// spread that pair across every mapping in the payload. The editing turn was
// right by luck (its diff IS fullDiff); every earlier turn's row was restated
// with numbers describing work it never did, once per edit.
//
// Routing looked healthy the whole time: correct turnIds, correct per-turn
// diffs, only the counts wrong — which is why it reads as a server bug.
//
// Prod session aea8c4d1 (baton, Cursor): turn 1's row served 5 files / +89 -8
// while the CLI's own Stop capture for that turn was 13 files / +252 -2.

import { describe, it, expect } from 'vitest';
import { buildLiveEditPromptChanges } from '../commands/hooks.js';

// Two turns with genuinely different diffs: turn 0 is +3/-1, turn 1 is +1/-0.
const TURN0_DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,4 @@',
  ' keep',
  '-gone',
  '+one',
  '+two',
  '+three',
].join('\n');

const TURN1_DIFF = [
  'diff --git a/src/b.js b/src/b.js',
  '--- a/src/b.js',
  '+++ b/src/b.js',
  '@@ -1 +1,2 @@',
  ' keep',
  '+only',
].join('\n');

describe('buildLiveEditPromptChanges', () => {
  it('counts each mapping from its own diff, not the editing turn\'s', () => {
    const out = buildLiveEditPromptChanges([
      { promptIndex: 0, promptText: 'first', filesChanged: ['src/a.js'], diff: TURN0_DIFF },
      { promptIndex: 1, promptText: 'second', filesChanged: ['src/b.js'], diff: TURN1_DIFF },
    ]);

    expect(out[0]).toMatchObject({ promptIndex: 0, linesAdded: 3, linesRemoved: 1 });
    expect(out[1]).toMatchObject({ promptIndex: 1, linesAdded: 1, linesRemoved: 0 });
  });

  it('does not give two turns the same counts when their diffs differ', () => {
    const out = buildLiveEditPromptChanges([
      { promptIndex: 0, diff: TURN0_DIFF },
      { promptIndex: 1, diff: TURN1_DIFF },
    ]);
    // The bug's signature: every row carrying one identical pair.
    expect([out[0].linesAdded, out[0].linesRemoved])
      .not.toEqual([out[1].linesAdded, out[1].linesRemoved]);
  });

  it('reports zero for a mapping that carries no diff', () => {
    const out = buildLiveEditPromptChanges([
      { promptIndex: 0, diff: TURN0_DIFF },
      { promptIndex: 1, diff: '' },
    ]);
    // Turn 1 authored nothing yet — it must not inherit turn 0's +3/-1.
    expect(out[1]).toMatchObject({ linesAdded: 0, linesRemoved: 0 });
  });

  it('leaves file headers out of the counts', () => {
    const [row] = buildLiveEditPromptChanges([{ promptIndex: 0, diff: TURN0_DIFF }]);
    // +++/--- are headers, not authored lines.
    expect(row.linesAdded).toBe(3);
    expect(row.linesRemoved).toBe(1);
  });

  it('preserves the mapping fields the row is keyed and rendered on', () => {
    const [row] = buildLiveEditPromptChanges([{
      promptIndex: 4,
      promptText: 'do the thing',
      filesChanged: ['src/a.js'],
      diff: TURN0_DIFF,
      commitSha: 'abc123',
      treeSha: 'def456',
    }]);
    expect(row).toMatchObject({
      promptIndex: 4,
      promptText: 'do the thing',
      filesChanged: ['src/a.js'],
      commitSha: 'abc123',
      treeSha: 'def456',
      aiPercentage: 100,
      checkpointType: 'auto',
    });
  });

  it('handles an empty mapping list', () => {
    expect(buildLiveEditPromptChanges([])).toEqual([]);
  });
});
