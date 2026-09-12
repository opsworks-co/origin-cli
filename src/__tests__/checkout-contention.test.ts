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
  detectContention, detectLiveContention, contentionAdvice, PEER_ACTIVE_WINDOW_MS, type PeerSession,
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
      { ...peer(), claudeSessionId: 'peer', transcriptPath: '', model: '', startedAt: '', prompts: [] },
    ] as any, NOW);
    expect(r.contested).toBe(true);
    expect(r.peers.map((p) => p.sessionId)).toEqual(['peer-1']);
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
