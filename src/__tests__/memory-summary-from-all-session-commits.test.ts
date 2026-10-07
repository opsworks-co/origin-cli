// A session's memory summary is built from EVERY commit it made, not the last.
//
// The commit-time write summarized only the commit that triggered it. When that
// commit was noise — merging main in before merging the PR — the one-subject
// summary was empty and fell through to the agent's last message: session
// 22005642's entry read "While that runs, I'm pushing the merge commit so the
// PR shows the exact head being tested."
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  sessionCommitSubjects, summarizeFromCommitSubjects, writeCommitMemory, writeSessionMemory,
  type CommitMemoryEntry,
} from '../memory.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const commit = (sha: string, sessionId: string, message: string, minute: number): CommitMemoryEntry => ({
  commitSha: sha.repeat(40).slice(0, 40), sessionId, agentSlug: 'claude-code', message,
  filesChanged: [`${sha}.ts`], linesAdded: 1, linesRemoved: 0, branch: 'main',
  committedAt: `2026-09-29T00:${String(minute).padStart(2, '0')}:00.000Z`,
});

describe('sessionCommitSubjects', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mem-subjects-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    writeSessionMemory(repo, {
      sessionId: 's1', agentSlug: 'claude-code', model: 'm', startedAt: '2026-09-29T00:00:00.000Z',
      endedAt: '2026-09-29T00:40:00.000Z', branch: 'main', summary: 'x', filesChanged: ['a.ts'],
      promptCount: 1, linesAdded: 1, linesRemoved: 0, openTodos: [],
    });
  });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it('lists only this session\'s commits, oldest first, subject line only', () => {
    // Recorded out of order: a catch-up write lands after newer commits.
    writeCommitMemory(repo, commit('b', 's1', 'fix: second\n\nbody text', 20));
    writeCommitMemory(repo, commit('a', 's1', 'feat: first', 10));
    writeCommitMemory(repo, commit('c', 'someone-else', 'feat: not mine', 15));
    expect(sessionCommitSubjects(repo, 's1')).toEqual(['feat: first', 'fix: second']);
  });

  it('gives a real summary when the latest commit is a merge', () => {
    writeCommitMemory(repo, commit('a', 's1', 'fix(memory): keep what fits a byte budget', 10));
    writeCommitMemory(repo, commit('b', 's1', "Merge remote-tracking branch 'origin/main' into feature", 30));
    const latestOnly = summarizeFromCommitSubjects(["Merge remote-tracking branch 'origin/main' into feature"]);
    expect(latestOnly).toBeNull(); // what the commit-time write used to see
    expect(summarizeFromCommitSubjects(sessionCommitSubjects(repo, 's1')))
      .toBe('fix(memory): keep what fits a byte budget');
  });
});
