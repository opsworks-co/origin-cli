// The memory note hangs on the repo's root commit, found with
// `rev-list --max-parents=0`. In a shallow repo that answers with the shallow
// boundary. On 2026-10-28 a reviewer's `git fetch origin main --depth=50` in a
// review worktree made ~/Documents/Coding/origin shallow (the worktree shares
// the .git): the 444 KB note read as three sessions, and every rollup and TODO
// closure after that went to a new note on the wrong commit. The root is now
// remembered while the history is whole.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { notesRootCommit, readAllSessionMemory, writeSessionMemory } from '../memory.js';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const entry = (sessionId: string) => ({
  sessionId, agentSlug: 'claude-code', model: 'claude-opus-5', startedAt: '2026-10-28T10:00:00.000Z', endedAt: '2026-10-28T11:00:00.000Z',
  branch: 'main', summary: `work ${sessionId}`, filesChanged: ['a.txt'], promptCount: 1, linesAdded: 1, linesRemoved: 0, openTodos: [],
});

describe('the notes root in a shallow repo', () => {
  let dir: string;
  let upstream: string;
  let work: string;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shallow-root-')));
    upstream = path.join(dir, 'upstream');
    work = path.join(dir, 'work');
    git(dir, 'init', '-q', '-b', 'main', upstream);
    for (const n of ['a', 'b', 'c']) {
      fs.writeFileSync(path.join(upstream, `${n}.txt`), n);
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-q', '-m', n);
    }
    git(dir, 'clone', '-q', `file://${upstream}`, work);
  });

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('keeps reading and writing the note on the real root after a --depth fetch', () => {
    const root = git(work, 'rev-list', '--max-parents=0', 'HEAD');
    expect(notesRootCommit(work)).toBe(root);
    writeSessionMemory(work, entry('before') as any);

    // What the reviewer did.
    git(work, 'fetch', '-q', '--depth=1', 'origin', 'main');
    expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(git(work, 'rev-list', '--max-parents=0', 'HEAD')).not.toBe(root);

    expect(notesRootCommit(work)).toBe(root);
    expect(readAllSessionMemory(work).map((e) => e.sessionId)).toEqual(['before']);
    writeSessionMemory(work, entry('after') as any);
    expect(readAllSessionMemory(work).map((e) => e.sessionId).sort()).toEqual(['after', 'before']);
    expect(git(work, 'notes', '--ref=origin-memory', 'list').split('\n').map((l) => l.split(' ')[1])).toEqual([root]);
  });

  it('a repo cloned shallow, with no root remembered, gets no note rather than one on the boundary', () => {
    const shallow = path.join(dir, 'shallow');
    git(dir, 'clone', '-q', '--depth=1', `file://${upstream}`, shallow);
    expect(notesRootCommit(shallow)).toBeNull();
    writeSessionMemory(shallow, entry('lost') as any);
    expect(readAllSessionMemory(shallow)).toEqual([]);
    expect(() => git(shallow, 'notes', '--ref=origin-memory', 'list')).not.toThrow();
    expect(git(shallow, 'notes', '--ref=origin-memory', 'list')).toBe('');
  });
});
