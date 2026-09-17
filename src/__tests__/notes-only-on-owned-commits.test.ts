/**
 * `writeGitNotes` writes one payload onto every sha it is handed, so every
 * caller that passes a range must first ask `commitsThisSessionMayNote`: 330
 * notes in 15 bursts on refs/notes/origin sat on squash-merges a pull brought
 * in, none on a commit the noting session wrote.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitsThisSessionMayNote } from '../commands/hooks.js';

let repo: string;
const git = (a: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

function commit(file: string, message: string, env: Record<string, string> = {}): string {
  fs.writeFileSync(path.join(repo, file), `${file} ${Math.random()}\n`);
  git(['add', '.']);
  git(['commit', '-q', '-m', message], env);
  return git(['rev-parse', 'HEAD']);
}
const note = (sha: string, sessionId: string) =>
  git(['notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify({ origin: { version: 1, sessionId } }), sha]);

const SELF = '9e9e9e9e-1111-2222-3333-444444444444';
const OTHER = '5151aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const state: any = { sessionId: SELF, startedAt: new Date(Date.now() - 3_600_000).toISOString() };

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-owned-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('commitsThisSessionMayNote', () => {
  it('keeps our commits and drops what a pull brought into the range', () => {
    const ours = commit('a.txt', 'ours\n\nOrigin-Session: 9e9e9e9e-111 | Claude Code | 1 prompts');
    const localUntrailered = commit('b.txt', 'hook-missed local commit');
    const squash = commit('c.txt', 'someone else (#12)', { GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub' });
    const sibling = commit('d.txt', 'sibling\n\nOrigin-Session: 5151aaaa-bbb | Codex | 2 prompts');
    expect(commitsThisSessionMayNote(repo, state, [ours, localUntrailered, squash, sibling]))
      .toEqual([ours, localUntrailered]);
  });

  it('does not overwrite a note another session wrote, unless the trailer names us', () => {
    const untrailered = commit('a.txt', 'local, no trailer');
    const traileredOurs = commit('b.txt', 'ours\n\nOrigin-Session: 9e9e9e9e-111 | Claude Code | 1 prompts');
    note(untrailered, OTHER);
    note(traileredOurs, OTHER);
    expect(commitsThisSessionMayNote(repo, state, [untrailered, traileredOurs])).toEqual([traileredOurs]);
  });

  it('replaces our own note and a placeholder one', () => {
    const own = commit('a.txt', 'one');
    const placeholder = commit('b.txt', 'two');
    note(own, SELF);
    note(placeholder, 'unknown');
    expect(commitsThisSessionMayNote(repo, state, [own, placeholder])).toEqual([own, placeholder]);
  });

  it('never notes a commit made before the session started', () => {
    const old = commit('a.txt', 'before', { GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' });
    expect(commitsThisSessionMayNote(repo, state, [old])).toEqual([]);
  });
});

describe('every multi-commit note writer asks first', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'commands', 'hooks', f), 'utf-8');
  it('session end notes only commitsThisSessionMayNote', () => {
    expect(src('session-end.ts')).toMatch(/commitsThisSessionMayNote\(state\.repoPath, state, gitCapture\.commitShas\)[\s\S]{0,200}writeGitNotes\(state\.repoPath, noteShas,/);
  });
  it('Stop filters its note-less commits through it', () => {
    expect(src('stop.ts')).toMatch(/commitsThisSessionMayNote\(state\.repoPath, state, noteCommits\)/);
  });
  it('post-commit skips a commit another live session owns', () => {
    expect(src('post-commit.ts')).toMatch(/if \(commitIsAnotherSessions\) \{[\s\S]{0,200}\} else try \{\s*writeGitNotes\(repoPath, \[commitSha\]/);
  });
});
