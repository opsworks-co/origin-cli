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
