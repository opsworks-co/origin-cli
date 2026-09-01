// A commit trailered to ANOTHER session was being shown under this session's
// prompts. The ownership predicate had the right rule and consulted it too
// late: `sessionCommitShas` was checked first and returned immediately, so a
// commit our post-commit hook mis-recorded could never be given back.
//
// Measured on session 81d65cb5: it held 7998ece8, whose body says
// `Origin-Session: de0785ac-812` in plain text, and showed it under a prompt
// that had made no commit at all. With several agents live in one checkout the
// hook does mis-record — the trailer is written by the committing session AT
// COMMIT TIME, so when the two disagree the trailer is the better witness.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitBelongsToSession, commitTrailerBelongsToSession } from '../commands/hooks.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

describe('commitTrailerBelongsToSession', () => {
  it('reads self / other / none', () => {
    const st = { sessionId: 'aaaa1111-2222-3333-4444-555566667777' };
    expect(commitTrailerBelongsToSession('x\n\nOrigin-Session: aaaa1111-222 | Claude Code', st)).toBe('self');
    expect(commitTrailerBelongsToSession('x\n\nOrigin-Session: de0785ac-812 | Claude Code', st)).toBe('other');
    expect(commitTrailerBelongsToSession('x\n\nno trailer here', st)).toBe('none');
  });
});

describe('commitBelongsToSession', () => {
  let repo: string;
  const EMAIL = 't@origin.dev';

  function commitWith(body: string): string {
    fs.appendFileSync(path.join(repo, 'f.txt'), 'line\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', body);
    return git(repo, 'rev-parse', 'HEAD');
  }

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-own-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', EMAIL);
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'seed\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seed');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  // Writes a sibling session's state file where the CLI keeps them, so the
  // trailer names a session that genuinely exists — which is what separates a
  // real other owner from a stale amend/rebase trailer.
  function writeSiblingSession(sessionId: string): void {
    const gitDir = path.join(repo, '.git');
    fs.writeFileSync(
      path.join(gitDir, `origin-session-${sessionId.slice(0, 12)}.json`),
      JSON.stringify({ sessionId, sessionTag: sessionId.slice(0, 12), status: 'ENDED', repoPath: repo }),
    );
  }

  it('REFUSES a commit trailered to another session that REALLY EXISTS, even if we recorded it', () => {
    // The exact 81d65cb5 / de0785ac situation: our own record says it is ours,
    // the commit itself names a live sibling, and the sibling is real.
    const sha = commitWith('test: someone else\n\nOrigin-Session: de0785ac-812 | Claude Code');
    writeSiblingSession('de0785ac-8123-4000-9000-000000000000');
    const state: any = { sessionId: '81d65cb5-8ca2-48e5-ac4b-1a4352cf019d', sessionCommitShas: [sha] };
    expect(commitBelongsToSession(repo, sha, state, EMAIL)).toBe(false);
  });

  it('KEEPS a commit we recorded whose trailer is merely STALE', () => {
    // Amend/rebase leaves a trailer naming an id nothing answers to. Our
    // record is then the better witness — disowning it would lose real work.
    // This is the case the previous behaviour existed to protect.
    const sha = commitWith('feat: mine, rebased\n\nOrigin-Session: 0bs0lete-999 | Claude Code');
    const state: any = { sessionId: '81d65cb5-8ca2-48e5-ac4b-1a4352cf019d', sessionCommitShas: [sha] };
    expect(commitBelongsToSession(repo, sha, state, EMAIL)).toBe(true);
  });

  it('keeps a commit our trailer claims', () => {
    const sha = commitWith('feat: mine\n\nOrigin-Session: 81d65cb5-8ca | Claude Code');
    const state: any = { sessionId: '81d65cb5-8ca2-48e5-ac4b-1a4352cf019d', sessionCommitShas: [] };
    expect(commitBelongsToSession(repo, sha, state, EMAIL)).toBe(true);
  });

  it('still honours our own record when there is no trailer', () => {
    // The reason the record exists: a hook-missed commit carries no trailer.
    const sha = commitWith('chore: no trailer');
    const state: any = { sessionId: 'aaaa1111', sessionCommitShas: [sha] };
    expect(commitBelongsToSession(repo, sha, state, EMAIL)).toBe(true);
  });

  it('keeps the untrailered local-committer default', () => {
    const sha = commitWith('chore: no trailer');
    const state: any = { sessionId: 'aaaa1111', sessionCommitShas: [] };
    expect(commitBelongsToSession(repo, sha, state, EMAIL)).toBe(true);
    // A commit by someone else (a pulled squash-merge) is not ours.
    expect(commitBelongsToSession(repo, sha, state, 'noreply@github.com')).toBe(false);
  });
});
