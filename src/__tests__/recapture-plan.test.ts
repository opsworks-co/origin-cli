// `origin recapture` decides which stored turns to OVERWRITE in production,
// so the rules that gate it are tested on their own, without network or disk.
//
// The repair exists for one bug: a rejected edit tool call captured as work
// (#1249). Session cb853c02 turn 2 stored +240 for a file git says gained
// +124 — the failed 5→121-line Edit plus the successful retry of the same
// block.
//
// The hazard on the other side is bigger than the bug. A transcript sees tool
// calls and nothing else, so a turn that wrote through the shell
// (`python - <<'EOF'`, `sed -i`) re-captures SMALLER than the truth git
// recorded. Turn 1 of that same session stores +444/-81, matching git exactly,
// while its transcript capture yields +204. Re-sending that would destroy a
// correct row — so `droppedFailedEdits > 0` is the gate, not "the numbers
// differ".
import { describe, it, expect } from 'vitest';
import { planRepairs, editsToDiffInput, type TurnNumbers } from '../commands/recapture.js';
import type { PromptCapture, PromptEdit } from '../prompt-capture/types.js';

const edit = (file: string, oldC: string, newC: string): PromptEdit => ({
  file, op: 'edit', oldContent: oldC, newContent: newC, source: 'tool_call',
} as PromptEdit);

const capture = (over: Partial<PromptCapture> = {}): PromptCapture => ({
  promptIndex: 0,
  promptText: 'do the thing',
  agent: 'claude',
  edits: [edit('a.ts', 'x', 'y\nz')],
  commits: [],
  droppedFailedEdits: 0,
  ...over,
});

const storedTurn = (over: Partial<TurnNumbers> = {}): TurnNumbers => ({
  promptIndex: 0, linesAdded: 100, linesRemoved: 10, files: 1, ...over,
});

describe('planRepairs', () => {
  it('repairs a turn that dropped a rejected edit and now counts lower', () => {
    const plan = planRepairs([capture({ droppedFailedEdits: 1 })], [storedTurn()]);

    expect(plan.repairs).toHaveLength(1);
    expect(plan.repairs[0].promptIndex).toBe(0);
    expect(plan.repairs[0].before.linesAdded).toBe(100);
    expect(plan.repairs[0].after.linesAdded).toBeLessThan(100);
    expect(plan.repairs[0].droppedFailedEdits).toBe(1);
    expect(plan.repairs[0].diff).toContain('diff --git a/a.ts b/a.ts');
  });

  it('leaves a turn alone when nothing was rejected — the shell-write hazard', () => {
    // Same shape as cb853c02 turn 1: stored +444 from git, transcript sees 204.
    const plan = planRepairs(
      [capture({ droppedFailedEdits: 0 })],
      [storedTurn({ linesAdded: 444, linesRemoved: 81 })],
    );

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/no failed edits/);
  });

  it('refuses to send a re-capture that is LARGER than what is stored', () => {
    // Not this bug: the repair only ever removes phantom lines. A bigger
    // capture means the transcript is seeing something the row isn't, and
    // overwriting git-derived truth with it is not a repair.
    const plan = planRepairs([capture({ droppedFailedEdits: 1 })], [storedTurn({ linesAdded: 1, linesRemoved: 0 })]);

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/LARGER/);
  });

  it('refuses to blank a turn whose re-capture has no edits', () => {
    const plan = planRepairs([capture({ droppedFailedEdits: 2, edits: [] })], [storedTurn()]);

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/would blank the turn/);
  });

  it('skips a turn that already matches', () => {
    const cap = capture({ droppedFailedEdits: 1 });
    const first = planRepairs([cap], [storedTurn()]).repairs[0];
    const plan = planRepairs([cap], [storedTurn({ ...first.after })]);

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/already match/);
  });

  it('skips a transcript turn the server has never seen', () => {
    const plan = planRepairs([capture({ promptIndex: 7, droppedFailedEdits: 1 })], [storedTurn()]);

    expect(plan.repairs).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/no stored turn/);
  });

  it('reports files from the corrected edits, deduped', () => {
    const plan = planRepairs(
      [capture({
        droppedFailedEdits: 1,
        edits: [edit('a.ts', 'x', 'y'), edit('a.ts', 'p', 'q'), edit('b.ts', 'm', 'n')],
      })],
      [storedTurn({ linesAdded: 99, files: 5 })],
    );

    expect(plan.repairs[0].filesChanged).toEqual(['a.ts', 'b.ts']);
    expect(plan.repairs[0].after.files).toBe(2);
  });
});

describe('editsToDiffInput', () => {
  it('maps a region edit to the Edit tool shape', () => {
    expect(editsToDiffInput([edit('a.ts', 'old', 'new')])).toEqual([
      { file: 'a.ts', toolName: 'Edit', input: { old_string: 'old', new_string: 'new' } },
    ]);
  });

  it('maps a whole-file write to the Write tool shape', () => {
    const write = { file: 'b.ts', op: 'write', newContent: 'line\n', source: 'tool_call' } as PromptEdit;

    expect(editsToDiffInput([write])).toEqual([
      { file: 'b.ts', toolName: 'Write', input: { content: 'line\n' } },
    ]);
  });
});
