/**
 * Tests for mergeMemoryPayloads — the payload-level union that makes
 * refs/notes/origin-memory safe to share between machines.
 *
 * Why this can't be `git notes merge`: unlike refs/notes/origin (one note per
 * commit, so distinct commits union naturally and `-s ours` only arbitrates
 * genuine same-commit collisions), the ENTIRE memory payload is a single note
 * on a single object — the repo's root commit. Every machine that has ever
 * written memory collides on that one object, and any git-level strategy
 * resolves the whole blob: `-s ours` silently discards the other machine's
 * sessions in full, `-s theirs` discards yours. The union has to happen
 * inside the JSON.
 *
 * Invariants the transport depends on:
 *   - no session or commit is ever dropped by merging (within the window)
 *   - session rollups are MUTABLE → newest write wins per sessionId
 *   - commit records are IMMUTABLE → first-seen wins, never rewritten
 *   - merge is idempotent, so folding the same remote twice is a no-op
 */

import { describe, it, expect } from 'vitest';
import { mergeMemoryPayloads } from '../memory.js';
import type { SessionMemoryEntry, CommitMemoryEntry } from '../memory.js';

const session = (
  id: string,
  opts: Partial<SessionMemoryEntry> = {},
): SessionMemoryEntry => ({
  sessionId: id,
  agentSlug: 'claude-code',
  model: 'claude',
  startedAt: '2026-08-01T00:00:00.000Z',
  endedAt: '2026-08-01T01:00:00.000Z',
  branch: 'main',
  summary: `work ${id}`,
  filesChanged: [`${id}.py`],
  promptCount: 1,
  linesAdded: 10,
  linesRemoved: 0,
  openTodos: [],
  ...opts,
});

const commit = (sha: string, sessionId: string, opts: Partial<CommitMemoryEntry> = {}): CommitMemoryEntry => ({
  commitSha: sha,
  sessionId,
  agentSlug: 'claude-code',
  message: `commit ${sha}`,
  filesChanged: [`${sha}.py`],
  linesAdded: 5,
  linesRemoved: 0,
  branch: 'main',
  committedAt: '2026-08-01T00:30:00.000Z',
  ...opts,
});

const payload = (sessions: SessionMemoryEntry[], commits: CommitMemoryEntry[] = []) => ({
  version: 2,
  sessions,
  commits,
});

const ids = (p: { sessions: SessionMemoryEntry[] }) => p.sessions.map((s) => s.sessionId).sort();
const shas = (p: { commits: CommitMemoryEntry[] }) => p.commits.map((c) => c.commitSha).sort();

