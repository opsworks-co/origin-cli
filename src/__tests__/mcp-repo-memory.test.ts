/**
 * get_repo_memory — pull-based repo memory for agents.
 *
 * Memory used to be PUSH only: injected at session start, or read by a human
 * via `origin context memory`. An agent mid-session could not ask "what is the
 * state of this project?". This is the repo-level sibling of get_file_context.
 *
 * The properties worth pinning are the ones that make it safe to hand an agent:
 * it must never throw (a repo with no memory is a normal answer, not an error),
 * and it must stay token-frugal by default — memory is repo-wide, so a naive
 * dump is the largest single thing an agent could pull into context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessions: any[] = [];
const commits: any[] = [];

vi.mock('../memory.js', () => ({
  readAllSessionMemory: () => sessions,
  readAllCommitMemory: () => commits,
  sortByDateAsc: <T,>(list: T[], dateOf: (i: T) => string | undefined) =>
    [...list].sort((a, b) => String(dateOf(a) || '').localeCompare(String(dateOf(b) || ''))),
}));

const { getRepoMemory } = await import('../mcp/repo-memory.js');

const session = (over: Partial<any> = {}) => ({
  sessionId: 'sess1234abcd', agentSlug: 'claude-code', model: 'claude-opus-5',
  startedAt: '2026-08-13T10:00:00Z', endedAt: '2026-08-13T11:00:00Z', branch: 'main',
  summary: 'Fixed the badge', filesChanged: ['apps/api/src/routes/sessions.ts'],
  promptCount: 3, linesAdded: 10, linesRemoved: 2,
  openTodos: ['verify on prod'], decisions: ['gated on producedWork'], ...over,
});

const commit = (over: Partial<any> = {}) => ({
  commitSha: 'abcdef1234567', sessionId: 'sess1234abcd', agentSlug: 'claude-code',
  message: 'fix: badge', filesChanged: ['apps/api/src/routes/sessions.ts'],
  decisions: ['gated on producedWork'], linesAdded: 10, linesRemoved: 2,
  branch: 'main', committedAt: '2026-08-13T11:05:00Z', ...over,
});

beforeEach(() => { sessions.length = 0; commits.length = 0; });

describe('getRepoMemory — empty and error cases', () => {
  it('returns an empty result with a note rather than throwing', () => {
    const r = getRepoMemory({ repoPath: '/tmp/x' });
    expect(r.sessions).toEqual([]);
    expect(r.commits).toEqual([]);
    expect(r.note).toMatch(/No memory recorded/);
  });

  it('explains an empty result caused by a path filter', () => {
    sessions.push(session());
    const r = getRepoMemory({ repoPath: '/tmp/x', paths: ['nope.ts'] });
    expect(r.sessions).toEqual([]);
    expect(r.note).toMatch(/No memory entries touch: nope\.ts/);
    // The totals still report what EXISTS, so the agent can tell "nothing
    // matched" from "nothing recorded".
    expect(r.sessionCount).toBe(1);
  });
});

describe('getRepoMemory — token discipline', () => {
  it('omits decisions / TODOs / fileNotes by default, keeping only counts', () => {
    sessions.push(session({ fileNotes: { 'a.ts': 'note' } }));
    const s = getRepoMemory({ repoPath: '/tmp/x' }).sessions[0];
    expect(s.decisionCount).toBe(1);
    expect(s.openTodoCount).toBe(1);
    expect(s.decisions).toBeUndefined();
    expect(s.openTodos).toBeUndefined();
    expect(s.fileNotes).toBeUndefined();
  });

  it('includes the detail when asked', () => {
    sessions.push(session({ fileNotes: { 'a.ts': 'note' } }));
    const s = getRepoMemory({ repoPath: '/tmp/x', includeDetail: true }).sessions[0];
    expect(s.decisions).toEqual(['gated on producedWork']);
    expect(s.openTodos).toEqual(['verify on prod']);
    expect(s.fileNotes).toEqual({ 'a.ts': 'note' });
  });

  it('caps the file list but still reports the true count', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    sessions.push(session({ filesChanged: many }));
    const s = getRepoMemory({ repoPath: '/tmp/x' }).sessions[0];
    expect((s.files as string[]).length).toBe(8);
    expect(s.fileCount).toBe(30);
  });

  it('truncates a runaway summary', () => {
    sessions.push(session({ summary: 'x'.repeat(5000) }));
    const s = getRepoMemory({ repoPath: '/tmp/x' }).sessions[0];
    expect((s.summary as string).length).toBe(400);
  });
});

describe('getRepoMemory — limits and ordering', () => {
  it('returns the MOST RECENT entries, chronologically', () => {
    for (let i = 1; i <= 8; i++) {
      sessions.push(session({ sessionId: `s${i}`.padEnd(8, '0'), endedAt: `2026-08-1${i}T10:00:00Z` }));
    }
    const r = getRepoMemory({ repoPath: '/tmp/x', sessionLimit: 3 });
    // Newest three, oldest-first — a history reads forwards.
    expect(r.sessions.map((s) => s.endedAt))
      .toEqual(['2026-08-16T10:00:00Z', '2026-08-17T10:00:00Z', '2026-08-18T10:00:00Z']);
  });

  it('clamps limits instead of trusting the caller', () => {
    for (let i = 0; i < 40; i++) commits.push(commit({ commitSha: `c${i}`.padEnd(8, '0'), committedAt: `2026-08-13T${String(i % 24).padStart(2, '0')}:00:00Z` }));
    expect(getRepoMemory({ repoPath: '/x', commitLimit: 9999 }).commits.length).toBe(40); // max 50, only 40 exist
    expect(getRepoMemory({ repoPath: '/x', commitLimit: 0 }).commits.length).toBe(1);     // min 1
    expect(getRepoMemory({ repoPath: '/x', commitLimit: NaN }).commits.length).toBe(10);  // default
  });
});

describe('getRepoMemory — path filtering', () => {
  beforeEach(() => {
    sessions.push(session({ sessionId: 'auth0000', filesChanged: ['src/auth.ts'] }));
    sessions.push(session({ sessionId: 'ui000000', filesChanged: ['web/Button.tsx'] }));
  });

  it('matches on a bare filename (agents rarely know the full path)', () => {
    const r = getRepoMemory({ repoPath: '/x', paths: ['auth.ts'] });
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].sessionId).toBe('auth0000');
  });

  it('returns everything when no paths are given', () => {
    expect(getRepoMemory({ repoPath: '/x' }).sessions).toHaveLength(2);
  });

  it('ignores blank path entries rather than matching nothing', () => {
    expect(getRepoMemory({ repoPath: '/x', paths: ['', '  '] }).sessions).toHaveLength(2);
  });
});
