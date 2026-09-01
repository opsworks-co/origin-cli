/**
 * The watcher must not erase the hook path's turn identities.
 *
 * `saveSessionState` serializes the WHOLE object, so a field missing from a
 * writer's literal is not left alone — it is erased. The hook path's re-attach
 * literal carries `promptTurnIds` / `promptIndexBase` / `lastClosedTurnIndex` /
 * `commitTurns` for exactly that reason (#1341). The watcher's literal never
 * did, and it rewrites the same file every POLL_INTERVAL_MS (8s), so on any
 * agent where BOTH paths run (Cursor, Antigravity) the identities lasted only
 * until the next poll.
 *
 * Prod session b46ec40f (Cursor, kotleta): the first Stop hook sent
 * `t:"t_ebe0674b"`; the watcher polled 4 seconds later; all 15 payloads after
 * it sent `t:null`. With no turnId every writer keys rows by POSITION, and
 * position is not stable — Cursor injected a follow-up prompt mid-session and
 * the watcher's own log shows the commit moving between indices twenty seconds
 * apart:
 *
 *   18:37:54  turns ["0:none","1:858f3e05","2:none"]
 *   18:38:14  turns ["0:none","1:none","2:858f3e05","3:none"]
 *
 * Rows written before the shift kept their old index, so one turn's diff landed
 * on another turn's row. The session page ended up showing +534/-0 and
 * +134/-34 — numbers no writer ever sent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { reconcileSession, loadSessionState, saveSessionState, assignTurnIds, hookMintedTurns, type WatchDeps, type SessionWatchState } from '../transcript-watch.js';
import { type TranscriptAdapter, type ScannedTranscript, type ParsedSession } from '../transcript-adapters.js';
import { promptKey } from '../session-state.js';

describe('the watcher carries turn identity through its state rewrite', () => {
  let tmp = '';
  let stateDir = '';
  let repo = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'turnid-'));
    stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function adapter(): TranscriptAdapter {
    const parsed: ParsedSession = {
      userPrompts: ['first', 'second'], promptTimestamps: [1000, 2000], transcript: 't', model: 'm',
      tokensUsed: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      filePaths: [], filesChanged: [], promptDiffs: [],
    };
    return { slug: 'cursor', agentSlugForServer: 'cursor', listActive: () => [], parse: () => parsed };
  }

  function deps(over: Partial<WatchDeps> = {}): WatchDeps {
    return {
      now: () => Date.now(), idleMs: 20 * 60_000, machineId: 'm', hostname: 'h', stateDir,
      api: {
        startSession: vi.fn(async () => ({ sessionId: 'srv-1' })),
        updateSession: vi.fn(async () => ({})),
      } as any,
      resolveRepo: () => ({ repoPath: repo, workRoot: repo, branch: 'main' }) as any,
      createShadow: () => null,
      getHead: () => 'a'.repeat(40),
      captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
      captureGit: () => ({ headBefore: '', headAfter: '', commitShas: [], commitDetails: [], diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0 }),
      loadState: (a: string, s: string) => loadSessionState(a, s, stateDir),
      saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
      ...over,
    };
  }

  const scanned = (): ScannedTranscript =>
    ({ sessionId: 'agent-conv-1', transcriptPath: path.join(tmp, 't.jsonl'), cwd: repo, mtimeMs: Date.now() });

  it('carries promptTurnIds and the row arithmetic that depends on them', async () => {
    // What the hook path minted, sitting in the file the watcher is about to
    // rewrite.
    const prior = {
      promptTurnIds: ['t_ebe0674b', 't_9f1c2d30'],
      promptIndexBase: 6,
      lastClosedTurnIndex: 1,
      commitTurns: [{ sha: '858f3e05', turnId: 't_9f1c2d30', via: 'post-commit' }],
      activeTurn: { turnId: 't_stale', promptIndex: 1 },
    };
    const saveGitState = vi.fn();

    await reconcileSession(scanned(), adapter(), deps({
      loadGitState: () => prior,
      saveGitState,
    }));

    expect(saveGitState).toHaveBeenCalled();
    const written = saveGitState.mock.calls[0][0] as Record<string, unknown>;
    expect(written.promptTurnIds).toEqual(['t_ebe0674b', 't_9f1c2d30']);
    expect(written.promptIndexBase).toBe(6);
    expect(written.lastClosedTurnIndex).toBe(1);
    expect(written.commitTurns).toEqual(prior.commitTurns);
    // The watcher still owns what it actually knows.
    expect(written.sessionId).toBe('srv-1');
    expect(written.claudeSessionId).toBe('agent-conv-1');
  });

  it('never writes null over the hook path\'s prePromptSha', async () => {
    // handleAfterFileEdit bails on a state with no prePromptSha
    // ("ABORT: missing repoPath or prePromptSha" — 34 times in the prod
    // session). Nulling it every poll is what silently disabled Cursor's edit
    // capture, which is why a whole-file rewrite came out as +604/-0.
    const saveGitState = vi.fn();
    await reconcileSession(scanned(), adapter(), deps({
      loadGitState: () => ({ prePromptSha: 'abc1234', headShaAtLastStop: 'def5678' }),
      saveGitState,
    }));
    const written = saveGitState.mock.calls[0][0] as Record<string, unknown>;
    expect(written.prePromptSha).toBe('abc1234');
    expect(written.headShaAtLastStop).toBe('def5678');
  });

  it('still writes null for those when there is nothing prior to keep', async () => {
    const saveGitState = vi.fn();
    await reconcileSession(scanned(), adapter(), deps({ loadGitState: () => null, saveGitState }));
    const written = saveGitState.mock.calls[0][0] as Record<string, unknown>;
    expect(written.prePromptSha).toBeNull();
    expect(written.headShaAtLastStop).toBeNull();
  });

  it('carries fields the watcher has never heard of', async () => {
    // The hand-picked list is what failed: #1341 named four fields for the hook
    // path's literal and this one was never updated. Anything a future hook
    // starts writing must survive without someone remembering to add it here.
    const saveGitState = vi.fn();
    await reconcileSession(scanned(), adapter(), deps({
      loadGitState: () => ({ completedPromptMappings: [{ promptIndex: 0 }], liveEdits: [{ x: 1 }], someFutureField: 'keep me' }),
      saveGitState,
    }));
    const written = saveGitState.mock.calls[0][0] as Record<string, unknown>;
    expect(written.completedPromptMappings).toEqual([{ promptIndex: 0 }]);
    expect(written.liveEdits).toEqual([{ x: 1 }]);
    expect(written.someFutureField).toBe('keep me');
  });

  it('the watcher still wins on the fields it actually observes', async () => {
    // Carrying must not let a stale prior value shadow what this poll measured.
    const saveGitState = vi.fn();
    await reconcileSession(scanned(), adapter(), deps({
      loadGitState: () => ({ sessionId: 'stale-id', prompts: ['old'], status: 'ENDED', repoPath: '/gone' }),
      saveGitState,
    }));
    const written = saveGitState.mock.calls[0][0] as Record<string, unknown>;
    expect(written.sessionId).toBe('srv-1');
    expect(written.prompts).toEqual(['first', 'second']);
    expect(written.status).toBe('RUNNING');
    expect(written.repoPath).toBe(repo);
  });

  it('does NOT carry activeTurn — a turn left open must not survive', async () => {
    // Same rule the hook path's re-attach applies: a stale open turn attests
    // the next commit to a turn that ended long ago (#1334).
    const saveGitState = vi.fn();
    await reconcileSession(scanned(), adapter(), deps({
      loadGitState: () => ({ promptTurnIds: ['t_a'], activeTurn: { turnId: 't_stale', promptIndex: 0 } }),
      saveGitState,
    }));
    const written = saveGitState.mock.calls[0][0] as Record<string, unknown>;
    expect(written.promptTurnIds).toEqual(['t_a']);
    expect(written.activeTurn).toBeUndefined();
  });

  it('writes cleanly when there is no prior file, and survives a read that throws', async () => {
    for (const loadGitState of [
      (() => null) as any,
      (() => { throw new Error('unreadable'); }) as any,
      undefined,
    ]) {
      const saveGitState = vi.fn();
      await reconcileSession(scanned(), adapter(), deps({ loadGitState, saveGitState }));
      expect(saveGitState).toHaveBeenCalled();
      const written = saveGitState.mock.calls[0][0] as Record<string, unknown>;
      expect(written.promptTurnIds).toBeUndefined();
      expect(written.sessionId).toBe('srv-1');
    }
  });

  it('a second poll does not drop what the first one carried', async () => {
    // The regression was not a single bad write — it was every poll, forever.
    // Simulate the real file by feeding each save back into the next load.
    let file: Record<string, unknown> | null = { promptTurnIds: ['t_ebe0674b'], promptIndexBase: 6 };
    const saveGitState = vi.fn((s: Record<string, unknown>) => { file = s; });

    for (let poll = 0; poll < 3; poll++) {
      await reconcileSession(scanned(), adapter(), deps({ loadGitState: () => file, saveGitState }));
    }

    expect(saveGitState).toHaveBeenCalledTimes(3);
    for (const call of saveGitState.mock.calls) {
      expect((call[0] as Record<string, unknown>).promptTurnIds).toEqual(['t_ebe0674b']);
      expect((call[0] as Record<string, unknown>).promptIndexBase).toBe(6);
    }
  });
});

/**
 * One turn must not exist under two identities.
 *
 * The hook path mints `t_…` and the watcher minted `w_…` independently, so on a
 * dual-path agent (Cursor, Antigravity) the server saw two different rows for
 * the same turn and the last writer won the slot. Prod b46ec40f stores the
 * alternation, by whichever writer got there last:
 *
 *   row 0  t_ebe0674b658b4cae   +0/-0
 *   row 1  w_8p1nmx3rmtg543d1   +534/-0    <- the watcher's row won
 *   row 2  t_97aa68bef20047d2   +134/-34
 *   row 3  w_yqny8h47mtg5k119   +0/-0
 *
 * The hook path had sent +604/-0 for row 1. Nothing merged those numbers — the
 * watcher's poll-derived row simply overwrote the hook's a few seconds later,
 * which is why a turn read correctly and then changed.
 */
