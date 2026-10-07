// Which turn made a commit a later rewrite replaced.
//
// `commitTurns` names survivors only, so a sha a rebase or forge squash
// replaced matched no attestation and was taken for the asking turn's own
// work (session 127d3303 turn 1). The fold now keeps who made each commit it
// takes away (`foldedCommitTurns`), and commitTurnOf reads it.
import { describe, it, expect } from 'vitest';
import { applyRewritePairsToState, commitTurnOf, keepCommitRecordsSavedMeanwhile } from '../session-state.js';

const sha = (c: string) => c.repeat(40);
const at = (m: number) => `2026-09-30T18:${String(m).padStart(2, '0')}:00.000Z`;

describe('commitTurnOf', () => {
  it('finds a commit attested directly, by prefix too', () => {
    const state = { commitTurns: [{ sha: sha('a'), turnId: 't0', at: at(1), via: 'post-commit' as const }] };
    expect(commitTurnOf(state, sha('a'))?.turnId).toBe('t0');
    expect(commitTurnOf(state, 'aaaaaaa')?.turnId).toBe('t0');
    expect(commitTurnOf(state, sha('b'))).toBeUndefined();
  });

  it('keeps a rebased copy the forge then squashed with the turn that made the commit', () => {
    // 127d3303: turn 0 commits 8…, turn 1 rebases it as 1…, GitHub squashes it as 9….
    const state: any = { commitTurns: [{ sha: sha('8'), turnId: 't0', at: at(44), via: 'post-commit' }] };
    applyRewritePairsToState(state, [{ from: sha('8'), to: sha('1') }]);
    applyRewritePairsToState(state, [{ from: sha('1'), to: sha('9') }]);
    expect(state.commitTurns.map((c: any) => c.sha)).toEqual([sha('9')]);
    expect(commitTurnOf(state, sha('1'))?.turnId).toBe('t0');
    expect(commitTurnOf(state, sha('8'))?.turnId).toBe('t0');
  });

  it('records every hop when the pairs arrive together', () => {
    const state: any = { commitTurns: [{ sha: sha('8'), turnId: 't0', at: at(44), via: 'post-commit' }] };
    applyRewritePairsToState(state, [{ from: sha('8'), to: sha('1') }, { from: sha('1'), to: sha('9') }]);
    expect(commitTurnOf(state, sha('1'))?.turnId).toBe('t0');
  });

  it('leaves a commit amended by the NEXT turn with the turn that made it', () => {
    const state: any = {
      commitTurns: [
        { sha: sha('a'), turnId: 't0', at: at(1), via: 'post-commit' },
        { sha: sha('b'), turnId: 't1', at: at(5), via: 'post-commit' },
      ],
    };
    applyRewritePairsToState(state, [{ from: sha('a'), to: sha('b') }]);
    expect(commitTurnOf(state, sha('a'))?.turnId).toBe('t0');
  });

  it('keeps folded attestations a stale save would drop', () => {
    const mine: any = { sessionId: 's', commitTurns: [], foldedCommitTurns: [] };
    const disk: any = { sessionId: 's', foldedCommitTurns: [{ sha: sha('1'), turnId: 't0' }] };
    keepCommitRecordsSavedMeanwhile(mine, disk);
    expect(commitTurnOf(mine, sha('1'))?.turnId).toBe('t0');
  });
});
