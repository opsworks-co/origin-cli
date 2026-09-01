/**
 * A re-fired SessionStart must not destroy the conversation's turn history.
 *
 * Prod session 0c65017f ("AI blame data corruption"): the transcript holds 6
 * user prompts; the state file held ONE — the sixth — with `startedAt` stamped
 * at the moment SessionStart fired again, hours after the real start. Claude
 * Code fires that hook again on resume / compaction / re-attach, and the tag
 * is derived from the conversation id, so the second start computes the SAME
 * tag and overwrites the file in place.
 *
 * Nothing caught it: findDuplicateStateForSession only looks for a DIFFERENT
 * tag holding the same sessionId, and the dedup guard that would have returned
 * early is a scan gated on mtime freshness.
 *
 * The damage is not just a lost list. With `prompts` back to length 1, every
 * later capture stamps index 0 — so the newest turn's +399/-24 across 9 files
 * was filed under prompt 1 ("prompt 1 never did any change but I see it in ai
 * blame"), while prompts 2-5, including the one that did the work, recorded
 * nothing.
 */

import { describe, it, expect } from 'vitest';
import { carryForwardTurnState, findSameTagStateForResume, findDuplicateStateForSession } from '../session-dedup.js';
import { localTurnForServerRow, resumeBaseFromTranscript, resumeSeedApplies, serverRowForLocalTurn } from '../commands/hooks.js';

const CONV = '66621eba-50dc-4cf3-b3e0-ceccfe5161e8';
const TAG = '66621eba-50d';
const SESSION = '0c65017f-783b-43bc-a6b8-04f86a0185b4';

// The state as it stood after five turns.
const priorState = () => ({
  sessionId: SESSION,
  sessionTag: TAG,
  claudeSessionId: CONV,
  status: 'RUNNING',
  prompts: [
    'prompt 1 never did any change but I see it in ai blame per file',
    'how many lines did you add/remove in this prompt/session?',
    'why oriign captured diffrent amount of lines',
    'also how is this possible that we commited less lines',
    'yes, fix it',
  ],
  promptShadows: [{ promptIndex: 0, shadowSha: 'aaa', capturedAt: 'x' }],
  promptStartedAt: [1, 2, 3, 4, 5],
  completedPromptMappings: [{ promptIndex: 0 }, { promptIndex: 1 }],
  promptTurnIds: ['t_a', 't_b', 't_c', 't_d', 't_e'],
  promptResponses: ['r0', 'r1'],
  liveEdits: [{ promptIndex: 4 }],
  lastClosedTurnIndex: 3,
});

// What SessionStart builds when the conversation is resumed: same tag, same
// conversation, nothing accumulated.
const freshState = () => ({
  sessionId: SESSION,
  sessionTag: TAG,
  claudeSessionId: CONV,
  status: 'RUNNING',
  prompts: [] as string[],
});

describe('a re-fired SessionStart for a live conversation', () => {
  it('is invisible to the duplicate check, because the tag is the same', () => {
    // This is why it was never caught: same tag = same file = an overwrite.
    expect(findDuplicateStateForSession([priorState()], SESSION, TAG)).toBeNull();
  });

  it('IS found by the same-tag resume lookup', () => {
    const found = findSameTagStateForResume([priorState()], TAG, CONV);
    expect(found?.prompts).toHaveLength(5);
  });

  it('restores the full turn history onto the fresh state', () => {
    const state = freshState();
    const prior = findSameTagStateForResume([priorState()], TAG, CONV)!;
    carryForwardTurnState(state as any, prior);

    // The next turn is index 5 — not index 0 landing on prompt 1's row.
    expect((state as any).prompts).toHaveLength(5);
    expect((state as any).prompts[4]).toBe('yes, fix it');
    // …and the work recorded against those turns comes back too, which
    // carrying `prompts` alone would have left empty.
    expect((state as any).completedPromptMappings).toHaveLength(2);
    expect((state as any).promptTurnIds).toEqual(['t_a', 't_b', 't_c', 't_d', 't_e']);
    expect((state as any).promptResponses).toHaveLength(2);
    expect((state as any).liveEdits).toHaveLength(1);
    expect((state as any).lastClosedTurnIndex).toBe(3);
  });

  it('does not resurrect a conversation that genuinely ended', () => {
    const ended = { ...priorState(), status: 'ENDED' };
    expect(findSameTagStateForResume([ended], TAG, CONV)).toBeNull();
  });

  it('refuses to graft a DIFFERENT conversation that collided on the tag', () => {
    const other = { ...priorState(), claudeSessionId: 'someone-else' };
    expect(findSameTagStateForResume([other], TAG, CONV)).toBeNull();
  });

  it('never lets a shorter prior state shrink richer incoming state', () => {
    const state = { ...freshState(), prompts: ['a', 'b', 'c'], promptTurnIds: ['t1', 't2', 't3'] };
    const shortPrior = { ...priorState(), prompts: ['a'], promptTurnIds: ['t1'] };
    carryForwardTurnState(state as any, shortPrior);
    expect((state as any).prompts).toHaveLength(3);
    expect((state as any).promptTurnIds).toHaveLength(3);
  });
});

