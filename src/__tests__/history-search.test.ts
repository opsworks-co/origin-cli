// Ranked search over a repo's recorded history: real git notes in a real repo.
//
// What matters here is reach and ranking, not BM25 arithmetic: that a query in
// different words still finds the record, that the prompts behind commits are
// read from the notes as they are actually written today (nested under
// `origin`, many at once, UTF-8), and that chat turns and commit trailers do
// not crowd out the records that explain the work.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeCommitMemory, writeSessionMemory } from '../memory.js';
import { buildHistoryDocs, searchHistory, tokenize } from '../history-search.js';

function makeRepo(): { dir: string; commit: (file: string, msg: string) => string; note: (sha: string, origin: object) => void } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-history-search-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return {
    dir,
    commit: (file, msg) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.appendFileSync(path.join(dir, file), `${msg}\n`);
      git('add', '.');
      git('commit', '-qm', msg);
      return git('rev-parse', 'HEAD');
    },
    note: (sha, origin) => { git('notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify({ origin }), sha); },
  };
}

const session = (over: Record<string, any> = {}) => ({
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  agentSlug: 'claude-code',
  model: 'claude-opus-5',
  startedAt: '2026-09-20T10:00:00.000Z',
  endedAt: '2026-09-20T12:00:00.000Z',
  branch: 'main',
  summary: 'The Stop hook gets time to send the turn before the agent kills it',
  filesChanged: ['packages/cli/src/commands/hooks/stop.ts'],
  promptCount: 3,
  linesAdded: 40,
  linesRemoved: 5,
  openTodos: [],
  ...over,
});

const withRepo = (fn: (r: ReturnType<typeof makeRepo>) => void) => {
  const r = makeRepo();
  try { fn(r); } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
};

describe('tokenize', () => {
  it('keeps a path whole and as its basename, and an identifier whole and as its parts', () => {
    const t = tokenize('Fixed readMemoryPayload in packages/cli/src/memory.ts');
    expect(t).toContain('packages/cli/src/memory.ts');
    expect(t).toContain('memory.ts');
    expect(t).toContain('readmemorypayload');
    expect(t).toEqual(expect.arrayContaining(['read', 'memory', 'payload']));
  });

  it('meets singular and plural, and drops stopwords', () => {
    expect(tokenize('the hooks')).toEqual(['hook']);
    expect(tokenize('hook')).toEqual(['hook']);
  });
});

describe('searchHistory', () => {
  it('finds a session by the words of the question, not a substring of it', () => withRepo(({ dir }) => {
    writeSessionMemory(dir, session() as any);
    writeSessionMemory(dir, session({ sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', summary: 'Restyled the dashboard header', filesChanged: ['apps/web/src/Header.tsx'] }) as any);

    const r = searchHistory(dir, 'why does the stop hook need more time');
    expect(r.hits[0]).toMatchObject({ kind: 'session', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444' });
    expect(r.hits.some((h) => h.sessionId?.startsWith('bbbbbbbb'))).toBe(false);
  }));

  it('matches a file a record touched by its name', () => withRepo(({ dir }) => {
    writeSessionMemory(dir, session() as any);
    expect(searchHistory(dir, 'stop.ts').hits[0]?.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444');
  }));

  it('reads the prompts behind commits from current notes: one record per prompt, every commit it stands behind', () => withRepo(({ dir, commit, note }) => {
    const prompt = 'add rate limiting to the login endpoint, five tries per address — naïve résumé check';
    const a = commit('src/login.ts', 'first');
    const b = commit('src/login.ts', 'second');
    for (const sha of [a, b]) {
      note(sha, { version: 1, sessionId: 's-1', agent: 'cursor', timestamp: '2026-09-21T09:00:00Z', filesChanged: ['src/login.ts'], prompts: [{ index: 1, text: prompt }] });
    }

    const hits = searchHistory(dir, 'rate limit login', { kinds: ['prompt'] }).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'prompt', agent: 'cursor', sessionId: 's-1' });
    expect(hits[0].commits!.sort()).toEqual([a, b].map((s) => s.slice(0, 12)).sort());
    // UTF-8 survives the batched read: the byte-sized headers index the body.
    expect(hits[0].snippet).toContain('naïve résumé');
  }));

  it('skips chat turns and pasted links, which say what to do next rather than what the work was', () => withRepo(({ dir, commit, note }) => {
    const sha = commit('src/x.ts', 'x');
    note(sha, { sessionId: 's-2', prompts: [
      { index: 1, text: 'fix the deploy guard' },
      { index: 2, text: 'https://example.com/deploy/guard/rollback/notes/page' },
    ] });
    expect(buildHistoryDocs(dir).filter((d) => d.kind === 'prompt')).toHaveLength(0);
  }));

  it('does not match commit trailers', () => withRepo(({ dir }) => {
    writeCommitMemory(dir, {
      commitSha: 'c'.repeat(40), sessionId: 's-3', agentSlug: 'claude-code', branch: 'main',
      message: 'wip\n\nOrigin-Session: 4c6c0ead | Claude Code | 1 prompt\nCo-Authored-By: Claude <noreply@anthropic.com>',
      filesChanged: [], linesAdded: 1, linesRemoved: 0, committedAt: '2026-09-22T00:00:00Z',
    } as any);
    expect(searchHistory(dir, 'claude code session').hits).toHaveLength(0);
  }));

  it('filters by kind and counts what it searched', () => withRepo(({ dir }) => {
    writeSessionMemory(dir, session() as any);
    const r = searchHistory(dir, 'stop hook', { kinds: ['commit'] });
    expect(r.hits).toHaveLength(0);
    expect(r.indexed.session).toBe(1);
  }));

  it('answers an empty repo with nothing, not an error', () => withRepo(({ dir }) => {
    const r = searchHistory(dir, 'anything at all');
    expect(r.hits).toEqual([]);
    expect(Object.values(r.indexed).every((n) => n === 0)).toBe(true);
  }));
});