describe('hookMintedTurns', () => {
  it('re-keys the hook path\'s ids by prompt text, not by position', () => {
    const out = hookMintedTurns({
      prompts: ['check whats inrepo', "let's build some shit now"],
      promptTurnIds: ['t_aaa', 't_bbb'],
    });
    expect(out).toEqual([
      { turnId: 't_aaa', promptKey: expect.any(String) },
      { turnId: 't_bbb', promptKey: expect.any(String) },
    ]);
    // The keys are the hook path's own normalizer, so they match what
    // assignTurnIds computes for the same text.
    expect(out[0].promptKey).not.toBe(out[1].promptKey);
  });

  it('adopts across a prompt list that grew in the middle', () => {
    // Cursor injected "Briefly inform the user…" into THIS session mid-flight,
    // which is what shifted every index. Identity must follow the text.
    const hook = hookMintedTurns({
      prompts: ['first', 'second'],
      promptTurnIds: ['t_first', 't_second'],
    });
    const assigned = assignTurnIds(hook, ['first', 'injected follow-up', 'second']);
    expect(assigned[0].turnId).toBe('t_first');
    expect(assigned[1].turnId).toMatch(/^w_/);   // genuinely new turn
    expect(assigned[2].turnId).toBe('t_second'); // NOT paired to the injected one
  });

  it('returns nothing when the state carries no hook identities', () => {
    expect(hookMintedTurns(null)).toEqual([]);
    expect(hookMintedTurns({})).toEqual([]);
    expect(hookMintedTurns({ prompts: ['a'] })).toEqual([]);
    expect(hookMintedTurns({ promptTurnIds: ['t_a'] })).toEqual([]);
    // Ragged arrays stop at the shorter one rather than pairing off the end.
    expect(hookMintedTurns({ prompts: ['a'], promptTurnIds: ['t_a', 't_b'] })).toHaveLength(1);
  });

  it('the watcher\'s own published id wins over the hook\'s for the same prompt', () => {
    // An id the watcher already published owns a row on the server. Switching
    // it would strand that row, so adoption only names prompts it has not.
    const prior = [{ turnId: 'w_already', promptKey: promptKey('first') }];
    const hook = hookMintedTurns({ prompts: ['first', 'second'], promptTurnIds: ['t_first', 't_second'] });
    const assigned = assignTurnIds([...prior, ...hook], ['first', 'second']);
    expect(assigned[0].turnId).toBe('w_already');
    expect(assigned[1].turnId).toBe('t_second');
  });
});
