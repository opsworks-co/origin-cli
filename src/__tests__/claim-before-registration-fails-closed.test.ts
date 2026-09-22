/**
 * The claim has exactly one fail-open hazard, and it is the expensive one.
 *
 * Before taking a commit the walk asks which shas the OTHER live sessions in
 * this tree already own. If that lookup throws and the answer is read as an
 * empty list, it does not mean "nobody owns anything" — it means we do not
 * know, and the walk would then happily take a commit another session made.
 * On a shared checkout that is a stranger's work billed to us, which is worse
 * than the gap the claim closes.
 *
 * This lives in its own file because it has to mock the peer lookup, and the
 * real-git suite deliberately uses the real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { listSessionsForGitHookUnscoped } = vi.hoisted(() => ({
  listSessionsForGitHookUnscoped: vi.fn(),
}));

vi.mock('../commands/hooks/post-commit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/hooks/post-commit.js')>();
  return { ...actual, listSessionsForGitHookUnscoped };
});

import { claimCommitsMadeBeforeRegistration, gitErrorIsAnAnswer } from '../claim-commits-made-before-registration.js';

let repo: string;
const git = (args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', windowsHide: true }).toString().trim();

const SESSION = 'd74b8927-38a2-4e84-96af-f6605c94599f';
const freshState = () => ({ startedAt: new Date(Date.now() - 60_000).toISOString(), sessionCommitShas: [] as string[] });
/** The file the blind-window commit below touches — the claim needs file
 *  evidence from the transcript before any other signal matters. */
const SEEN_EDITED = ['a.txt'];

beforeEach(() => {
  vi.clearAllMocks();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-claim-closed-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  git(['add', '-A']);
  execFileSync('git', ['commit', '-m', 'chore: seed'], {
    cwd: repo, encoding: 'utf-8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: longAgo, GIT_COMMITTER_DATE: longAgo },
  });
  // The commit in the blind window — claimable whenever peers ARE readable.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(['add', '-A']);
  git(['commit', '-m', 'feat: made before registration']);
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('an unreadable peer list must fail CLOSED', () => {
  it('claims nothing when the peer lookup throws', () => {
    listSessionsForGitHookUnscoped.mockImplementation(() => {
      throw new Error('state dir unreadable');
    });
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, SEEN_EDITED)).toEqual([]);
    expect(listSessionsForGitHookUnscoped).toHaveBeenCalledWith(repo, { failOnReadError: true });
  });

  it('claims the same commit once the peer lookup works — so the case above is the LOOKUP, not the fixture', () => {
    // Without this, the test above would pass on a fixture that never had
    // anything to claim in the first place.
    listSessionsForGitHookUnscoped.mockReturnValue([]);
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, SEEN_EDITED)).toHaveLength(1);
  });

  it('declines a commit a peer session already owns', () => {
    const head = git(['rev-parse', 'HEAD']);
    listSessionsForGitHookUnscoped.mockReturnValue([
      { sessionId: 'another-session', sessionCommitShas: [head], commitTurns: [] },
    ]);
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, SEEN_EDITED)).toEqual([]);
  });

  it('ignores OUR OWN row in the peer list', () => {
    const head = git(['rev-parse', 'HEAD']);
    listSessionsForGitHookUnscoped.mockReturnValue([
      { sessionId: SESSION, sessionCommitShas: [head], commitTurns: [] },
    ]);
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, SEEN_EDITED)).toEqual([head]);
  });

  it('reads a peer that records the sha only under commitTurns', () => {
    const head = git(['rev-parse', 'HEAD']);
    listSessionsForGitHookUnscoped.mockReturnValue([
      { sessionId: 'another-session', sessionCommitShas: [], commitTurns: [{ sha: head }] },
    ]);
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, SEEN_EDITED)).toEqual([]);
  });
});

