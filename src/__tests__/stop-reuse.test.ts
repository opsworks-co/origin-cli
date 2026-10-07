/**
 * Stop sends settled turns as the last Stop saved them, and re-derives every
 * turn the moment anything that can change one has moved (TODO 4a6c17ce).
 */
import { describe, it, expect } from 'vitest';
import { applySavedRow, nextStopReuseMark, settledRowsToReuse, settledTurnsKey, STOP_REUSE_FULL_EVERY_MS } from '../stop-reuse.js';

const NOW = 1_800_000_000_000;
const row = (i: number, extra: Record<string, unknown> = {}) => ({ promptIndex: i, promptText: `p${i}`, filesChanged: [`f${i}.ts`], diff: `diff ${i}`, linesAdded: i, linesRemoved: 0, ...extra });

function session(turns = 4) {
  const state: any = {
    prompts: Array.from({ length: turns }, (_, i) => `p${i}`),
    promptTurnIds: Array.from({ length: turns }, (_, i) => `t_${i}`),
    promptIndexBase: 0,
    promptShadows: Array.from({ length: turns }, (_, i) => ({ promptIndex: i, shadowSha: `s${i}` })),
    turnEndShadows: Array.from({ length: turns - 1 }, (_, i) => ({ promptIndex: i, shadowSha: `e${i}` })),
    commitTurns: [{ sha: 'c1', turnId: 't_1' }],
    rewrittenCommits: [],
    completedPromptMappings: Array.from({ length: turns - 1 }, (_, i) => row(i)),
  };
  // The last Stop closed turn turns-2 and left its mark.
  state.stopReuse = nextStopReuseMark(state, { head: 'H1', closedLocal: turns - 2, reused: false, now: NOW - 60_000 });
  return state;
}
const decide = (state: any, over: Partial<Parameters<typeof settledRowsToReuse>[0]> = {}) => settledRowsToReuse({
  state, head: 'H2', repoPath: '/r', now: NOW, env: {}, ancestor: () => true, ...over,
});

describe('settled turns are reused only when nothing that shapes them moved', () => {
  it('reuses every turn before the one the last Stop closed — that one stays live', () => {
    const r = decide(session(5));
    expect(r.reason).toBe('reused');
    expect([...r.rows.keys()].sort()).toEqual([0, 1, 2]);
  });

  it('re-derives everything when history moved (checkout, reset, rebase)', () => {
    expect(decide(session(), { ancestor: () => false }).reason).toBe('history moved');
  });

  it('re-derives everything when a settled turn gained or lost a commit', () => {
    const s = session();
    s.commitTurns.push({ sha: 'c9', turnId: 't_0' });
    expect(decide(s).reason).toBe('a settled turn changed');
  });

  it('re-derives everything on a rewrite, a squash record or a replay', () => {
    for (const mutate of [
      (s: any) => { s.rewrittenCommits = [{ from: 'c1', to: 'c1b' }]; },
      (s: any) => { s.preSquashCommitTurns = [{ sha: 'c1', turnId: 't_1', squash: 'q' }]; },
      (s: any) => { s.replayedCommits = ['c1']; },
    ]) {
      const s = session();
      mutate(s);
      expect(decide(s).reason).toBe('a settled turn changed');
    }
  });

  it('re-derives everything when a settled prompt was renumbered or its shadow moved', () => {
    const a = session(); a.prompts.splice(1, 0, 'inserted');
    expect(decide(a).reason).toBe('a settled turn changed');
    const b = session(); b.turnEndShadows[0].shadowSha = 'moved';
    expect(decide(b).reason).toBe('a settled turn changed');
  });

  it('ignores what only the live turns carry', () => {
    const s = session(4);
    s.commitTurns.push({ sha: 'c-new', turnId: 't_3' }); // the turn now closing
    s.prompts.push('p4');
    expect(decide(s).reason).toBe('reused');
  });

  it('a full rebuild at least every 30 minutes, and none without a mark or when disabled', () => {
    const s = session();
    s.stopReuse.fullAt = NOW - STOP_REUSE_FULL_EVERY_MS - 1;
    expect(decide(s).reason).toBe('periodic full rebuild');
    const t = session(); delete t.stopReuse;
    expect(decide(t).reason).toBe('no mark');
    expect(decide(session(), { env: { ORIGIN_STOP_REUSE: '0' } }).reason).toBe('disabled');
  });

  it('refuses when a settled turn has no saved row to send', () => {
    const s = session(4);
    s.completedPromptMappings.splice(0, 1);
    expect(decide(s).reason).toBe('a settled turn has no saved row');
  });

  it('a reusing Stop keeps the last full rebuild\'s time; a full one resets it', () => {
    const s = session();
    const fullAt = s.stopReuse.fullAt;
    expect(nextStopReuseMark(s, { head: 'H3', closedLocal: 3, reused: true, now: NOW })!.fullAt).toBe(fullAt);
    expect(nextStopReuseMark(s, { head: 'H3', closedLocal: 3, reused: false, now: NOW })!.fullAt).toBe(NOW);
    expect(nextStopReuseMark(s, { head: 'H3', closedLocal: 3, reused: false, now: NOW })!.key).toBe(settledTurnsKey(s, 3));
  });

  it('a reused row goes out exactly as saved, keeping the mapping\'s identity', () => {
    const pm: any = { promptIndex: 2, promptText: 'fresh text', turnId: 't_2', diff: 'rebuilt', filesChanged: ['x'], ledgerOwned: true };
    applySavedRow(pm, { promptIndex: 2, promptText: 'saved', diff: 'saved diff', filesChanged: ['f2.ts'], commitPatch: true, capturedAt: 'x' });
    expect(pm).toEqual({ promptIndex: 2, promptText: 'fresh text', turnId: 't_2', diff: 'saved diff', filesChanged: ['f2.ts'], commitPatch: true });
  });
});
