// The rules that decide what `origin repair-merges` overwrites in production.
// Modelled on prod f7881a6e, where one merge damaged two different turns in
// two different ways:
//
//   idx 1 | "how many lines did you add"  | 2 files, +55 -13   ← did NOTHING
//   idx 2 | "merge the PR and deploy it"  | 3 files, +0  -0    ← made the merge
//
// `final-state-blame.ts` came in WITH the merge and was written by another PR;
// `package.json` is what the merge resolved and belongs to idx 2.
import { describe, it, expect } from 'vitest';
import { planMergeRepairs, planSessionDiffRepair, planEditsJsonRepair, type StoredTurn, type MergeFacts } from '../commands/repair-merges.js';

const MERGE: MergeFacts = {
  sha: 'e1ab02e452fc645c30bc90018dedf256f30e86ec',
  ownFiles: ['packages/cli/package.json', 'packages/cli/package-lock.json'],
  ownDiff: [
    'diff --git a/packages/cli/package.json b/packages/cli/package.json',
    '--- a/packages/cli/package.json',
    '+++ b/packages/cli/package.json',
    '@@ -1 +1 @@',
    '-  "version": "0.1"',
    '+  "version": "0.2"',
  ].join('\n'),
  absorbedFiles: ['packages/cli/src/final-state-blame.ts', 'packages/cli/src/transcript-watch.ts'],
};

const turn = (o: Partial<StoredTurn> & { promptIndex: number }): StoredTurn => ({
  promptText: '', linesAdded: 0, linesRemoved: 0, files: [], commitShas: [], hasEdits: false, ...o,
});

describe('planMergeRepairs', () => {
  it('gives the merging turn what it resolved, not the branch it absorbed', () => {
    const plan = planMergeRepairs(
      [turn({ promptIndex: 2, turnId: 't_12e7f9f6', linesAdded: 0, linesRemoved: 0,
        files: ['packages/cli/package.json', 'packages/cli/src/final-state-blame.ts'],
        commitShas: [MERGE.sha] })],
      [MERGE], new Map([[2, []]]),
    );
    expect(plan.repairs).toHaveLength(1);
    const r = plan.repairs[0];
    expect(r.rule).toBe('merge-turn');
    expect(r.filesChanged).toEqual(MERGE.ownFiles);
    expect(r.diff).not.toContain('final-state-blame');
    expect(r.after).toEqual({ linesAdded: 1, linesRemoved: 1, files: 2 });
    expect(r.turnId).toBe('t_12e7f9f6');
  });

  it('clears a turn wearing the merge’s fallout', () => {
    const plan = planMergeRepairs(
      [turn({ promptIndex: 1, turnId: 't_1f32a0c2', linesAdded: 55, linesRemoved: 13,
        files: ['packages/cli/src/final-state-blame.ts', 'packages/cli/package.json'] })],
      [MERGE], new Map([[1, []]]),
    );
    expect(plan.repairs).toHaveLength(1);
    expect(plan.repairs[0].rule).toBe('merge-fallout');
    expect(plan.repairs[0].chatOnly).toBe(true);
    expect(plan.repairs[0].after).toEqual({ linesAdded: 0, linesRemoved: 0, files: 0 });
  });

  it('will not blank a turn the transcript says did work', () => {
    const plan = planMergeRepairs(
      [turn({ promptIndex: 1, linesAdded: 55, linesRemoved: 13,
        files: ['packages/cli/src/final-state-blame.ts'] })],
      [MERGE], new Map([[1, ['packages/cli/src/final-state-blame.ts']]]),
    );
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/transcript shows 1 edited/);
  });

  it('refuses rule B with no transcript — a shell-only turn looks identical', () => {
    const plan = planMergeRepairs(
      [turn({ promptIndex: 1, linesAdded: 55, linesRemoved: 13,
        files: ['packages/cli/src/final-state-blame.ts'] })],
      [MERGE], null,
    );
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/no transcript/);
  });

  it('leaves an ordinary turn alone', () => {
    const plan = planMergeRepairs(
      [turn({ promptIndex: 0, linesAdded: 219, linesRemoved: 37,
        files: ['packages/cli/src/commands/hooks.ts'], commitShas: ['c5bb134d'] })],
      [MERGE], new Map([[0, ['packages/cli/src/commands/hooks.ts']]]),
    );
    expect(plan.repairs).toHaveLength(0);
  });

  it('does not touch a turn that carries its own editsJson', () => {
    const plan = planMergeRepairs(
      [turn({ promptIndex: 1, linesAdded: 55, linesRemoved: 13,
        files: ['packages/cli/src/final-state-blame.ts'], hasEdits: true })],
      [MERGE], new Map([[1, []]]),
    );
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/editsJson/);
  });

  it('is a no-op once the row already matches the merge', () => {
    const plan = planMergeRepairs(
      [turn({ promptIndex: 2, linesAdded: 1, linesRemoved: 1,
        files: MERGE.ownFiles, commitShas: [MERGE.sha] })],
      [MERGE], new Map([[2, []]]),
    );
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/already matches/);
  });

  it('refuses a turn that committed real work alongside the merge', () => {
    // prod f7881a6e turn 4: the merge AND 5709877b2, ~150 lines of real work.
    // Replacing the row with the merge's 3 lines would have deleted it.
    const plan = planMergeRepairs(
      [turn({ promptIndex: 4, linesAdded: 62, linesRemoved: 9,
        files: ['packages/cli/src/history-backfill.ts'],
        commitShas: [MERGE.sha, '5709877b2ce7f20907db4eeb79f84c961da187f6'] })],
      [MERGE], new Map([[4, []]]),
    );
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/as well as the merge/);
  });

  it('does nothing at all when the session has no merge', () => {
    expect(planMergeRepairs([turn({ promptIndex: 0, files: ['a.ts'] })], [], null).repairs).toHaveLength(0);
  });
});

