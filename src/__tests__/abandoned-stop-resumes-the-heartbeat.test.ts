// A Stop killed after marking its turn closed, but before its row went out,
// left the heartbeat silent on that turn: `turnIsClosed` read the mark alone,
// so the row stayed at the last pre-Stop tick until the next prompt or session
// end (Origin TODO 00ced3dc; Codex's Stop is killed at its hook timeout).
//
// The heartbeat now resumes such a turn — and ONLY such a turn: a Stop still
// running, one that sent its row, and one that finished all keep it silent.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getStatePath, markStopSentOnDisk, markTurnClosedOnDisk, closeTurn } from '../session-state.js';
import { STOP_ABANDONED_AFTER_MS, stopAbandonedTurn, turnIsClosed } from '../turn-commit-scope.js';

const roots: string[] = [];
function repoWithState(state: Record<string, unknown>): { repo: string; statePath: string } {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-abandoned-stop-')));
  roots.push(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const statePath = getStatePath(repo, 'tag-0001');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { repo, statePath };
}
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

// What the heartbeat asks before sending a turn's in-flight row.
const heartbeatStaysSilent = (s: any, turn: number, now: number) =>
  turnIsClosed(s, turn) && !stopAbandonedTurn(s, turn, now);

const open1 = () => ({ sessionId: 's-1', sessionTag: 'tag-0001', prompts: ['a', 'b'], lastClosedTurnIndex: 0, activeTurn: { index: 1, turnId: 't_1' } });
const LATER = STOP_ABANDONED_AFTER_MS + 1_000;

describe('a Stop killed between the mark and the send', () => {
  it('keeps the heartbeat silent while it may still be running, then lets it resume the turn', () => {
    const { repo, statePath } = repoWithState(open1());
    const at = 1_000_000;
    markTurnClosedOnDisk(repo, 'tag-0001', 1, at);
    const s = read(statePath);
    expect(heartbeatStaysSilent(s, 1, at + 5_000)).toBe(true);
    expect(heartbeatStaysSilent(s, 1, at + LATER)).toBe(false);
  });

  it('a Stop that sent its row keeps the heartbeat silent, however long ago', () => {
    const { repo, statePath } = repoWithState(open1());
    const at = 1_000_000;
    markTurnClosedOnDisk(repo, 'tag-0001', 1, at);
    expect(markStopSentOnDisk(repo, 'tag-0001', 1)).toBe(true);
    expect(heartbeatStaysSilent(read(statePath), 1, at + LATER)).toBe(true);
  });

  it('a Stop that finished (closeTurn) keeps the heartbeat silent', () => {
    const { repo, statePath } = repoWithState(open1());
    const at = 1_000_000;
    markTurnClosedOnDisk(repo, 'tag-0001', 1, at);
    const s = read(statePath);
    closeTurn(s, 1);
    expect(heartbeatStaysSilent(s, 1, at + LATER)).toBe(true);
  });

  it('a mark for another turn does not reopen this one', () => {
    const s = { ...open1(), lastClosedTurnIndex: 1, stopClosing: { turn: 0, at: 0 } };
    expect(heartbeatStaysSilent(s, 1, LATER)).toBe(true);
  });

  it('a state from before this change (no stamp) behaves as before', () => {
    const s = { ...open1(), lastClosedTurnIndex: 1 };
    expect(heartbeatStaysSilent(s, 1, Date.now())).toBe(true);
  });

  it('the sent mark only moves forward', () => {
    const { repo, statePath } = repoWithState({ sessionId: 's-1', stopSentTurnIndex: 4 });
    expect(markStopSentOnDisk(repo, 'tag-0001', 2)).toBe(true);
    expect(read(statePath).stopSentTurnIndex).toBe(4);
  });
});
