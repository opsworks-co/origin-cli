// computeAgyEmptyTurnRepairs rebuilds turns the pre-#1226 agy path captured as
// empty (it diffed the canonical checkout while agy edited its own worktree).
// The rebuild source is the transcript's edit records, which carry content.
//
// The invariant that matters is FILL-ONLY: a turn that captured something real
// must never be rewritten from the transcript, because the git capture is the
// better evidence — this helper only fills blanks.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { computeAgyEmptyTurnRepairs } from '../commands/hooks.js';

const WORK = path.resolve('/work/wt');
const records = [
  [],
  [{ file: path.join(WORK, 'random_password.py'), toolName: 'Write', input: { content: 'import random\nprint(1)\n' } }],
];

describe('computeAgyEmptyTurnRepairs', () => {
  it('rebuilds an empty turn from the transcript edit records', () => {
    const out = computeAgyEmptyTurnRepairs(
      [{ promptIndex: 0, promptText: 'look around', filesChanged: [], diff: '' },
       { promptIndex: 1, promptText: 'write code', filesChanged: [], diff: '' }],
      records,
      WORK,
    );
    expect(out).toHaveLength(1);
    expect(out[0].promptIndex).toBe(1);
    expect(out[0].filesChanged).toEqual(['random_password.py']);   // repo-relative
    expect(out[0].linesAdded).toBe(2);
    expect(out[0].authoritative).toBe(true);
    // The rendered turn comes from editsJson, NOT a hand-rolled diff string.
    // A diff built by buildDiffFromEdits and stored in `diff` reads back EMPTY
    // (reproduced twice against prod) and renders "(no diff captured)" with
    // +0/-0 even though the write reported success. The mechanism is not
    // established — see the note on computeAgyEmptyTurnRepairs.
    expect(out[0].diff).toBe('');
    const cap = JSON.parse(out[0].editsJson);
    expect(cap.edits).toHaveLength(1);
    expect(cap.edits[0]).toMatchObject({
      file: 'random_password.py',
      op: 'write',
      oldContent: '',
      newContent: 'import random\nprint(1)\n',
      evidence: 'tool_call',
    });
  });

  it('NEVER overwrites a turn that renders something', () => {
    expect(computeAgyEmptyTurnRepairs(
      [{ promptIndex: 1, promptText: 'write code', filesChanged: ['other.py'], diff: 'diff --git a/other.py b/other.py' }],
      records, WORK,
    )).toEqual([]);
    // uncommittedDiff alone is still real rendered content.
    expect(computeAgyEmptyTurnRepairs(
      [{ promptIndex: 1, promptText: 'write code', filesChanged: [], diff: '', uncommittedDiff: 'diff --git a/x b/x' }],
      records, WORK,
    )).toEqual([]);
  });

  it('DOES repair a half-repaired row that has files but renders nothing', () => {
    // A files-only backfill leaves exactly this: a file list, real line counts,
    // and "(no diff captured)" on screen. Keying emptiness off filesChanged
    // would strand these rows forever.
    const out = computeAgyEmptyTurnRepairs(
      [{ promptIndex: 1, promptText: 'write code', filesChanged: ['random_password.py'], diff: '' }],
      records, WORK,
    );
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].editsJson).edits).toHaveLength(1);
  });

  it('leaves a turn alone when the transcript has no records for it', () => {
    // Absence of evidence is "unknown", not "nothing happened" — a chat-only
    // turn must not be rewritten to an explicit empty.
    expect(computeAgyEmptyTurnRepairs(
      [{ promptIndex: 0, promptText: 'hi', filesChanged: [], diff: '' }],
      records, WORK,
    )).toEqual([]);
  });

  it('drops an edit that escaped the working root rather than storing an absolute path', () => {
    expect(computeAgyEmptyTurnRepairs(
      [{ promptIndex: 0, promptText: 'x', filesChanged: [], diff: '' }],
      [[{ file: path.resolve('/elsewhere/foo.py'), toolName: 'Write', input: { content: 'x\n' } }]],
      WORK,
    )).toEqual([]);
  });

  it('clears uncommittedDiff when the turn is linked to a commit', () => {
    const out = computeAgyEmptyTurnRepairs(
      [{ promptIndex: 1, promptText: 'write code', filesChanged: [], diff: '', commitSha: 'abc1234' }],
      records, WORK,
    );
    expect(out[0].commitSha).toBe('abc1234');
    expect(out[0].uncommittedDiff).toBe('');
    expect(JSON.parse(out[0].editsJson).edits).toHaveLength(1);
  });

  it('is idempotent — a repaired turn is skipped on a second run', () => {
    const first = computeAgyEmptyTurnRepairs(
      [{ promptIndex: 1, promptText: 'write code', filesChanged: [], diff: '' }],
      records, WORK,
    );
    // The server renders the repaired row from editsJson, so on the next read
    // its `diff` comes back populated — which is what makes this a no-op.
    const second = computeAgyEmptyTurnRepairs(
      [{ promptIndex: 1, promptText: 'write code', filesChanged: first[0].filesChanged, diff: 'diff --git a/random_password.py b/random_password.py' }],
      records, WORK,
    );
    expect(second).toEqual([]);
  });
});