// ── The session HEADER ────────────────────────────────────────────────────
// A separate stored surface from the per-turn rows: fixing the rows left it
// wrong. For a claude-code session the session capture goes through mcp.ts's
// APPEND path, and an append only grows — sections a pre-#1334 capture wrote,
// carrying a merge's whole absorbed branch, stay forever.
//
// Prod f7881a6e: +1607/-119 over 30 sections, of which eight files were other
// PRs' code arriving with a merge (+533/-50). 1607 - 533 = 1074 = its own work.
describe('planSessionDiffRepair', () => {
  const section = (file: string, adds: number, dels = 0) => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    ...Array.from({ length: adds }, (_, i) => `+line ${i}`),
    ...Array.from({ length: dels }, (_, i) => `-old ${i}`),
    '',
  ].join('\n');

  const stored = section('packages/cli/src/commands/hooks.ts', 207, 50)
    + section('packages/cli/src/final-state-blame.ts', 54, 12)
    + section('packages/cli/src/transcript-watch.ts', 29, 7);

  it('drops only the files that arrived with a merge', () => {
    const r = planSessionDiffRepair(stored, { linesAdded: 290, linesRemoved: 69 }, new Set([
      'packages/cli/src/final-state-blame.ts', 'packages/cli/src/transcript-watch.ts',
    ]))!;
    expect(r.droppedFiles).toHaveLength(2);
    expect(r.after.sections).toBe(1);
    expect(r.after).toEqual({ linesAdded: 207, linesRemoved: 50, sections: 1 });
    expect(r.diff).toContain('hooks.ts');
    expect(r.diff).not.toContain('final-state-blame');
  });

  it('never drops content whose path cannot be read', () => {
    // Anything before the first `diff --git` splits off with an empty path.
    // It cannot be SHOWN to be foreign, so it is kept — a repair that removes
    // what it cannot identify is how a diff loses real work.
    const lead = 'diff --cc packages/cli/src/final-state-blame.ts\n@@@ -1 -1 +1 @@@\n++x\n';
    const r = planSessionDiffRepair(lead + stored, { linesAdded: 291, linesRemoved: 69 },
      new Set(['packages/cli/src/final-state-blame.ts', 'packages/cli/src/transcript-watch.ts']));
    expect(r!.diff).toContain('diff --cc');
    expect(r!.diff).not.toContain('+line 0\n+line 1\n+line 2\n+line 3\n+line 4\n+line 5\n+line 6\n+line 7\n+line 8\n+line 9\n+line 10\n+line 11\n+line 12\n+line 13\n+line 14\n+line 15\n+line 16\n+line 17\n+line 18\n+line 19\n+line 20\n+line 21\n+line 22\n+line 23\n+line 24\n+line 25\n+line 26\n+line 27\n+line 28\n-old 0');
  });

  it('is null when nothing is foreign', () => {
    expect(planSessionDiffRepair(stored, { linesAdded: 290, linesRemoved: 69 }, new Set())).toBeNull();
  });

  it('is null when the result would not be smaller', () => {
    // Stored totals already lower than the text — something else is wrong and
    // this repair must not "correct" it upward.
    expect(planSessionDiffRepair(stored, { linesAdded: 10, linesRemoved: 2 },
      new Set(['packages/cli/src/transcript-watch.ts']))).toBeNull();
  });
});