describe('a git probe that cannot RUN must not read as "no"', () => {
  // The full CLI suite caught this. git calls here run under heavy parallel
  // load — the vitest config raises its own testTimeout to 30s saying so — and
  // the probe collapsed "git exited non-zero" (an ANSWER: no note) together
  // with "git could not be run" (not an answer), returning '' for both. An
  // unreadable note then read as "no note" and the walk claimed a commit that
  // another machine had already recorded.
  //
  // A PATH-based "no git at all" test does NOT pin this: with every command
  // failing, `git log` returns nothing, the walk has no candidates and claims
  // nothing whatever the note logic does — it passes for the wrong reason, and
  // all four mutations of the fail-closed branches survived it. The failure
  // has to be per-COMMAND, so the runner is injected.
  const HEAD_SHA = 'a'.repeat(40);
  const NOW = new Date().toISOString();

  const US = 'agent@example.com';
  const EDITED = ['src/thing.ts'];
  /** Date, committer and body now arrive from ONE `git log -1`, NUL-separated. */
  const metaOut = (email = US, author = US, body = 'feat: no trailer\n') => `${NOW}\x1f${email}\x1f${author}\x1f${body}`;
  const isMetaRead = (args: string[]) =>
    args[0] === 'log' && args.some((a) => a.startsWith('--format=%cI'));
  /** The file-list read. Matched on `--name-only`, NOT on the word `show`:
   *  `git notes --ref=origin show <sha>` contains that word too, and matching
   *  it here answered the note probe with a file list. */
  const isFileList = (args: string[]) => args.includes('--name-only');

  /** A runner that works normally except for the commands `fail` matches. */
  function runnerFailing(fail: (args: string[]) => boolean) {
    return (args: string[]) => {
      if (fail(args)) return { ok: false, out: '' };
      if (args[0] === 'config') return { ok: true, out: `${US}\n` };
      if (args[0] === 'log' && args.includes('--format=%H')) {
        return { ok: true, out: `${HEAD_SHA}\n` };
      }
      if (isMetaRead(args)) return { ok: true, out: metaOut() };
      if (isFileList(args)) return { ok: true, out: `${EDITED[0]}\n` };
      if (args[0] === 'notes') return { ok: true, out: '' };   // exits 1 = no note
      return { ok: true, out: '' };
    };
  }
  const run = (fail: (args: string[]) => boolean) =>
    claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED, runnerFailing(fail));

  beforeEach(() => listSessionsForGitHookUnscoped.mockReturnValue([]));

  it('claims the commit when every probe answers', () => {
    // The control. Without it the cases below could pass on a fixture that was
    // never claimable in the first place.
    expect(run(() => false)).toEqual([HEAD_SHA]);
  });

  it('declines when the NOTE read could not run', () => {
    expect(run((a) => a[0] === 'notes')).toEqual([]);
  });

  it('declines when the commit METADATA read could not run', () => {
    // Date, committer and body are one `git log -1` now. An unreadable body
    // would drop the trailer and read as untrailered; an unreadable date
    // leaves the walk not knowing where in time it is; an unreadable committer
    // leaves it unable to ask whose commit this is.
    expect(run(isMetaRead)).toEqual([]);
  });

  it('declines when the FILE LIST could not be read', () => {
    // Without the files there is no evidence the commit is ours at all — the
    // remaining signals only say nobody has recorded it yet.
    expect(run(isFileList)).toEqual([]);
  });

  it('declines when our own committer identity could not be read', () => {
    // "Somebody else committed this" is unanswerable without knowing who we
    // commit as, and an unanswerable question is not a yes.
    expect(run((a) => a[0] === 'config')).toEqual([]);
  });

  it('a clean non-zero exit from `git notes` IS an answer — no note', () => {
    // The distinction that makes the above safe rather than merely timid: an
    // absent note must still allow the claim, or nothing is ever claimable.
    const claimed = claimCommitsMadeBeforeRegistration(
      repo, freshState(), SESSION, EDITED,
      (args) => (args[0] === 'notes'
        ? { ok: true, out: '' }
        : runnerFailing(() => false)(args)),
    );
    expect(claimed).toEqual([HEAD_SHA]);
  });

  it('declines a commit somebody ELSE committed, however unowned it looks', () => {
    // The pulled-teammate case. No note, no trailer, no live peer, inside the
    // window, and touching a file we edited — every signal this walk had
    // before said take it.
    const claimed = claimCommitsMadeBeforeRegistration(
      repo, freshState(), SESSION, EDITED,
      (args) => (isMetaRead(args)
        ? { ok: true, out: metaOut('teammate@example.com', 'teammate@example.com') }
        : runnerFailing(() => false)(args)),
    );
    expect(claimed).toEqual([]);
  });

  it('declines a commit we replayed but did not author', () => {
    const claimed = claimCommitsMadeBeforeRegistration(
      repo, freshState(), SESSION, EDITED,
      (args) => (isMetaRead(args)
        ? { ok: true, out: metaOut(US, 'teammate@example.com') }
        : runnerFailing(() => false)(args)),
    );
    expect(claimed).toEqual([]);
  });

  it('declines a commit over files this conversation was never seen to edit', () => {
    // The human's own `git commit -m wip` in the same window.
    const claimed = claimCommitsMadeBeforeRegistration(
      repo, freshState(), SESSION, EDITED,
      (args) => (isFileList(args)
        ? { ok: true, out: 'docs/THEIR_NOTES.md\n' }
        : runnerFailing(() => false)(args)),
    );
    expect(claimed).toEqual([]);
  });

  it('claims nothing at all when the transcript recorded no edits', () => {
    expect(
      claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, [], runnerFailing(() => false)),
    ).toEqual([]);
  });

  it('stops probing once the budget is spent', () => {
    // The walk runs on the prompt-submit hook's critical path. Past its
    // wall-clock budget the stream ends and nothing more is claimed.
    const claimed = claimCommitsMadeBeforeRegistration(
      repo, freshState(), SESSION, EDITED, runnerFailing(() => false), -1,
    );
    expect(claimed).toEqual([]);
  });
});

