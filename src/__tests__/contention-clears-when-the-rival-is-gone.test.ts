// TODO 650f6aa6, option 3. A rival in the same working tree used to mark the
// session contended for its whole life: session 90eca883 shared its first
// minutes with the previous conversation in its worktree (f5556085, ENDED
// 16:31Z) and every Stop for seven hours still logged "ledger declined:
// another live session shares this working tree".
//
// Turns that ran WHILE a rival was live stay declined — their journal records
// cannot be told apart, which is what the permanent mark protected. A turn
// that BEGAN after every rival was seen gone is this session's alone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { contentionCoversTurn, noteContendersGone, readContentionTaint } from '../checkout-contention.js';
import { stateLedgerIsContended } from '../ledger-producer.js';
import { preferShadowRangeForTurns } from '../prefer-shadow-range.js';

const T0 = Date.parse('2026-09-23T16:31:25Z'); // the rival ended

describe('contentionCoversTurn', () => {
  const marks = (gone?: number): { contendingSessionIds: string[]; contenderGoneAt: Record<string, number> } =>
    ({ contendingSessionIds: ['f5556085'], contenderGoneAt: gone === undefined ? {} : { f5556085: gone } });

  it('a turn that began after the rival was seen gone is not covered', () => {
    expect(contentionCoversTurn(marks(T0), T0 + 60_000)).toBe(false);
  });
  it('a turn that began before it was seen gone stays covered', () => {
    expect(contentionCoversTurn(marks(T0), T0 - 60_000)).toBe(true);
  });
  it('a rival never seen gone covers every turn', () => {
    expect(contentionCoversTurn(marks(), T0 + 3_600_000)).toBe(true);
  });
  it('a turn with no known start is covered', () => {
    expect(contentionCoversTurn(marks(T0), undefined)).toBe(true);
  });
  it('no rivals, nothing covered', () => {
    expect(contentionCoversTurn({}, T0)).toBe(false);
  });
  it('a taint peer with no goneAt covers the turn', () => {
    expect(contentionCoversTurn(marks(T0), T0 + 60_000, ['other-peer'])).toBe(true);
  });
});

describe('noteContendersGone', () => {
  it('stamps a rival that is no longer live, once, at the time given', () => {
    const m: any = { contendingSessionIds: ['a', 'b'] };
    expect(noteContendersGone(m, new Set(['b']), 100)).toBe(true);
    expect(m.contenderGoneAt).toEqual({ a: 100 });
    expect(noteContendersGone(m, new Set(['b']), 200)).toBe(false);
    expect(m.contenderGoneAt.a).toBe(100);
  });
});

describe('readContentionTaint', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('peers JSON clears like a rival; any other content is permanent', () => {
    const p = path.join(dir, 'j.contended');
    fs.writeFileSync(p, JSON.stringify({ at: 1, peers: ['x'] }));
    expect(readContentionTaint(p)).toEqual({ permanent: false, peers: ['x'] });
    fs.writeFileSync(p, 'journal mutation timed out');
    expect(readContentionTaint(p)?.permanent).toBe(true);
    expect(readContentionTaint(path.join(dir, 'none'))).toBeNull();
  });
});

describe('stateLedgerIsContended — against a real repo', () => {
  let repo = '';
  let journal = '';
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contend-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    journal = path.join(repo, 'journal.jsonl');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  const self = (over: Record<string, unknown> = {}): any => ({
    sessionId: 'self-90eca883', sessionTag: 'self-90ec', writeJournalPath: journal,
    contendingSessionIds: ['f5556085'], contenderGoneAt: { f5556085: T0 }, currentTurnStartedAt: T0 + 60_000,
    ...over,
  });

  it('a turn begun after the rival was gone may use the ledger', () => {
    expect(stateLedgerIsContended(self(), repo)).toBe(false);
  });

  it('a turn begun while the rival was live is still declined', () => {
    expect(stateLedgerIsContended(self({ currentTurnStartedAt: T0 - 1000 }), repo)).toBe(true);
  });

  it('an incomplete journal declines every turn, rival gone or not', () => {
    fs.writeFileSync(`${journal}.contended`, 'journal mutation timed out');
    expect(stateLedgerIsContended(self(), repo)).toBe(true);
  });

  it('a live rival found now is declined AND recorded, so its going can clear later turns', () => {
    const gitDir = path.join(repo, '.git');
    fs.writeFileSync(path.join(gitDir, 'origin-session-peer-live.json'), JSON.stringify({
      sessionId: 'peer-live', sessionTag: 'peer-live', repoPath: repo, status: 'RUNNING',
      prompts: ['x'], activeTurn: { index: 0, turnId: 't', promptText: 'x', openedAt: new Date().toISOString() },
      currentTurnStartedAt: Date.now(),
    }));
    const s = self({ contendingSessionIds: [], contenderGoneAt: {}, currentTurnStartedAt: Date.now() });
    expect(stateLedgerIsContended(s, repo)).toBe(true);
    expect(s.contendingSessionIds).toContain('peer-live');
  });
});

