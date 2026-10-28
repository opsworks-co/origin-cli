/**
 * A Claude Code session's memory entry is written once, by the heartbeat when
 * the session really ends (session-memory-final.ts). With the default
 * `memoryUpdate: session-end` no commit wrote an entry before it, and that
 * write took its files only from the entry already there — so every session
 * was remembered with line counts and an empty file list (prod: a RhodeCode
 * repo's ten sessions, 823 lines added, no files).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAllSessionMemory, writeSessionMemory } from '../memory.js';
import { turnFilesChanged, writeFinalSessionMemory } from '../session-memory-final.js';

function repo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-finalmem-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

const mapping = (promptIndex: number, filesChanged: string[], discardedFiles?: string[]) => ({
  promptIndex, diff: '', filesChanged, ...(discardedFiles ? { discardedFiles } : {}),
});

describe('turnFilesChanged', () => {
  it('unions every turn\'s files, without the ones a turn put back', () => {
    expect(turnFilesChanged({
      completedPromptMappings: [mapping(0, ['a.py', 'b.py']), mapping(1, ['b.py', 'tmp.py'], ['tmp.py'])],
    }).sort()).toEqual(['a.py', 'b.py']);
  });

  it('no mappings, no files', () => {
    expect(turnFilesChanged({})).toEqual([]);
  });
});

describe('writeFinalSessionMemory', () => {
  const base = {
    sessionId: 'sess-final-1', startedAt: '2026-10-19T10:00:00Z', agentSlug: 'claude-code', model: 'claude-opus-5-5',
    branch: 'RCCE-1', prompts: ['p1', 'p2'], linesAdded: 823, linesRemoved: 26,
  };

  it('a session with no earlier entry is remembered with the files its turns changed', () => {
    const dir = repo();
    try {
      expect(writeFinalSessionMemory({
        ...base, repoPath: dir,
        completedPromptMappings: [mapping(0, ['rhodecode/a.py']), mapping(1, ['rhodecode/b.py', 'rhodecode/a.py'])],
      })).toBe(true);
      const stored = readAllSessionMemory(dir).find((e) => e.sessionId === base.sessionId)!;
      expect(stored.filesChanged.sort()).toEqual(['rhodecode/a.py', 'rhodecode/b.py']);
      expect(stored.linesAdded).toBe(823);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the files an earlier commit-time entry recorded', () => {
    const dir = repo();
    try {
      writeSessionMemory(dir, {
        sessionId: base.sessionId, agentSlug: 'claude-code', model: 'm', startedAt: base.startedAt, endedAt: base.startedAt,
        branch: 'RCCE-1', summary: 'x', filesChanged: ['committed.py'], promptCount: 1, linesAdded: 1, linesRemoved: 0, openTodos: [],
      });
      writeFinalSessionMemory({ ...base, repoPath: dir, completedPromptMappings: [mapping(0, ['later.py'])] });
      const stored = readAllSessionMemory(dir).find((e) => e.sessionId === base.sessionId)!;
      expect(stored.filesChanged.sort()).toEqual(['committed.py', 'later.py']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
