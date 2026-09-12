// A rewrite pair applied one hop at a time stops on an intermediate copy.
//
// Session 8a06aaf6 (2026-09-09): one PR went through a conflicting rebase,
// two amends, a second rebase and GitHub's squash. The rescue found three of
// the five pairs across two Stops, mapped the sha list through only the
// newest pair each time, and `commitTurns` — remapped through the same
// single hop — kept attesting two intermediates the sha list had already
// dropped. The server badged the turn with them.
import { describe, it, expect } from 'vitest';
import { applyRewritePairsToState, finalRewriteOf } from '../session-state.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

describe('finalRewriteOf', () => {
  const chain = [{ from: A, to: B }, { from: B, to: C }, { from: C, to: D }];

  it('follows the whole chain', () => {
    expect(finalRewriteOf(A, chain)).toBe(D);
    expect(finalRewriteOf(B, chain)).toBe(D);
    expect(finalRewriteOf(D, chain)).toBe(D);
  });

  it('is its own answer for a sha nothing rewrote, and with no pairs', () => {
    expect(finalRewriteOf('e'.repeat(40), chain)).toBe('e'.repeat(40));
    expect(finalRewriteOf(A, [])).toBe(A);
    expect(finalRewriteOf(A, null)).toBe(A);
  });

  it('tolerates short shas on either side', () => {
    expect(finalRewriteOf(A.slice(0, 8), chain)).toBe(D);
    expect(finalRewriteOf(A, [{ from: A.slice(0, 12), to: B }, { from: B, to: C.slice(0, 10) }])).toBe(C.slice(0, 10));
  });

  it('stops on a cycle instead of looping', () => {
    expect(finalRewriteOf(A, [{ from: A, to: B }, { from: B, to: A }])).toBe(B);
    expect(finalRewriteOf(A, [{ from: A, to: A }])).toBe(A);
  });
});

describe('applyRewritePairsToState', () => {
  it('records the pairs and moves the sha list and the attestation onto the final survivor', () => {
    const state: any = {
      sessionCommitShas: [A, B, 'f'.repeat(40)],
      rewrittenCommits: [{ from: A, to: B }],
      commitTurns: [
        { sha: A, turnId: 't_1', at: '2026-09-09T02:35:20.514Z', via: 'post-commit' },
        { sha: B, turnId: 't_1', at: '2026-09-09T02:37:03.635Z', via: 'post-commit' },
        { sha: 'f'.repeat(40), turnId: 't_2', at: '2026-09-09T03:00:00.000Z', via: 'post-commit' },
      ],
    };
    expect(applyRewritePairsToState(state, [{ from: B, to: C }, { from: C, to: D }])).toBe(true);
    expect(state.rewrittenCommits).toEqual([{ from: A, to: B }, { from: B, to: C }, { from: C, to: D }]);
    expect(state.sessionCommitShas).toEqual([D, 'f'.repeat(40)]);
    expect(state.commitTurns).toEqual([
      { sha: D, turnId: 't_1', at: '2026-09-09T02:35:20.514Z', via: 'post-commit' },
      { sha: 'f'.repeat(40), turnId: 't_2', at: '2026-09-09T03:00:00.000Z', via: 'post-commit' },
    ]);
  });

  it('ignores self-maps and exact repeats, and reports no change', () => {
    const state: any = { sessionCommitShas: [B], rewrittenCommits: [{ from: A, to: B }], commitTurns: [] };
    expect(applyRewritePairsToState(state, [{ from: A, to: B }, { from: B, to: B }])).toBe(false);
    expect(state.rewrittenCommits).toEqual([{ from: A, to: B }]);
    expect(state.sessionCommitShas).toEqual([B]);
  });

  it("a sha rewritten AGAIN takes git's latest word, and a cycle from an identical amend dissolves", () => {
    // Two amends in one second reproduced B byte-for-byte: git said B → C,
    // then C → B, then (the next rebase) B → D. First-wins kept B → C and
    // every chain from B stopped inside the cycle.
    const state: any = {
      sessionCommitShas: [B], rewrittenCommits: [{ from: B, to: C }, { from: C, to: B }],
      commitTurns: [{ sha: B, turnId: 't_1', at: '2026-09-09T16:00:00.000Z', via: 'post-commit' }],
    };
    expect(applyRewritePairsToState(state, [{ from: B, to: D }])).toBe(true);
    expect(state.rewrittenCommits).toEqual([{ from: B, to: D }, { from: C, to: B }]);
    expect(state.sessionCommitShas).toEqual([D]);
    expect(finalRewriteOf(C, state.rewrittenCommits)).toBe(D);
    expect(state.commitTurns[0].sha).toBe(D);
  });
});