describe('mergeMemoryPayloads', () => {
  it('unions disjoint sessions from two machines — neither side is lost', () => {
    // The bug this guards: `-s ours` here would have kept only machine A.
    const a = payload([session('a1'), session('a2')]);
    const b = payload([session('b1')]);
    expect(ids(mergeMemoryPayloads(a, b))).toEqual(['a1', 'a2', 'b1']);
  });

  it('unions disjoint commit records', () => {
    const a = payload([session('s1')], [commit('aaa', 's1')]);
    const b = payload([session('s1')], [commit('bbb', 's1')]);
    expect(shas(mergeMemoryPayloads(a, b))).toEqual(['aaa', 'bbb']);
  });

  it('takes the NEWER rollup when both machines have the same session', () => {
    const older = session('s1', { endedAt: '2026-08-01T01:00:00.000Z', summary: 'stale', linesAdded: 5 });
    const newer = session('s1', { endedAt: '2026-08-02T09:00:00.000Z', summary: 'fresh', linesAdded: 90 });

    expect(mergeMemoryPayloads(payload([older]), payload([newer])).sessions[0].summary).toBe('fresh');
    // …in both directions — recency decides, not argument order.
    expect(mergeMemoryPayloads(payload([newer]), payload([older])).sessions[0].summary).toBe('fresh');
  });

  it('falls back to startedAt when endedAt is missing', () => {
    const a = session('s1', { endedAt: '', startedAt: '2026-08-01T00:00:00.000Z', summary: 'first' });
    const b = session('s1', { endedAt: '', startedAt: '2026-08-05T00:00:00.000Z', summary: 'second' });
    expect(mergeMemoryPayloads(payload([a]), payload([b])).sessions[0].summary).toBe('second');
  });

  it('keeps local on a timestamp tie, so merging is deterministic', () => {
    const mine = session('s1', { summary: 'mine' });
    const theirs = session('s1', { summary: 'theirs' });
    expect(mergeMemoryPayloads(payload([mine]), payload([theirs])).sessions[0].summary).toBe('mine');
  });

  it('never rewrites a commit record — they are frozen once written', () => {
    const original = commit('aaa', 's1', { message: 'original' });
    const rewritten = commit('aaa', 's1', { message: 'tampered' });
    const merged = mergeMemoryPayloads(payload([session('s1')], [original]), payload([session('s1')], [rewritten]));
    expect(merged.commits).toHaveLength(1);
    expect(merged.commits[0].message).toBe('original');
  });

  it('is idempotent — folding the same remote twice changes nothing', () => {
    const local = payload([session('a1')], [commit('aaa', 'a1')]);
    const remote = payload([session('b1')], [commit('bbb', 'b1')]);
    const once = mergeMemoryPayloads(local, remote);
    const twice = mergeMemoryPayloads(once, remote);
    expect(twice).toEqual(once);
  });

  it('sorts sessions oldest→newest and trims to the 20-entry window', () => {
    // 15 + 15 = 30 distinct sessions; the window keeps the newest 20.
    const mk = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        session(`${prefix}${i}`, { endedAt: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
      );
    const merged = mergeMemoryPayloads(payload(mk('a', 15)), payload(mk('b', 15)));
    expect(merged.sessions).toHaveLength(20);
    const times = merged.sessions.map((s) => Date.parse(s.endedAt));
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it('prunes commit records whose session fell out of the retained window', () => {
    const old = session('old', { endedAt: '2026-01-01T00:00:00.000Z' });
    const recent = Array.from({ length: 20 }, (_, i) =>
      session(`r${i}`, { endedAt: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    const merged = mergeMemoryPayloads(
      payload([old], [commit('orphan', 'old')]),
      payload(recent, [commit('kept', 'r5')]),
    );
    expect(ids(merged)).not.toContain('old');
    expect(shas(merged)).toEqual(['kept']);
  });

  it('handles an empty or malformed side without throwing', () => {
    const good = payload([session('s1')], [commit('aaa', 's1')]);
    expect(ids(mergeMemoryPayloads(good, payload([])))).toEqual(['s1']);
    expect(ids(mergeMemoryPayloads(payload([]), good))).toEqual(['s1']);
    // Shapes that a corrupt/truncated note could produce.
    expect(() => mergeMemoryPayloads(good, {} as any)).not.toThrow();
    expect(() => mergeMemoryPayloads({} as any, good)).not.toThrow();
    expect(ids(mergeMemoryPayloads(good, { sessions: [null], commits: [null] } as any))).toEqual(['s1']);
  });

  it('preserves the rich fields that make memory worth sharing', () => {
    const rich = session('s1', {
      fileNotes: { 'countdown.py': 'New interactive CLI countdown timer' },
      decisions: ['used curses over ANSI codes — handles resize'],
      openTodos: ['add tests'],
    });
    const merged = mergeMemoryPayloads(payload([]), payload([rich]));
    expect(merged.sessions[0].fileNotes).toEqual({ 'countdown.py': 'New interactive CLI countdown timer' });
    expect(merged.sessions[0].decisions).toEqual(['used curses over ANSI codes — handles resize']);
    expect(merged.sessions[0].openTodos).toEqual(['add tests']);
  });
});
