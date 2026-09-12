// session-start's final save used to overwrite whatever a concurrent hook had
// done with its reservation while `session/start` was in flight. These pin the
// pure halves of the merge that replaced the overwrite: what counts as "the
// row was adopted", and what survives from each side.
import { describe, it, expect } from 'vitest';
import { mergeAdoptedReservation, reservationAdoptedMeanwhile, type ReservationRow } from '../reservation-adoption.js';

const MAIN = '/Users/dev/repo';
const WT = '/Users/dev/.cursor/worktrees/repo/05c3';

/** What session-start assembles after `session/start` returns. */
function ours(over: Partial<ReservationRow> & Record<string, unknown> = {}): ReservationRow & Record<string, unknown> {
  return {
    sessionId: 'srv-registered',
    sessionTag: 'f9213cfd-349',
    claudeSessionId: '',
    agentSessionId: 'composer-id',
    repoPath: MAIN,
    canonicalRepoPath: MAIN,
    lastCwd: MAIN,
    branch: 'main',
    prompts: [],
    headShaAtStart: 'main-head',
    sessionStartShadowSha: 'main-shadow',
    sessionStartDirtyFiles: ['CLAUDE.md'],
    prePromptSha: 'main-shadow',
    prePromptDirtyFiles: [],
    enforcementRules: [{ id: 'r1' }],
    activePolicies: ['p1'],
    agentSystemPrompt: 'be good',
    ...over,
  };
}

/** The reservation as the worktree's first prompt left it. */
function adopted(over: Partial<ReservationRow> & Record<string, unknown> = {}): ReservationRow & Record<string, unknown> {
  return {
    sessionId: 'local-reserved',
    sessionTag: 'f9213cfd-349',
    claudeSessionId: '',
    agentSessionId: 'real-conversation-id',
    repoPath: WT,
    canonicalRepoPath: MAIN,
    lastCwd: WT,
    branch: 'cursor/f9213cfd',
    prompts: ['pull latest changes'],
    promptTurnIds: ['t_1'],
    transcriptPath: '/transcripts/real-conversation-id.jsonl',
    prePromptSha: 'wt-shadow',
    prePromptDirtyFiles: ['a.ts'],
    status: 'RUNNING',
    pendingRegistration: true,
    ...over,
  };
}

describe('reservationAdoptedMeanwhile', () => {
  it('is false when nothing is on disk, or the file is another conversation, or it ended', () => {
    expect(reservationAdoptedMeanwhile(ours(), null)).toBe(false);
    expect(reservationAdoptedMeanwhile(ours(), adopted({ sessionTag: 'other-tag-000' }))).toBe(false);
    expect(reservationAdoptedMeanwhile(ours(), adopted({ status: 'ENDED' }))).toBe(false);
  });

  it('is false for an untouched reservation', () => {
    // Same identity, same tree, no prompt: the file is just our own placeholder.
    expect(reservationAdoptedMeanwhile(ours(), adopted({
      agentSessionId: 'composer-id', repoPath: MAIN, lastCwd: MAIN, branch: 'main', prompts: [], promptTurnIds: [],
    }))).toBe(false);
  });

  it('is true when a prompt was filed', () => {
    expect(reservationAdoptedMeanwhile(ours(), adopted({ agentSessionId: 'composer-id', repoPath: MAIN }))).toBe(true);
  });

  it('is true when the conversation id changed (Cursor: composer id → real chat id)', () => {
    expect(reservationAdoptedMeanwhile(ours(), adopted({ prompts: [], repoPath: MAIN }))).toBe(true);
  });

  it('is true when the row was moved onto another work tree', () => {
    expect(reservationAdoptedMeanwhile(ours(), adopted({ prompts: [], agentSessionId: 'composer-id' }))).toBe(true);
  });
});

describe('mergeAdoptedReservation', () => {
  it('keeps the registered id and what only registration produces; takes the adopter\'s turn and identity', () => {
    const row = ours();
    const r = mergeAdoptedReservation(row, adopted());
    expect(r.movedTree).toBe(true);
    // Ours: the id the server handed back and the registration payload.
    expect(row.sessionId).toBe('srv-registered');
    expect(row.enforcementRules).toEqual([{ id: 'r1' }]);
    expect(row.activePolicies).toEqual(['p1']);
    expect(row.agentSystemPrompt).toBe('be good');
    // Theirs: the chat the row actually is now.
    expect(row.prompts).toEqual(['pull latest changes']);
    expect(row.promptTurnIds).toEqual(['t_1']);
    expect(row.agentSessionId).toBe('real-conversation-id');
    expect(row.repoPath).toBe(WT);
    expect(row.lastCwd).toBe(WT);
    expect(row.branch).toBe('cursor/f9213cfd');
    expect(row.transcriptPath).toBe('/transcripts/real-conversation-id.jsonl');
    // The adopter's copy still carries the placeholder flag; clearing it is
    // the caller's decision (session-start deletes it right before saving).
    expect(row.pendingRegistration).toBe(true);
  });

  it('a moved row never keeps main\'s baseline (e1095412: the branch\'s whole lead credited to the session)', () => {
    const row = ours();
    const r = mergeAdoptedReservation(row, adopted());
    expect(r.needsBaseline).toBe(true);
    expect(row.headShaAtStart).toBeNull();
    expect(row.sessionStartShadowSha).toBeNull();
    expect(row.sessionStartDirtyFiles).toEqual([]);
    // The adopter's per-prompt anchor on the new tree is real; keep it.
    expect(row.prePromptSha).toBe('wt-shadow');
    expect(row.prePromptDirtyFiles).toEqual(['a.ts']);
  });

  it('a moved row keeps the baseline the adopter captured on the new tree', () => {
    const row = ours();
    const r = mergeAdoptedReservation(row, adopted({
      headShaAtStart: 'wt-head', sessionStartShadowSha: 'wt-start-shadow', sessionStartDirtyFiles: ['b.ts'],
    }));
    expect(r.needsBaseline).toBe(false);
    expect(row.headShaAtStart).toBe('wt-head');
    expect(row.sessionStartShadowSha).toBe('wt-start-shadow');
    expect(row.sessionStartDirtyFiles).toEqual(['b.ts']);
  });

  it('on the same tree session-start\'s baseline is the real one; the adopter\'s per-prompt anchor still wins', () => {
    const row = ours();
    const r = mergeAdoptedReservation(row, adopted({ repoPath: MAIN, lastCwd: MAIN, branch: 'main' }));
    expect(r).toEqual({ movedTree: false, needsBaseline: false });
    expect(row.headShaAtStart).toBe('main-head');
    expect(row.sessionStartShadowSha).toBe('main-shadow');
    expect(row.sessionStartDirtyFiles).toEqual(['CLAUDE.md']);
    expect(row.prePromptSha).toBe('wt-shadow');
    expect(row.prompts).toEqual(['pull latest changes']);
  });

  it('on the same tree an adopter that set no per-prompt anchor gets session-start\'s', () => {
    const row = ours();
    mergeAdoptedReservation(row, adopted({ repoPath: MAIN, lastCwd: MAIN, prePromptSha: undefined, prePromptDirtyFiles: undefined }));
    expect(row.prePromptSha).toBe('main-shadow');
    expect(row.prePromptDirtyFiles).toEqual([]);
  });
});
