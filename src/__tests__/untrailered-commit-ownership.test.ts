/**
 * The same "our own record is its own proof" flaw, in the branch the earlier
 * fix did not reach.
 *
 * commit-ownership-trailer.test.ts opens by describing it: "`sessionCommitShas`
 * was checked first and returned immediately, so a commit our post-commit hook
 * mis-recorded could never be given back." That was repaired for a commit
 * carrying a trailer naming somebody else. A commit carrying NO trailer still
 * hit `if (weRecordedIt) return true;` and short-circuited both remaining
 * checks — the two signals that are not guesses.
 *
 * `sessionCommitShas` is written by the post-commit hook, which has to GUESS
 * which of several live sessions a commit belongs to. That guess is the thing
 * this predicate exists to audit, so it cannot also be the thing that ends the
 * audit.
 *
 * Measured on session 6e9947a5, which recorded bc324e14 — a GitHub
 * squash-merge of PR #1214 that arrived by `git pull`. Both guards below catch
 * it and neither ran: sibling session 3b276b1f had recorded it too, and its
 * committer is `noreply@github.com`, the exact pulled-commit signature the
 * committer check was written for. The turn was credited with nine files it
 * never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitBelongsToSession } from '../commands/hooks.js';

const LOCAL = 't@origin.dev';
const OURS = '6e9947a5-2b9b-47b6-aae4-c60d7d75223a';

describe('commitBelongsToSession — no trailer', () => {
  let repo: string;

  const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

  /** A commit with no Origin-Session trailer, optionally committed by someone else. */
  function commitNoTrailer(subject: string, committerEmail = LOCAL): string {
    fs.appendFileSync(path.join(repo, 'f.txt'), `${subject}\n`);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', subject], {
      GIT_COMMITTER_EMAIL: committerEmail,
      GIT_COMMITTER_NAME: committerEmail === LOCAL ? 'T' : 'GitHub',
    });
    return git(repo, ['rev-parse', 'HEAD']);
  }

  function writeSiblingSession(sessionId: string, shas: string[]): void {
    fs.writeFileSync(
      path.join(repo, '.git', `origin-session-${sessionId.slice(0, 12)}.json`),
      JSON.stringify({
        sessionId, sessionTag: sessionId.slice(0, 12), repoPath: repo,
        sessionCommitShas: shas,
      }),
    );
  }

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-untrailered-')));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', LOCAL]);
    git(repo, ['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'seed\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'seed']);
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('REFUSES a pulled commit even though we recorded it (committer is GitHub)', () => {
    // bc324e14: a squash-merge fast-forwarded into a shared checkout mid-turn.
    const sha = commitNoTrailer('fix: somebody else\'s PR (#1214)', 'noreply@github.com');
    const state: any = { sessionId: OURS, repoPath: repo, sessionCommitShas: [sha] };

    expect(commitBelongsToSession(repo, sha, state, LOCAL)).toBe(false);
  });

  it('REFUSES a commit a SIBLING also recorded, even though we recorded it', () => {
    const sha = commitNoTrailer('fix: the sibling\'s work');
    writeSiblingSession('3b276b1f-00f2-4afc-82b1-5780222e39e2', [sha]);
    const state: any = { sessionId: OURS, repoPath: repo, sessionCommitShas: [sha] };

    expect(commitBelongsToSession(repo, sha, state, LOCAL)).toBe(false);
  });

  it('KEEPS a hook-missed local commit — no trailer, local committer, nobody else claims it', () => {
    // The reason the untrailered default is generous in the first place: a
    // sandboxed Codex or a shell `git commit` writes no trailer, and that work
    // is genuinely ours. This must not regress.
    const sha = commitNoTrailer('fix: our own shell commit');
    const state: any = { sessionId: OURS, repoPath: repo, sessionCommitShas: [sha] };

    expect(commitBelongsToSession(repo, sha, state, LOCAL)).toBe(true);
  });

  it('KEEPS a local commit we never recorded either — the generous default', () => {
    const sha = commitNoTrailer('fix: ours, hook never fired');
    const state: any = { sessionId: OURS, repoPath: repo, sessionCommitShas: [] };

    expect(commitBelongsToSession(repo, sha, state, LOCAL)).toBe(true);
  });

  it('KEEPS a pulled commit when the local identity is unknown', () => {
    // With no localEmail there is nothing to compare against, and disowning on
    // an absent signal would silently drop real work.
    const sha = commitNoTrailer('fix: upstream', 'noreply@github.com');
    const state: any = { sessionId: OURS, repoPath: repo, sessionCommitShas: [sha] };

    expect(commitBelongsToSession(repo, sha, state, '')).toBe(true);
  });

  it('a sibling that recorded a DIFFERENT sha does not disown ours', () => {
    const ours = commitNoTrailer('fix: ours');
    const theirs = commitNoTrailer('fix: theirs');
    writeSiblingSession('3b276b1f-00f2-4afc-82b1-5780222e39e2', [theirs]);
    const state: any = { sessionId: OURS, repoPath: repo, sessionCommitShas: [ours] };

    expect(commitBelongsToSession(repo, ours, state, LOCAL)).toBe(true);
  });

  // Committer dates have whole-second resolution and `startedAt` is floored to
  // match, so a commit made just BEFORE the session, in the same second, used
  // to read as the session's own. capture-e2e-rebase-replays-earlier-turn-commit
  // flaked on it: the fixture's upstream commit shared the session's start
  // second, and the rebasing turn was measured from upstream's tree.
  describe('a commit dated inside the session\'s start second', () => {
    const START_SEC = 1_790_893_400;
    const startedAt = new Date(START_SEC * 1000 + 799).toISOString();
    const commitAt = (subject: string, sec: number) => {
      fs.appendFileSync(path.join(repo, 'f.txt'), `${subject}\n`);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', subject], { GIT_COMMITTER_DATE: `@${sec} +0000`, GIT_AUTHOR_DATE: `@${sec} +0000` });
      return git(repo, ['rev-parse', 'HEAD']);
    };

    it('is NOT ours when this session never recorded it — it predates the session', () => {
      const sha = commitAt('fix: upstream edits scope.ts too', START_SEC);
      const state: any = { sessionId: OURS, repoPath: repo, startedAt, sessionCommitShas: [] };

      expect(commitBelongsToSession(repo, sha, state, LOCAL)).toBe(false);
    });

    it('is ours when this session recorded it', () => {
      const sha = commitAt('fix: ours', START_SEC);
      const state: any = { sessionId: OURS, repoPath: repo, startedAt, sessionCommitShas: [sha] };

      expect(commitBelongsToSession(repo, sha, state, LOCAL)).toBe(true);
    });

    it('a second later the generous default stands', () => {
      const sha = commitAt('fix: ours, hook never fired', START_SEC + 1);
      const state: any = { sessionId: OURS, repoPath: repo, startedAt, sessionCommitShas: [] };

      expect(commitBelongsToSession(repo, sha, state, LOCAL)).toBe(true);
    });
  });
});