describe('preferShadowRangeForTurns decides per turn', () => {
  it('declines the turn that overlapped the rival and no longer declines the one after', () => {
    const reasons = new Map<number, string>();
    const state: any = {
      prompts: ['a', 'b'], promptIndexBase: 0,
      promptSubmittedAt: [new Date(T0 - 60_000).toISOString(), new Date(T0 + 60_000).toISOString()],
      contendingSessionIds: ['f5556085'], contenderGoneAt: { f5556085: T0 },
      promptShadows: [], // no windows: the later turn declines for THAT reason, not contention
    };
    preferShadowRangeForTurns(state, [{ promptIndex: 0 }, { promptIndex: 1 }], '/nonexistent', {
      observe: (i: number, o: any) => { if (o.reason) reasons.set(i, o.reason); },
    });
    // With no shadows at all the pass declines everything up front — so give it one.
    state.promptShadows = [{ promptIndex: 0, shadowSha: 'a'.repeat(40) }, { promptIndex: 1, shadowSha: 'b'.repeat(40) }];
    reasons.clear();
    preferShadowRangeForTurns(state, [{ promptIndex: 0 }, { promptIndex: 1 }], '/nonexistent', {
      observe: (i: number, o: any) => { if (o.reason) reasons.set(i, o.reason); },
    });
    expect(reasons.get(0)).toBe('another live session shares this working tree');
    expect(reasons.get(1)).not.toBe('another live session shares this working tree');
  });
});

