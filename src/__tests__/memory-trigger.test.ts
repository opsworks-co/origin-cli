// When memory is written is configurable (config.memoryUpdate): at session end
// (default), on every commit, or both. Writing on commit is what captures
// commit-and-go agents that never reach a clean session end — but it means a
// session writes memory MORE THAN ONCE, so writeSessionMemory must upsert by
// sessionId (one latest entry per session) instead of appending a duplicate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeSessionMemory, readAllSessionMemory,
  shouldWriteMemoryOnCommit, shouldWriteMemoryOnSessionEnd,
  type SessionMemoryEntry,
} from '../memory.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const entry = (over: Partial<SessionMemoryEntry>): SessionMemoryEntry => ({
  sessionId: 's1', agentSlug: 'claude-code', model: 'claude', startedAt: '2026-08-06T00:00:00Z',
  endedAt: new Date().toISOString(), branch: 'main', summary: 'work', filesChanged: ['a.ts'],
  promptCount: 1, linesAdded: 1, linesRemoved: 0, openTodos: [], ...over,
});

describe('memory write trigger decisions', () => {
  it('session-end writes only at session end', () => {
    expect(shouldWriteMemoryOnSessionEnd('session-end')).toBe(true);
    expect(shouldWriteMemoryOnCommit('session-end')).toBe(false);
  });
  it('commit writes only on commit', () => {
    expect(shouldWriteMemoryOnCommit('commit')).toBe(true);
    expect(shouldWriteMemoryOnSessionEnd('commit')).toBe(false);
  });
  it('both writes on commit AND at session end', () => {
    expect(shouldWriteMemoryOnCommit('both')).toBe(true);
    expect(shouldWriteMemoryOnSessionEnd('both')).toBe(true);
  });
});

describe('writeSessionMemory upsert-by-sessionId', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mem-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const x = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('re-writing the same sessionId REPLACES its entry (one per session), not appends', () => {
    writeSessionMemory(repo, entry({ sessionId: 's1', linesAdded: 3, summary: 'first commit' }));
    writeSessionMemory(repo, entry({ sessionId: 's1', linesAdded: 10, summary: 'second commit', filesChanged: ['a.ts', 'b.ts'] }));

    const all = readAllSessionMemory(repo);
    const s1 = all.filter((e) => e.sessionId === 's1');
    expect(s1).toHaveLength(1);            // upsert, not duplicate
    expect(s1[0].linesAdded).toBe(10);     // latest state won
    expect(s1[0].summary).toBe('second commit');
    expect(s1[0].filesChanged).toEqual(['a.ts', 'b.ts']);
  });

  it('different sessionIds are kept as separate entries', () => {
    writeSessionMemory(repo, entry({ sessionId: 's1' }));
    writeSessionMemory(repo, entry({ sessionId: 's2' }));
    const ids = readAllSessionMemory(repo).map((e) => e.sessionId).sort();
    expect(ids).toEqual(['s1', 's2']);
  });
});
