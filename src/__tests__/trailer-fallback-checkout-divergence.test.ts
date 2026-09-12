/**
 * The header's trailer fallback after a mid-turn checkout divergence.
 *
 * Session e1095412 (2026-09-08) ran `git checkout --detach origin/main` in a
 * turn before it had committed anything. With no recorded shas the session
 * snapshot fell back to `ownedRangeCommitShas`, whose range is
 * `headShaAtStart..HEAD` — and after the checkout that is not "what happened
 * during the session", it is every commit on main that our branch does not
 * have. The header went to 156 files / +6634 across 9 commits, none of them
 * ours, and `authoredSource: trailer` said the walk had accepted them.
 *
 * Two rules let them through, and this file pins both:
 *
 *   1. A commit committed BEFORE the session started was accepted as long as
 *      it carried no trailer and the local identity committed it. A checkout
 *      or a pull is exactly how such a commit enters the range; nothing this
 *      session did can have a committer date older than the session.
 *
 *   2. `previousSessionId` — the last session that wrote memory in this repo,
 *      ANY conversation — counted as "self". GitHub's squash-merge keeps the
 *      `Origin-Session` trailer in the body, so the previous session's merged
 *      PRs on main were matched as our own. The chain rule stays only for the
 *      case it was written for: a commit made locally, during this session,
 *      trailered to a previous session that is not itself live here.
 *
 * Real git on purpose: the defect lives in what `rev-list start..HEAD` yields
 * once `start` is on another line of history, and the guards read committer
 * dates and emails — none of which a mock reproduces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitBelongsToSession } from '../commands/hooks.js';
import { ownedRangeCommitShas } from '../commands/hooks/stop.js';
import { sessionAuthoredSnapshot } from '../commands/hooks/post-commit.js';

const LOCAL = 't@origin.dev';
const OURS = 'e1095412-8b31-45cd-a6d0-b587b3ab439c';
const PREV = '29b32c38-12b4-44f2-bf27-ab0147e78f8d';
const GITHUB = 'noreply@github.com';

const HOUR = 3600_000;
const NOW = Date.now();
const SESSION_START = new Date(NOW - HOUR).toISOString();
const BEFORE_SESSION = new Date(NOW - 2 * HOUR).toISOString();
const DURING_SESSION = new Date(NOW - HOUR / 2).toISOString();

describe('trailer fallback after a mid-turn checkout divergence', () => {
  let repo: string;
  let n = 0;

  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

  function commit(opts: { subject: string; trailer?: string; committer?: string; at: string }): string {
    fs.writeFileSync(path.join(repo, `f${++n}.txt`), `${opts.subject}\nline 2\nline 3\n`);
    git(['add', '-A']);
    const body = opts.trailer ? `${opts.subject}\n\nOrigin-Session: ${opts.trailer}` : opts.subject;
    git(['commit', '-q', '-m', body], {
      GIT_COMMITTER_EMAIL: opts.committer || LOCAL,
      GIT_COMMITTER_NAME: opts.committer ? 'GitHub' : 'T',
      GIT_COMMITTER_DATE: opts.at,
      GIT_AUTHOR_DATE: opts.at,
    });
    return git(['rev-parse', 'HEAD']);
  }

  function state(extra: Record<string, unknown> = {}): any {
    return {
      sessionId: OURS, previousSessionId: PREV, repoPath: repo,
      startedAt: SESSION_START, sessionCommitShas: [], ...extra,
    };
  }

  beforeEach(() => {
    n = 0;
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-divergence-')));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', LOCAL]);
    git(['config', 'user.name', 'T']);
    git(['config', 'commit.gpgsign', 'false']);
    commit({ subject: 'seed', at: BEFORE_SESSION });
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  /**
   * The e1095412 shape.
   *
   *   C0 ── S0 ── S1 ── S2        main   (the previous session's merged PRs,
   *    └─── M0                    mine    a shell commit; we start HERE)
   *
   * The turn then checks main out, so `M0..HEAD` is {S0, S1, S2}.
   */
  function divergeOntoMain(): { s0: string; s1: string; s2: string; m0: string } {
    // Main: the previous session's PR squash-merged before we started, another
    // one merged while we ran, and an untrailered local commit from before.
    const s0 = commit({ subject: 'prev PR A (#1)', trailer: PREV.slice(0, 12), committer: GITHUB, at: BEFORE_SESSION });
    const s1 = commit({ subject: 'prev PR B (#2)', trailer: PREV.slice(0, 12), committer: GITHUB, at: DURING_SESSION });
    const s2 = commit({ subject: 'shell commit last week', at: BEFORE_SESSION });
    // Ours: cut from the seed, one commit of our own branch's history.
    git(['checkout', '-q', '-b', 'mine', `${s0}~1`]);
    const m0 = commit({ subject: 'branch history', at: BEFORE_SESSION });
    // The mid-turn checkout.
    git(['checkout', '-q', '--detach', 'main']);
    return { s0, s1, s2, m0 };
  }

  it('credits NOTHING on main to a session that only checked it out', () => {
    const { m0 } = divergeOntoMain();
    const s = state({ headShaAtStart: m0 });

    expect(ownedRangeCommitShas(repo, s)).toEqual([]);

    // The consumer that showed +6634: the session header's snapshot.
    const snap = sessionAuthoredSnapshot(repo, s);
    expect(snap.source).toBe('none');
    expect(snap.commitShas).toEqual([]);
    expect(snap.linesAdded).toBe(0);
    expect(snap.filesChanged).toEqual([]);
  });

  it('still credits the commit the session itself makes after the checkout', () => {
    const { m0 } = divergeOntoMain();
    const ours = commit({ subject: 'our work on top of main', trailer: OURS.slice(0, 12), at: DURING_SESSION });
    const s = state({ headShaAtStart: m0 });

    expect(ownedRangeCommitShas(repo, s)).toEqual([ours]);
    const snap = sessionAuthoredSnapshot(repo, s);
    expect(snap.source).toBe('trailer');
    expect(snap.commitShas).toEqual([ours]);
    expect(snap.filesChanged).toEqual(['f6.txt']);
  });

  describe('commitBelongsToSession — the two rules', () => {
    it("refuses an untrailered local commit committed before the session started", () => {
      const sha = commit({ subject: 'pulled: my own shell commit from yesterday', at: BEFORE_SESSION });
      expect(commitBelongsToSession(repo, sha, state(), LOCAL)).toBe(false);
    });

    it('keeps an untrailered local commit made during the session (hook-missed commit)', () => {
      const sha = commit({ subject: 'sandboxed codex commit', at: DURING_SESSION });
      expect(commitBelongsToSession(repo, sha, state(), LOCAL)).toBe(true);
    });

    it("refuses the previous session's squash-merged PR (GitHub committed it)", () => {
      const sha = commit({ subject: 'prev PR (#3)', trailer: PREV.slice(0, 12), committer: GITHUB, at: DURING_SESSION });
      expect(commitBelongsToSession(repo, sha, state(), LOCAL)).toBe(false);
    });

    it("refuses the previous session's own commit from before we started", () => {
      const sha = commit({ subject: 'prev worked here', trailer: PREV.slice(0, 12), at: BEFORE_SESSION });
      expect(commitBelongsToSession(repo, sha, state(), LOCAL)).toBe(false);
    });

    it('keeps a chained commit: local, during the session, previous session not live', () => {
      // The case the chain rule exists for — prepare-commit-msg trailered our
      // commit with the id of the session we chained from.
      const sha = commit({ subject: 'ours, trailered to the chained id', trailer: PREV.slice(0, 12), at: DURING_SESSION });
      expect(commitBelongsToSession(repo, sha, state(), LOCAL)).toBe(true);
    });

    it('refuses a chained commit when the previous session is still live in this repo', () => {
      fs.writeFileSync(
        path.join(repo, '.git', `origin-session-${PREV.slice(0, 12)}.json`),
        JSON.stringify({ sessionId: PREV, sessionTag: PREV.slice(0, 12), repoPath: repo, sessionCommitShas: [] }),
      );
      const sha = commit({ subject: 'the live sibling committed this', trailer: PREV.slice(0, 12), at: DURING_SESSION });
      expect(commitBelongsToSession(repo, sha, state(), LOCAL)).toBe(false);
    });

    it('a trailer naming THIS session is decisive regardless of date or committer', () => {
      // A squash-merge of our own PR, pulled in: GitHub committed it, but the
      // trailer is ours and supersession handles the rewrite.
      const sha = commit({ subject: 'our PR (#4)', trailer: OURS.slice(0, 12), committer: GITHUB, at: DURING_SESSION });
      expect(commitBelongsToSession(repo, sha, state(), LOCAL)).toBe(true);
    });

    it('does not apply the date guard when the state has no startedAt', () => {
      const sha = commit({ subject: 'old but who knows', at: BEFORE_SESSION });
      expect(commitBelongsToSession(repo, sha, state({ startedAt: undefined }), LOCAL)).toBe(true);
    });
  });
});