describe('the prompt hook stamps a rival gone as of the new turn', () => {
  it('noteCheckoutContention records goneAt = the turn start it just stamped', async () => {
    const { noteCheckoutContention } = await import('../commands/hooks/user-prompt-submit.js');
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contend-ups-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const start = Date.now();
      const state: any = { sessionId: 'self', repoPath: repo, contendingSessionIds: ['f5556085'], currentTurnStartedAt: start };
      noteCheckoutContention(state);
      expect(state.contenderGoneAt).toEqual({ f5556085: start });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Live 2026-10-14: session 9c1b8c40 sat RUNNING and idle in its worktree (last
// Stop 01:25:32Z, activeTurn null, never ended); 3cadaee2's first prompt in the
// same tree at 01:32:27Z recorded it as a rival, and since it never ended the
// mark covered every turn — the ledger and window declined, and three
// shell-written files reached no turn. Idle through the turn = not a rival.
describe('an idle peer is no rival for a turn it sat out', () => {
  const STOP = Date.parse('2026-10-14T01:25:32Z');
  const START = Date.parse('2026-10-14T01:32:27Z');
  const idlePeer = (over: Record<string, unknown> = {}) => ({
    sessionId: '9c1b8c40', status: 'RUNNING', prompts: ['merge it'], activeTurn: null,
    currentTurnStartedAt: STOP - 30_000, lastTurnClosedAt: STOP, lastStopAt: new Date(STOP).toISOString(),
    promptSubmittedAt: [new Date(STOP - 30_000).toISOString()],
    ...over,
  });

  it('peerIdleSinceMs: closed and nothing opened since', async () => {
    const { peerIdleSinceMs } = await import('../checkout-contention.js');
    expect(peerIdleSinceMs(idlePeer())).toBe(STOP);
    expect(peerIdleSinceMs(idlePeer({ activeTurn: { index: 1, openedAt: 'x' } }))).toBeUndefined();
    expect(peerIdleSinceMs(idlePeer({ currentTurnStartedAt: STOP + 1 }))).toBeUndefined();
    expect(peerIdleSinceMs(idlePeer({ promptSubmittedAt: [new Date(STOP + 5).toISOString()] }))).toBeUndefined();
    expect(peerIdleSinceMs(idlePeer({ lastTurnClosedAt: undefined, lastStopAt: undefined }))).toBeUndefined();
  });

  it('detectContention skips a peer idle through the turn, and only with a turn start', async () => {
    const { detectContention } = await import('../checkout-contention.js');
    const peer = { sessionId: '9c1b8c40', repoPath: '/wt', status: 'RUNNING', lastSeenMs: STOP + 38_000, idleSinceMs: STOP };
    const now = START + 1000;
    expect(detectContention({ sessionId: 'self' }, '/wt', [peer], now, START).contested).toBe(false);
    // Without a turn start nothing is provable: still a rival (the old answer).
    expect(detectContention({ sessionId: 'self' }, '/wt', [peer], now).contested).toBe(true);
    // GUARD: activity at or after the turn's start is a rival.
    expect(detectContention({ sessionId: 'self' }, '/wt', [{ ...peer, lastSeenMs: START + 500 }], now, START).contested).toBe(true);
    // GUARD: a turn still open is a rival however old its last stamp.
    expect(detectContention({ sessionId: 'self' }, '/wt', [{ ...peer, idleSinceMs: undefined }], now, START).contested).toBe(true);
  });

  describe('against a real repo', () => {
    let repo = '';
    beforeEach(() => {
      repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contend-idle-')));
      execFileSync('git', ['init', '-q'], { cwd: repo });
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));
    const writePeer = (state: Record<string, unknown>) => fs.writeFileSync(
      path.join(repo, '.git', 'origin-session-peer.json'),
      JSON.stringify({ sessionTag: 'peer', repoPath: repo, ...state }),
    );

    it('the prompt hook does not record an idle peer, and the ledger may claim the turn', async () => {
      const { noteCheckoutContention } = await import('../commands/hooks/user-prompt-submit.js');
      const now = Date.now();
      writePeer(idlePeer({ currentTurnStartedAt: now - 7 * 60_000, lastTurnClosedAt: now - 6 * 60_000, lastStopAt: undefined, promptSubmittedAt: [] }));
      const state: any = { sessionId: 'self', sessionTag: 'self', repoPath: repo, currentTurnStartedAt: now, writeJournalPath: path.join(repo, 'j.jsonl') };
      noteCheckoutContention(state);
      expect(state.contendingSessionIds || []).toEqual([]);
      expect(stateLedgerIsContended(state, repo)).toBe(false);
    });

    it('GUARD: a peer with a turn open is recorded, and the ledger declines', async () => {
      const { noteCheckoutContention } = await import('../commands/hooks/user-prompt-submit.js');
      const now = Date.now();
      writePeer(idlePeer({
        currentTurnStartedAt: now - 60_000, lastTurnClosedAt: now - 6 * 60_000, lastStopAt: undefined,
        activeTurn: { index: 1, turnId: 't', promptText: 'x', openedAt: new Date(now - 60_000).toISOString() },
      }));
      const state: any = { sessionId: 'self', sessionTag: 'self', repoPath: repo, currentTurnStartedAt: now, writeJournalPath: path.join(repo, 'j.jsonl') };
      noteCheckoutContention(state);
      expect(state.contendingSessionIds).toEqual(['9c1b8c40']);
      expect(stateLedgerIsContended(state, repo)).toBe(true);
    });

    it('GUARD: a peer that ran a whole turn inside ours is caught at capture time', () => {
      const start = Date.now() - 120_000;
      writePeer(idlePeer({ currentTurnStartedAt: start + 10_000, lastTurnClosedAt: start + 60_000, lastStopAt: undefined, promptSubmittedAt: [] }));
      const state: any = { sessionId: 'self', sessionTag: 'self', repoPath: repo, currentTurnStartedAt: start, writeJournalPath: path.join(repo, 'j.jsonl') };
      expect(stateLedgerIsContended(state, repo)).toBe(true);
      expect(state.contendingSessionIds).toContain('9c1b8c40');
    });

    it('a recorded rival idle when the next turn begins is stamped gone; back at work, it covers again', async () => {
      const { noteCheckoutContention } = await import('../commands/hooks/user-prompt-submit.js');
      const now = Date.now();
      writePeer(idlePeer({ currentTurnStartedAt: now - 7 * 60_000, lastTurnClosedAt: now - 6 * 60_000, lastStopAt: undefined, promptSubmittedAt: [] }));
      const state: any = { sessionId: 'self', repoPath: repo, contendingSessionIds: ['9c1b8c40'], currentTurnStartedAt: now };
      noteCheckoutContention(state);
      expect(state.contenderGoneAt).toEqual({ '9c1b8c40': now });
      expect(contentionCoversTurn(state, now)).toBe(false);

      const later = now + 1000;
      writePeer(idlePeer({
        currentTurnStartedAt: later - 500, lastTurnClosedAt: now - 6 * 60_000, lastStopAt: undefined, promptSubmittedAt: [],
        activeTurn: { index: 1, turnId: 't2', promptText: 'y', openedAt: new Date(later - 500).toISOString() },
      }));
      state.currentTurnStartedAt = later;
      noteCheckoutContention(state);
      expect(state.contenderGoneAt?.['9c1b8c40']).toBeUndefined();
      expect(contentionCoversTurn(state, later)).toBe(true);
    });
  });
});