describe('gitErrorIsAnAnswer — which git failures are a "no"', () => {
  it('a clean non-zero exit is an answer (git notes show: no note)', () => {
    expect(gitErrorIsAnAnswer({ status: 1 })).toBe(true);
    expect(gitErrorIsAnAnswer({ status: 128 })).toBe(true);
  });

  it('a timeout or kill is NOT an answer', () => {
    // execFileSync on timeout: status null, signal set.
    expect(gitErrorIsAnAnswer({ status: null, signal: 'SIGTERM' })).toBe(false);
    expect(gitErrorIsAnAnswer({ signal: 'SIGKILL' })).toBe(false);
    // A status alongside a signal is still a kill.
    expect(gitErrorIsAnAnswer({ status: 1, signal: 'SIGTERM' })).toBe(false);
  });

  it('a spawn failure (no git on PATH) is NOT an answer', () => {
    expect(gitErrorIsAnAnswer({ status: undefined })).toBe(false);
    expect(gitErrorIsAnAnswer(null)).toBe(false);
    expect(gitErrorIsAnAnswer(undefined)).toBe(false);
  });
});

describe('a failed probe that still produced output is not trusted', () => {
  // execFileSync surfaces whatever the child wrote before it was killed, so a
  // timed-out `git log --format=%cI` can hand back a perfectly valid date with
  // ok:false. The date must still be refused, or the time bound — the only
  // thing keeping the walk out of the repo's history — is decided by a probe
  // that did not finish.
  const HEAD_SHA = 'b'.repeat(40);
  const NOW = new Date().toISOString();

  it('declines a VALID date that came back from a failed call', () => {
    listSessionsForGitHookUnscoped.mockReturnValue([]);
    const claimed = claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, ['src/thing.ts'], (args) => {
      if (args[0] === 'config') return { ok: true, out: 'agent@example.com\n' };
      if (args[0] === 'log' && args.includes('--format=%H')) return { ok: true, out: `${HEAD_SHA}\n` };
      // A timed-out metadata read that still handed back a valid date.
      if (args[0] === 'log') return { ok: false, out: `${NOW}\x1fagent@example.com\x1fagent@example.com\x1ffeat: no trailer\n` };
      if (args.includes('--name-only')) return { ok: true, out: 'src/thing.ts\n' };
      return { ok: true, out: '' };
    });
    expect(claimed).toEqual([]);
  });
});
