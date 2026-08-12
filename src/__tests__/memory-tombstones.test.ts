// A wrong memory record has to be correctable.
//
// Per-commit records are immutable and the cross-machine merge UNIONS them.
// Those two properties together made a mistake permanent: 74d04c6 was recorded
// under `antigravity` when Cursor had made it, deleting it locally worked, and
// the very next sync folded the remote copy — which still had it — back in.
// Deleting again would have looped forever.
//
// Immutability exists so a record cannot be quietly REWRITTEN. It was never
// meant to stop a mistake being retracted. So removal is expressed as a fact
// that merges like any other (a tombstone) rather than as an absence, which
// merges as nothing.

import { describe, it, expect } from 'vitest';
import { mergeMemoryPayloads } from '../memory.js';

const commit = (sha: string, agent: string) => ({
  commitSha: sha,
  sessionId: `session-${sha}`,
  agentSlug: agent,
  message: `add ${sha}.py`,
  filesChanged: [`${sha}.py`],
  linesAdded: 10,
  linesRemoved: 0,
  branch: null,
  committedAt: '2026-08-09T17:00:00.000Z',
});

const session = (sha: string, agent: string) => ({
  sessionId: `session-${sha}`,
  agentSlug: agent,
  model: agent,
  startedAt: '2026-08-09T16:00:00.000Z',
  endedAt: '2026-08-09T18:00:00.000Z',
  branch: null,
  summary: `work on ${sha}`,
  filesChanged: [`${sha}.py`],
  promptCount: 1,
  linesAdded: 10,
  linesRemoved: 0,
  openTodos: [],
});

const tombstone = (sha: string) => ({
  commitSha: sha,
  reason: 'recorded under the wrong agent',
  at: '2026-08-10T12:00:00.000Z',
});

describe('memory merge with tombstones', () => {
  it('keeps a retraction when the other side still has the record', () => {
    // The exact production shape: local retracted it, the remote never heard.
    const local = { version: 2, sessions: [session('aaa', 'cursor')], commits: [], tombstones: [tombstone('aaa')] };
    const remote = { version: 2, sessions: [session('aaa', 'cursor')], commits: [commit('aaa', 'antigravity')], tombstones: [] };

    const merged = mergeMemoryPayloads(local, remote);

    expect(merged.commits.map((c) => c.commitSha)).not.toContain('aaa');
    expect(merged.tombstones?.map((t) => t.commitSha)).toContain('aaa');
  });

  it('honours a retraction that arrives FROM the remote', () => {
    // A teammate corrected it on their machine; this one must not undo that.
    const local = { version: 2, sessions: [session('bbb', 'cursor')], commits: [commit('bbb', 'antigravity')], tombstones: [] };
    const remote = { version: 2, sessions: [session('bbb', 'cursor')], commits: [], tombstones: [tombstone('bbb')] };

    const merged = mergeMemoryPayloads(local, remote);

    expect(merged.commits.map((c) => c.commitSha)).not.toContain('bbb');
  });

  it('is stable under repeated merges — the record never oscillates', () => {
    // The failure mode this replaces: delete, sync, it returns, delete again.
    const local = { version: 2, sessions: [session('ccc', 'cursor')], commits: [], tombstones: [tombstone('ccc')] };
    const remote = { version: 2, sessions: [session('ccc', 'cursor')], commits: [commit('ccc', 'antigravity')], tombstones: [] };

    let merged = mergeMemoryPayloads(local, remote);
    merged = mergeMemoryPayloads(merged, remote);
    merged = mergeMemoryPayloads(merged, remote);

    expect(merged.commits.map((c) => c.commitSha)).not.toContain('ccc');
    expect(merged.tombstones).toHaveLength(1);
  });

  it('retracts one commit without touching the others', () => {
    const local = {
      version: 2,
      sessions: [session('ddd', 'cursor'), session('eee', 'cursor')],
      commits: [commit('eee', 'cursor')],
      tombstones: [tombstone('ddd')],
    };
    const remote = {
      version: 2,
      sessions: [session('ddd', 'cursor'), session('eee', 'cursor')],
      commits: [commit('ddd', 'antigravity'), commit('eee', 'cursor')],
      tombstones: [],
    };

    const merged = mergeMemoryPayloads(local, remote);

    expect(merged.commits.map((c) => c.commitSha)).toEqual(['eee']);
  });

  it('merges payloads that predate tombstones entirely', () => {
    // v1/v2 notes written before this existed carry no tombstones field.
    const local = { version: 2, sessions: [session('fff', 'cursor')], commits: [commit('fff', 'cursor')] } as any;
    const remote = { version: 2, sessions: [session('fff', 'cursor')], commits: [commit('fff', 'cursor')] } as any;

    const merged = mergeMemoryPayloads(local, remote);

    expect(merged.commits.map((c) => c.commitSha)).toEqual(['fff']);
    expect(merged.tombstones).toEqual([]);
  });
});