// LOCAL turn numbers are not SERVER row numbers once a conversation resumes.
//
// `state.prompts` holds only the turns THIS launch saw, so every local counter
// — `prompts.length - 1`, `activeTurn.index` — restarts at 0. Server rows are
// numbered by the turn's native transcript position. Stop bridges the two with
// `parsed.promptIndexBase + prompts.length - 1`; the retroactive captures in
// user-prompt-submit and session-start did not, and were writing raw local
// indices straight into completedPromptMappings, which is server-space.
//
// It looked correct for years because the base is 0 on every ordinary session.
//
// Session 2e58a848, 21:55:59, `source: "resume"`: no carry-forward line in
// hooks.log, so `prompts` went back to []. The retroactive capture then wrote
// local 0 while Stop wrote 3 — and its completedPromptMappings ended up holding
// the SAME prompt text at index 0 AND index 3. Row 0 belonged to turn one
// ("why no fucking commit diff is published…"), aborted nine seconds in with no
// files; promptText is first-write-wins server-side, so it kept its own text
// and silently acquired the resumed turn's files, diff and commit sha.
describe('local turn number → server row (serverRowForLocalTurn)', () => {
  it('is a no-op on an ordinary session, where the two spaces coincide', () => {
    expect(serverRowForLocalTurn(0, 0)).toBe(0);
    expect(serverRowForLocalTurn(4, 0)).toBe(4);
    // Absent on every session written before this field existed.
    expect(serverRowForLocalTurn(2, undefined)).toBe(2);
    expect(serverRowForLocalTurn(2, null)).toBe(2);
  });

  it('shifts a resumed conversation off the rows it already filled', () => {
    // 2e58a848: three turns already on the server, `prompts` restarted, so the
    // resumed turn is local 0. Without the base it overwrites turn one.
    expect(serverRowForLocalTurn(0, 3)).toBe(3);
    expect(serverRowForLocalTurn(1, 3)).toBe(4);
  });

  it('agrees with the Stop path, which is the authority', () => {
    // Stop: parsed.promptIndexBase + prompts.length - 1.
    const base = 3;
    const localPrompts = ["what's left here, short"];
    const stopIndex = base + localPrompts.length - 1;
    expect(serverRowForLocalTurn(localPrompts.length - 1, base)).toBe(stopIndex);
  });

  it('leaves a nonsensical local index alone rather than inventing a row', () => {
    expect(serverRowForLocalTurn(-1, 3)).toBe(-1);
    expect(serverRowForLocalTurn(NaN, 3)).toBeNaN();
  });
});

