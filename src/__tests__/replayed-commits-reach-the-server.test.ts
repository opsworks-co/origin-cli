// post-commit's replay verdict has to be RECORDED, not just acted on.
//
// `commitReplayKind` reads the reflog of the worktree that replayed. post-commit
// runs there, at the moment, and knows. Nothing downstream can re-derive it: a
// deploy that cherry-picks into a throwaway worktree takes that reflog with it
// when the worktree is removed, and Stop runs in a different tree entirely.
//
// Prod f5556085 turn 28 (2026-09-22): six cherry-picks into a deploy worktree.
// post-commit logged "SKIP recording: the commit is a replay, not this turn's
// work" and credited nobody — then the sha rode along in Stop's commitDetails
// anyway, and the server's back-attribution placed it on the running turn.
import { describe, it, expect } from 'vitest';
import { keepCommitRecordsSavedMeanwhile } from '../session-state.js';
import { replayedCommitsPayload } from '../commands/hooks/stop.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('replayedCommits survives a concurrent save', () => {
  // The merge exists because two hooks write the same state file: a Claude
  // PostToolUse can read it, then a post-commit writes, then the first writes
  // back — losing whatever post-commit recorded in between.
  it('takes a verdict the other writer recorded', () => {
    const state: any = { sessionId: 's1', replayedCommits: [A] };
    keepCommitRecordsSavedMeanwhile(state, { sessionId: 's1', replayedCommits: [B] } as any);
    expect(state.replayedCommits).toEqual([A, B]);
  });

  it('merges it even when nothing else changed — a replay records no sha, by design', () => {
    // post-commit does NOT add to sessionCommitShas for a replay (that is the
    // point), so this save carries the verdict alone. An early return on "no
    // shas, no pairs, no turns" would drop exactly the case this is for.
    const state: any = { sessionId: 's1', sessionCommitShas: [], replayedCommits: [] };
    keepCommitRecordsSavedMeanwhile(state, {
      sessionId: 's1', sessionCommitShas: [], replayedCommits: [B],
    } as any);
    expect(state.replayedCommits).toEqual([B]);
  });

  it('does not duplicate one both writers saw', () => {
    const state: any = { sessionId: 's1', replayedCommits: [A] };
    keepCommitRecordsSavedMeanwhile(state, { sessionId: 's1', replayedCommits: [A] } as any);
    expect(state.replayedCommits).toEqual([A]);
  });

  it('ignores a state file belonging to another session', () => {
    const state: any = { sessionId: 's1', replayedCommits: [A] };
    keepCommitRecordsSavedMeanwhile(state, { sessionId: 'other', replayedCommits: [B] } as any);
    expect(state.replayedCommits).toEqual([A]);
  });
});

describe('replayedCommitsPayload — the verdict actually travels', () => {
  // The defect was a correct verdict that never left the machine, so the wire
  // link is the thing worth pinning, not the verdict.
  it('carries what post-commit recorded', () => {
    expect(replayedCommitsPayload({ replayedCommits: [A, B] })).toEqual({ replayedCommits: [A, B] });
  });

  it('sends no key when nothing was replayed', () => {
    // An absent list and an empty one mean the same to the server; omitting it
    // keeps payloads from ordinary sessions unchanged.
    expect(replayedCommitsPayload({ replayedCommits: [] })).toEqual({});
    expect(replayedCommitsPayload({})).toEqual({});
  });

  it('copies rather than aliasing the state array', () => {
    const state = { replayedCommits: [A] };
    const out = replayedCommitsPayload(state);
    out.replayedCommits!.push(B);
    expect(state.replayedCommits, 'the payload mutated session state').toEqual([A]);
  });
});