// ── The stored per-turn CAPTURE ───────────────────────────────────────────
// The header is synthesized from every turn's editsJson, so until the stored
// captures are cleaned it keeps counting another PR's code no matter what the
// capture side does from now on.
describe('planEditsJsonRepair', () => {
  const FOREIGN = 'packages/cli/src/final-state-blame.ts';
  const MINE = 'packages/cli/src/commands/hooks.ts';
  const sec = (f: string, n: number) => [
    `diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, '@@ -1 +1 @@',
    ...Array.from({ length: n }, (_, i) => `+l${i}`), '',
  ].join('\n');

  const row = (o: any = {}) => ({
    turnId: 't_x', promptIndex: 3,
    editsJson: JSON.stringify({ edits: [{ file: MINE, op: 'edit' }, { file: FOREIGN, op: 'edit' }] }),
    diff: sec(MINE, 5) + sec(FOREIGN, 40),
    filesChanged: [MINE, FOREIGN],
    linesAdded: 45, linesRemoved: 0,
    ...o,
  });

  it('removes the absorbed file from all three projections at once', () => {
    const [r] = planEditsJsonRepair([row()], new Set([FOREIGN]));
    expect(JSON.parse(r.editsJson).edits).toEqual([{ file: MINE, op: 'edit' }]);
    expect(r.filesChanged).toEqual([MINE]);
    expect(r.diff).not.toContain('final-state-blame');
    expect(r.after).toEqual({ linesAdded: 5, linesRemoved: 0, files: 1, edits: 1 });
  });

  it('leaves a row alone when nothing it holds is foreign', () => {
    expect(planEditsJsonRepair([row({
      editsJson: JSON.stringify({ edits: [{ file: MINE, op: 'edit' }] }),
      diff: sec(MINE, 5), filesChanged: [MINE], linesAdded: 5,
    })], new Set([FOREIGN]))).toHaveLength(0);
  });

  it('empties a row whose every edit was absorbed', () => {
    const [r] = planEditsJsonRepair([row({
      editsJson: JSON.stringify({ edits: [{ file: FOREIGN, op: 'edit' }] }),
      diff: sec(FOREIGN, 40), filesChanged: [FOREIGN], linesAdded: 40,
    })], new Set([FOREIGN]));
    expect(JSON.parse(r.editsJson).edits).toEqual([]);
    expect(r.after).toEqual({ linesAdded: 0, linesRemoved: 0, files: 0, edits: 0 });
  });

  it('preserves capture fields other than edits', () => {
    const [r] = planEditsJsonRepair([row({
      editsJson: JSON.stringify({ promptIndex: 3, finalHunks: [1], edits: [{ file: FOREIGN }] }),
    })], new Set([FOREIGN]));
    const cap = JSON.parse(r.editsJson);
    expect(cap.finalHunks).toEqual([1]);
    expect(cap.promptIndex).toBe(3);
  });

  it('does nothing when there is no foreign set', () => {
    expect(planEditsJsonRepair([row()], new Set())).toHaveLength(0);
  });
});
