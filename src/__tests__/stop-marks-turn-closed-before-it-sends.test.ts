// Stop stamps its row at send time and used to record the closed turn only in
// its final save. A heartbeat tick that began in between read "open", carried
// a newer stamp, and replaced Stop's row. markTurnClosedOnDisk records the
// close first, touching nothing else in the state file.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { closedTurnMarkedMeanwhile, getStatePath, markTurnClosedOnDisk, saveSessionState } from '../session-state.js';
import { turnIsClosed } from '../turn-commit-scope.js';
import { turnClosedByStop } from '../restored-from-history.js';

const roots: string[] = [];
function repoWithState(state: Record<string, unknown>): { repo: string; statePath: string } {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mark-closed-')));
  roots.push(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const statePath = getStatePath(repo, 'tag-0001');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { repo, statePath };
}
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('markTurnClosedOnDisk', () => {
  it('a tick reading the state after the mark sees the turn closed; nothing else moved', () => {
    const before = {
      sessionId: 's-1', sessionTag: 'tag-0001', prompts: ['a', 'b'], lastClosedTurnIndex: 0,
      activeTurn: { index: 1, turnId: 't_1' }, sessionCommitShas: ['abc1234'],
    };
    const { repo, statePath } = repoWithState(before);
    expect(turnIsClosed(read(statePath), 1)).toBe(false);

    expect(markTurnClosedOnDisk(repo, 'tag-0001', 1)).toBe(true);

    const after = read(statePath);
    expect(turnIsClosed(after, 1)).toBe(true);
    expect(after).toEqual({ ...before, lastClosedTurnIndex: 1 });
    // A Stop that dies after the mark has not claimed a row: the turn a tool
    // opened still reads as not closed BY STOP at the next prompt.
    expect(turnClosedByStop(after, 1)).toBe(false);
  });

  it('never moves the marker backwards', () => {
    const { repo, statePath } = repoWithState({ sessionId: 's-1', lastClosedTurnIndex: 4 });
    expect(markTurnClosedOnDisk(repo, 'tag-0001', 2)).toBe(true);
    expect(read(statePath).lastClosedTurnIndex).toBe(4);
  });

  it('answers false and writes nothing when there is no state file or no turn', () => {
    const { repo, statePath } = repoWithState({ sessionId: 's-1' });
    expect(markTurnClosedOnDisk(repo, 'tag-0001', -1)).toBe(false);
    expect(markTurnClosedOnDisk(repo, 'tag-other', 0)).toBe(false);
    expect(read(statePath)).toEqual({ sessionId: 's-1' });
    expect(fs.existsSync(getStatePath(repo, 'tag-other'))).toBe(false);
  });

  // Stop read its state BEFORE the mark and saves it again on the way to
  // closeTurn: once when a journal/shell pass recorded an edit (any turn that
  // changed a file), then for the budget signal and the images. Written as
  // read, the first of those put the turn back to "open" a millisecond after
  // the mark (review of #1725).
  it("Stop's own saves after the mark keep the turn closed on disk — every one, not only the first", () => {
    const { repo, statePath } = repoWithState({
      sessionId: 's-1', sessionTag: 'tag-0001', prompts: ['a', 'b'], lastClosedTurnIndex: 0,
      activeTurn: { index: 1, turnId: 't_1' },
    });
    const state = read(statePath); // what Stop holds: the state as it was BEFORE the mark
    expect(state.lastClosedTurnIndex).toBe(0);

    expect(markTurnClosedOnDisk(repo, 'tag-0001', 1)).toBe(true);

    (state as any).liveEdits = [{ file: 'a.ts' }];
    saveSessionState(state, repo, 'tag-0001');
    expect(turnIsClosed(read(statePath), 1)).toBe(true);
    expect(read(statePath).liveEdits).toEqual([{ file: 'a.ts' }]);
    // The second save finds its own last write on disk and does not re-read it.
    (state as any).liveEdits = [{ file: 'a.ts' }, { file: 'b.ts' }];
    saveSessionState(state, repo, 'tag-0001');
    expect(turnIsClosed(read(statePath), 1)).toBe(true);

    // Stop goes on reading ITS OWN marker until closeTurn: moved under it,
    // currentTurnIndex would bind the next turn mid-capture.
    expect(state.lastClosedTurnIndex).toBe(0);
  });

  it('carries the marker only forward, and only from this session\'s own file', () => {
    expect(closedTurnMarkedMeanwhile({ sessionId: 's-1', lastClosedTurnIndex: 0 }, { sessionId: 's-1', lastClosedTurnIndex: 1 })).toBe(1);
    expect(closedTurnMarkedMeanwhile({ sessionId: 's-1' }, { sessionId: 's-1', lastClosedTurnIndex: 0 })).toBe(0);
    expect(closedTurnMarkedMeanwhile({ sessionId: 's-1', lastClosedTurnIndex: 3 }, { sessionId: 's-1', lastClosedTurnIndex: 1 })).toBeNull();
    // A new session taking over the tag starts at its own first turn.
    expect(closedTurnMarkedMeanwhile({ sessionId: 's-2' }, { sessionId: 's-1', lastClosedTurnIndex: 12 })).toBeNull();
    expect(closedTurnMarkedMeanwhile({ sessionId: 's-1' }, { sessionId: 's-1', lastClosedTurnIndex: 'x' as any })).toBeNull();
    expect(closedTurnMarkedMeanwhile({ sessionId: 's-1' }, null)).toBeNull();
  });
});
