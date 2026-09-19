// The one ambiguity that cannot be narrowed: two agents writing into ONE
// checkout. Tool hooks cover the agent that has them; the journal records THAT
// a file changed but never WHICH process changed it, and no filesystem API on
// macOS or Windows reports the writing process without elevated privileges.
//
// So the goal here is not a better guess. It is to notice, say so, and stop
// rendering contested attribution with the confidence of uncontested
// attribution.
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import {
  detectContention, detectLiveContention, contentionAdvice, neverRanATurn, peerLastActivityMs, PEER_ACTIVE_WINDOW_MS, type PeerSession,
} from '../checkout-contention.js';

const SELF = { sessionId: 'self-1' };
const TREE = path.join(os.tmpdir(), 'repo');
const NOW = 1_000_000;

const peer = (over: Partial<PeerSession> = {}): PeerSession => ({
  sessionId: 'peer-1', agentSlug: 'claude-code', repoPath: TREE, lastSeenMs: NOW, ...over,
});

describe('detectContention', () => {
  it('flags a live peer in the same tree', () => {
    const r = detectContention(SELF, TREE, [peer()], NOW);
    expect(r.contested).toBe(true);
    expect(r.peers.map((p) => p.sessionId)).toEqual(['peer-1']);
  });

  it('never counts the session itself', () => {
    const r = detectContention(SELF, TREE, [peer({ sessionId: 'self-1' })], NOW);
    expect(r.contested).toBe(false);
  });

  it('ignores an ENDED session', () => {
    // It is not writing anything now.
    expect(detectContention(SELF, TREE, [peer({ status: 'ENDED' })], NOW).contested).toBe(false);
  });

  it('ignores a peer that has gone quiet', () => {
    const stale = peer({ lastSeenMs: NOW - PEER_ACTIVE_WINDOW_MS - 1 });
    expect(detectContention(SELF, TREE, [stale], NOW).contested).toBe(false);
  });

  it('does NOT flag a peer working in its own worktree', () => {
    // This is the whole recommendation: separate trees are not contention.
    const isolated = peer({ repoPath: path.join(os.tmpdir(), 'wt-a'), lastCwd: path.join(os.tmpdir(), 'wt-a') });
    expect(detectContention(SELF, TREE, [isolated], NOW).contested).toBe(false);
  });

  it('prefers the peer\'s lastCwd over its repo identity', () => {
    // repoPath is the repo's IDENTITY; a session that moved into a worktree
    // still reports the canonical repo there, so lastCwd is what says where it
    // is actually writing.
    const moved = peer({ repoPath: TREE, lastCwd: path.join(os.tmpdir(), 'wt-b') });
    expect(detectContention(SELF, TREE, [moved], NOW).contested).toBe(false);
  });

  it('matches trees that differ only in form', () => {
    // Separator style and trailing separators must not create phantom peers,
    // nor hide real ones.
    const oddly = peer({ repoPath: TREE + path.sep });
    expect(detectContention(SELF, TREE, [oddly], NOW).contested).toBe(true);
  });

  it('reports every contending peer, deduped by session', () => {
    const r = detectContention(SELF, TREE, [
      peer({ sessionId: 'a', agentSlug: 'codex' }),
      peer({ sessionId: 'b', agentSlug: 'cursor' }),
    ], NOW);
    expect(r.peers.map((p) => p.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('is quiet when alone, and survives junk input', () => {
    expect(detectContention(SELF, TREE, [], NOW).contested).toBe(false);
    expect(detectContention(SELF, '', [peer()], NOW).contested).toBe(false);
    expect(detectContention(SELF, TREE, [{ sessionId: '' } as PeerSession], NOW).contested).toBe(false);
  });
});

describe('detectLiveContention', () => {
  it('uses the active state store view at capture time', () => {
    const r = detectLiveContention(SELF, TREE, [
      { ...SELF, repoPath: TREE, claudeSessionId: 'self', transcriptPath: '', model: '', startedAt: '', prompts: [] },
      { ...peer(), claudeSessionId: 'peer', transcriptPath: '', model: '', startedAt: '', prompts: ['fix the bug'] },
    ] as any, NOW);
    expect(r.contested).toBe(true);
    expect(r.peers.map((p) => p.sessionId)).toEqual(['peer-1']);
  });

  it('a conversation the desktop app only RESUMED in this worktree is not a rival', () => {
    // ad95e766 / 274a6cd2: `session-start {source: resume}` re-registered the
    // worktree's previous conversation 2.5 minutes before the new session's
    // first prompt. Fresh state file, not ENDED, same tree — and no turn, ever.
    const resumedOnly = {
      ...peer(), claudeSessionId: 'peer', transcriptPath: '', model: '', startedAt: '',
      prompts: [], promptIndexBase: 1, status: 'RUNNING',
    };
    expect(detectLiveContention(SELF, TREE, [resumedOnly] as any, NOW).contested).toBe(false);
  });
});

describe('peerLastActivityMs', () => {
  const T = Date.parse('2026-09-18T14:06:00Z');
  const LATER = T + 2 * 60 * 60 * 1000;

  it('reads the peer\'s own turn times, not a state file someone else re-saved', () => {
    // 274a6cd2: last own activity 14:06Z; its neighbour's post-commit stamped a
    // new `branch` on it at 16:03Z, which is all the mtime knows.
    const state = { prompts: ['go'], lastStopAt: new Date(T).toISOString(), promptSubmittedAt: [new Date(T - 60_000).toISOString()] };
    expect(peerLastActivityMs(state, LATER)).toBe(T);
  });

  it('takes the newest of everything the session\'s hooks recorded', () => {
    expect(peerLastActivityMs({
      currentTurnStartedAt: T - 5000,
      activeTurn: { index: 2, openedAt: new Date(T - 4000).toISOString() },
      liveEdits: [{ capturedAt: new Date(T - 3000).toISOString() }, { capturedAt: new Date(T).toISOString() }],
      subagents: [{ startedAt: new Date(T - 2000).toISOString() }],
      writeTrees: [{ path: '/x', at: new Date(T - 1000).toISOString() }],
    }, LATER)).toBe(T);
  });

  it('keeps the mtime for a state that records no turn times', () => {
    expect(peerLastActivityMs({ prompts: ['go'], startedAt: new Date(T).toISOString() }, LATER)).toBe(LATER);
    expect(peerLastActivityMs({}, undefined)).toBeUndefined();
  });

  it('is never later than the file\'s own last write, and ignores junk', () => {
    expect(peerLastActivityMs({ lastStopAt: new Date(LATER).toISOString() }, T)).toBe(T);
    expect(peerLastActivityMs({ lastStopAt: 'soon', lastTurnClosedAt: -1, liveEdits: [null, 7, {}] }, T)).toBe(7);
  });

  it('a session that went quiet two hours ago is not a rival, however fresh its file', () => {
    const quiet = {
      ...peer(), claudeSessionId: 'peer', transcriptPath: '', model: '', startedAt: '',
      prompts: ['fix the bug'], lastStopAt: new Date(LATER - 2 * 60 * 60 * 1000).toISOString(),
    };
    // No __statePath here, so the mtime is unknown; the recorded Stop decides.
    // (A real clock: the suite's NOW is 1e6 ms, and two hours before that is
    // not a time anything could have recorded.)
    expect(detectLiveContention(SELF, TREE, [quiet] as any, LATER).contested).toBe(false);
    const busy = { ...quiet, lastStopAt: new Date(LATER - 60_000).toISOString() };
    expect(detectLiveContention(SELF, TREE, [busy] as any, LATER).contested).toBe(true);
  });
});

describe('neverRanATurn', () => {
  it('is the resumed-and-untouched shape only', () => {
    expect(neverRanATurn({ prompts: [] })).toBe(true);
    expect(neverRanATurn({ prompts: [], liveEdits: [], completedPromptMappings: [], writeTrees: [], activeTurn: null })).toBe(true);
  });

  it.each([
    ['it took a prompt', { prompts: ['go'] }],
    ['a turn is open', { prompts: [], activeTurn: { index: 0 } }],
    ['it recorded an edit', { prompts: [], liveEdits: [{ promptIndex: 0 }] }],
    ['it captured a row', { prompts: [], completedPromptMappings: [{ promptIndex: 0 }] }],
    ['it wrote in a tree', { prompts: [], writeTrees: [{ path: '/x' }] }],
    ['its state has no prompts array to read — unknown still counts', {}],
  ])('a peer still counts when %s', (_why, state) => {
    expect(neverRanATurn(state)).toBe(false);
    expect(detectContention(SELF, TREE, [peer({ neverRanATurn: neverRanATurn(state) })], NOW).contested).toBe(true);
  });
});

describe('contentionAdvice', () => {
  it('says nothing when there is nothing to say', () => {
    expect(contentionAdvice({ contested: false, peers: [] })).toBeNull();
  });

  it('names the agents and points at the actual fix', () => {
    const msg = contentionAdvice(detectContention(SELF, TREE, [
      peer({ sessionId: 'a', agentSlug: 'codex' }),
      peer({ sessionId: 'b', agentSlug: 'codex' }),
    ], NOW));
    expect(msg).toContain('2 other sessions');
    expect(msg).toContain('codex');
    // Named once, not repeated per peer.
    expect(msg!.match(/codex/g)!.length).toBe(1);
    expect(msg).toContain('worktree');
  });
});