// The other direction: holding a transcript-native index and needing to read
// state that is stored LOCALLY. `promptShadows` is exactly that —
// recordPromptShadow is its only writer and keys on `prompts.length - 1` —
// while the Stop and SessionEnd capture paths look a turn's baseline up with
// `cap.promptIndex`, which capturePromptEdits returns transcript-native.
describe('server row → local turn number (localTurnForServerRow)', () => {
  it('round-trips with serverRowForLocalTurn', () => {
    for (const base of [0, 1, 3, 12]) {
      for (const local of [0, 1, 7]) {
        expect(localTurnForServerRow(serverRowForLocalTurn(local, base), base)).toBe(local);
      }
    }
  });

  it('is a no-op while the base is 0 — every ordinary session', () => {
    expect(localTurnForServerRow(0, 0)).toBe(0);
    expect(localTurnForServerRow(5, undefined)).toBe(5);
  });

  it('refuses a row that predates our prompt list rather than borrowing one', () => {
    // Adopted at base 3: rows 0-2 ran before we joined, so we never recorded a
    // start-state for them. Returning local 0 there would hand back a
    // DIFFERENT turn's shadow and silently rebase that turn's whole diff.
    expect(localTurnForServerRow(0, 3)).toBeNull();
    expect(localTurnForServerRow(2, 3)).toBeNull();
    expect(localTurnForServerRow(3, 3)).toBe(0);
    expect(localTurnForServerRow(4, 3)).toBe(1);
  });

  it('rejects nonsense instead of computing with it', () => {
    expect(localTurnForServerRow(-1, 3)).toBeNull();
    expect(localTurnForServerRow(NaN, 3)).toBeNull();
  });
});

describe('transcript base seed — the last line of defence when no prior state is found', () => {
  it('seeds the base so the resumed turn lands past the existing rows', () => {
    // Three real turns in the transcript before the resumed one. Claude Code's
    // injected <task-notification> entries are filtered upstream, so the count
    // is the same 3 that Stop derives as parsed.promptIndexBase.
    expect(resumeBaseFromTranscript('resume', [], 3)).toBe(3);
    expect(resumeBaseFromTranscript('compact', [], 6)).toBe(6);
  });

  it('leaves a fresh startup alone — 0 is correct there', () => {
    expect(resumeBaseFromTranscript('startup', [], 3)).toBeNull();
    expect(resumeBaseFromTranscript('', [], 3)).toBeNull();
    expect(resumeBaseFromTranscript(undefined, [], 3)).toBeNull();
  });

  it('never second-guesses history the state file DID carry forward', () => {
    // The common path: the guards above worked, carryForwardTurnState restored
    // prompts/turn ids/shadows together, and Stop will refresh the base itself.
    expect(resumeBaseFromTranscript('resume', ['a', 'b', 'c'], 3)).toBeNull();
    expect(resumeBaseFromTranscript('compact', ['a'], 6)).toBeNull();
  });

  it('stays out of the way when the transcript offers nothing', () => {
    expect(resumeBaseFromTranscript('resume', [], 0)).toBeNull();
    expect(resumeBaseFromTranscript('resume', undefined, 0)).toBeNull();
    expect(resumeBaseFromTranscript('resume', [], NaN)).toBeNull();
  });

  it('carries the base with the list — both or neither', () => {
    // The transcript seed only fires when carry-forward FAILED. In the path
    // where it SUCCEEDS, the base has to come along too: an already-adopted
    // session (Copilot's join gap makes it 1) that restores `prompts` while
    // dropping the base looks perfectly healthy and then files every
    // retroactive capture one whole base short — its newest turn lands on the
    // previous turn's row.
    const state: any = { prompts: [], promptIndexBase: undefined };
    const dup: any = { prompts: ['p1', 'p2', 'p3'], promptIndexBase: 1 };
    carryForwardTurnState(state, dup);
    expect(state.prompts).toHaveLength(3);
    expect(state.promptIndexBase).toBe(1);
    // local 2 (the turn that just finished) → server row 3, not row 2.
    expect(serverRowForLocalTurn(state.prompts.length - 1, state.promptIndexBase)).toBe(3);
  });

  it('never lets a carried base go backwards', () => {
    const state: any = { prompts: ['a'], promptIndexBase: 4 };
    carryForwardTurnState(state, { prompts: ['a'], promptIndexBase: 1 } as any);
    expect(state.promptIndexBase).toBe(4);
  });

  it('resumeSeedApplies gates the transcript PARSE, not just the result', () => {
    // Parsing is not free and the overwhelmingly common start already has its
    // history — cheap predicate first, parse only if it might be needed.
    expect(resumeSeedApplies('resume', [])).toBe(true);
    expect(resumeSeedApplies('resume', ['a'])).toBe(false);
    expect(resumeSeedApplies('startup', [])).toBe(false);
  });
});
