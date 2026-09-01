// A read-only turn that answered a question was credited with 12 files,
// +929/-32 and a "committed" badge. Prod session 97ad4482 (user-reported:
// "the prompt above didn't do any changes or commits, but origin says you
// did"). The commit — 4024a3ec, `fix(cli): keep adopted turns on their NATIVE
// prompt index` — was made three minutes earlier by session ff3ac057 running
// in the SAME checkout, and its Origin-Session trailer says so.
//
// One root cause, three symptoms, because three separate decisions in
// handleStop read `gitCapture.commitDetails` — a bare `promptBaseline..HEAD`
// range — without asking whose commits are in it:
//
//   1. the chat-only gate (`commitDetails.length === 0`), so a turn that did
//      nothing was ruled "did work" and pushed into the safety-net branch;
//   2. the filesChanged fallback for turns whose transcript shows no edits,
//      which unioned the foreign commit's file list onto the turn;
//   3. the safety net's own commit stamp, which read "a commit landed since
//      my baseline" as "I committed" and stamped HEAD.
//
// Filtering the range by ownership fixes all three at once. Ownership has to
// answer two different questions, which is why there are two tests here:
//   • Was this another SESSION's commit? — the Origin-Session trailer.
//   • Was it committed locally at all? — an untrailered commit is ours only
//     if WE committed it. A `git pull` fast-forwards other people's commits
//     into the range with no trailer at all, and treating those as ours was
//     the gap the first version of this fix still had. Found live while
//     writing it: bc7d68da, a GitHub squash-merge of an unrelated PR, landed
//     its two files on the turn that was writing the function under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dropForeignCommitsFromCapture, commitBelongsToSession, localCommitterEmail, sessionFilesFromRangeCapture } from '../commands/hooks.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const LOCAL_EMAIL = 'agent@local';

const git = (dir: string, args: string[], extraEnv: Record<string, string> = {}) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', env: { ...ENV, ...extraEnv } }).trim();

const commit = (dir: string, file: string, body: string, extraEnv: Record<string, string> = {}) => {
  fs.writeFileSync(path.join(dir, file), `export const x = '${file}';\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', body], extraEnv);
  return git(dir, ['rev-parse', 'HEAD']);
};

const MINE = 'ff3ac057-bca4-4e45-91bb-bedd01c8085e';
const THEIRS = '97ad4482-7b91-497e-a816-7ed75937b3cb';

let repo: string;
let shaOurs = '';
let shaOtherSession = '';
let shaUntrailered = '';
let shaPulled = '';

beforeAll(() => {
  // realpathSync.native: macOS hands out /var/… where git reports /private/var.
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-leak-')));
  git(repo, ['init', '-q']);
  // Real repo-level identity — the helper compares each commit's committer
  // against `git config user.email`, so it has to actually be set.
  git(repo, ['config', 'user.name', 'Local Agent']);
  git(repo, ['config', 'user.email', LOCAL_EMAIL]);

  commit(repo, 'seed.ts', 'seed');
  shaOurs = commit(repo, 'ours.ts', 'our work\n\nOrigin-Session: ff3ac057-bca | Claude Code | 4 prompts');
  shaOtherSession = commit(repo, 'theirs.ts', 'their work\n\nOrigin-Session: 97ad4482-7b9 | Claude Code | 1 prompt');
  // Untrailered but committed BY US — the sandboxed-agent case the generous
  // default exists for (our own post-commit hook never fired).
  shaUntrailered = commit(repo, 'nobody.ts', 'no trailer at all');
  // Untrailered and committed by GitHub — a squash-merge fast-forwarded in by
  // `git pull`. Authored by the same human, which is why author identity is
  // NOT the signal; the committer is.
  shaPulled = commit(repo, 'pulled.ts', 'fix(change-summary): truncate at a word boundary (#1110)', {
    GIT_COMMITTER_NAME: 'GitHub',
    GIT_COMMITTER_EMAIL: 'noreply@github.com',
  });
});

afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

// git log --reverse: oldest first, the order captureGitState builds.
const capture = () => ({
  commitShas: [shaOurs, shaOtherSession, shaUntrailered, shaPulled],
  commitDetails: [
    { sha: shaOurs, filesChanged: ['ours.ts'] },
    { sha: shaOtherSession, filesChanged: ['theirs.ts'] },
    { sha: shaUntrailered, filesChanged: ['nobody.ts'] },
    { sha: shaPulled, filesChanged: ['pulled.ts'] },
  ],
});

describe('dropForeignCommitsFromCapture', () => {
  it('drops a commit trailered to a DIFFERENT session, and reports its files', () => {
    const cap = capture();
    const foreignFiles = dropForeignCommitsFromCapture(repo, { sessionId: MINE } as any, cap);
    expect(cap.commitDetails.map((d) => d.sha)).toEqual([shaOurs, shaUntrailered]);
    expect(cap.commitShas).toEqual([shaOurs, shaUntrailered]);
    expect(foreignFiles.sort()).toEqual(['pulled.ts', 'theirs.ts']);
  });

  it('drops a pulled squash-merge even though it carries no trailer', () => {
    const cap = capture();
    const foreignFiles = dropForeignCommitsFromCapture(repo, { sessionId: MINE } as any, cap);
    expect(cap.commitDetails.some((d) => d.sha === shaPulled)).toBe(false);
    expect(foreignFiles).toContain('pulled.ts');
  });

  it('keeps an untrailered commit that WE committed — the hook may have missed ours', () => {
    const cap = capture();
    dropForeignCommitsFromCapture(repo, { sessionId: MINE } as any, cap);
    expect(cap.commitDetails.some((d) => d.sha === shaUntrailered)).toBe(true);
  });

  it('keeps a commit the post-commit hook recorded on us, whatever the trailer says', () => {
    // Amend/rebase can leave a trailer naming an id we no longer match on;
    // sessionCommitShas is the stronger signal and must win.
    const cap = capture();
    const foreignFiles = dropForeignCommitsFromCapture(
      repo, { sessionId: MINE, sessionCommitShas: [shaOtherSession] } as any, cap,
    );
    expect(cap.commitDetails.some((d) => d.sha === shaOtherSession)).toBe(true);
    expect(foreignFiles).toEqual(['pulled.ts']);
  });

  it('follows a chained session id (previousSessionId still counts as ours)', () => {
    const cap = capture();
    dropForeignCommitsFromCapture(
      repo, { sessionId: 'unrelated-0000', previousSessionId: MINE } as any, cap,
    );
    expect(cap.commitDetails.some((d) => d.sha === shaOurs)).toBe(true);
  });

  it('is a no-op on an empty capture', () => {
    const cap = { commitShas: [], commitDetails: [] };
    expect(dropForeignCommitsFromCapture(repo, { sessionId: MINE } as any, cap)).toEqual([]);
  });

  it('falls back to trailer-only when the repo has no local identity', () => {
    // A repo with no user.email gives us nothing to compare committers
    // against — better to keep a commit than to drop real work.
    const bare = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-noid-')));
    try {
      git(bare, ['init', '-q']);
      const sha = commit(bare, 'a.ts', 'untrailered', {
        GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: 'x@y',
        GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
      });
      const cap = { commitShas: [sha], commitDetails: [{ sha, filesChanged: ['a.ts'] }] };
      expect(dropForeignCommitsFromCapture(bare, { sessionId: MINE } as any, cap)).toEqual([]);
      expect(cap.commitDetails).toHaveLength(1);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

// The same predicate also gates ownedRangeCommitShas, which builds
// sessionDiff.commitShas — the list that LINKS a Commit row to a session
// server-side. That path had the trailer-only rule and nothing else, so every
// pulled commit was counted as owned: prod 97ad4482 ended up with bc7d68da, a
// GitHub squash-merge of an unrelated PR, attached to it. The read side cannot
// undo that (the server stores no committer to check), so capture time is the
// only place this is fixable.
describe('commitBelongsToSession', () => {
  it('claims our own trailered commit', () => {
    expect(commitBelongsToSession(repo, shaOurs, { sessionId: MINE } as any, LOCAL_EMAIL)).toBe(true);
  });

  it('disowns a commit trailered to another session', () => {
    expect(commitBelongsToSession(repo, shaOtherSession, { sessionId: MINE } as any, LOCAL_EMAIL)).toBe(false);
  });

  it('claims an untrailered commit WE committed (hook-missed local work)', () => {
    expect(commitBelongsToSession(repo, shaUntrailered, { sessionId: MINE } as any, LOCAL_EMAIL)).toBe(true);
  });

  it('disowns an untrailered commit GitHub committed (pulled squash-merge)', () => {
    expect(commitBelongsToSession(repo, shaPulled, { sessionId: MINE } as any, LOCAL_EMAIL)).toBe(false);
  });

  it('lets a recorded sha override a foreign trailer', () => {
    expect(commitBelongsToSession(
      repo, shaOtherSession, { sessionId: MINE, sessionCommitShas: [shaOtherSession] } as any, LOCAL_EMAIL,
    )).toBe(true);
  });

  it('keeps the generous default when no local identity is configured', () => {
    expect(commitBelongsToSession(repo, shaPulled, { sessionId: MINE } as any, '')).toBe(true);
  });

  it('keeps an unreadable sha rather than guessing work away', () => {
    expect(commitBelongsToSession(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      { sessionId: MINE } as any, LOCAL_EMAIL)).toBe(true);
  });

  it('reads the local committer identity off the repo', () => {
    expect(localCommitterEmail(repo)).toBe(LOCAL_EMAIL);
  });
});


// The range capture has a SECOND consumer with a wider blind spot: the
// session-level file list, which is what renders as "N files changed" in the
// header.
//
// `git log A..B` comes back empty whenever HEAD is not a descendant of the
// session's start sha — a branch switch, a rebase, a reset — while
// `git diff A B` still produces a full diff of two unrelated points. With no
// commits, dropForeignCommitsFromCapture returns [] meaning "nothing to
// JUDGE", not "nothing foreign"; the old code read it as the latter and
// harvested every file in the range.
//
// Prod d0cec15e, on `main` in a shared checkout:
//   23:34  session-level filesChanged  count:10  foreignDropped:2
//   23:48  session-level filesChanged  count:18  foreignDropped:0   ←
//   00:59  session-level filesChanged  count:13  foreignDropped:12
// The 18 swept in four other sessions' merged PRs, and because the server
// unions this list the leak never washed back out: the header read 26 files
// for a session whose own turns touched 12.
describe('sessionFilesFromRangeCapture', () => {
  const diffOf = (...files: string[]) =>
    files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b`).join('\n');

  it('claims nothing from a range that has no commits to attribute', () => {
    const capture = { commitDetails: [], diff: diffOf('theirs/a.ts', 'theirs/b.ts') };
    expect(sessionFilesFromRangeCapture(capture, new Set(), [])).toEqual([]);
  });

  it('still takes our own commits files when the range has commits', () => {
    const capture = {
      commitDetails: [{ filesChanged: ['mine/a.ts'] }],
      diff: diffOf('mine/a.ts'),
    };
    expect(sessionFilesFromRangeCapture(capture, new Set(), [])).toEqual(['mine/a.ts']);
  });

  it('drops a foreign commits file from the raw diff', () => {
    const capture = {
      commitDetails: [{ filesChanged: ['mine/a.ts'] }],
      diff: diffOf('mine/a.ts', 'theirs/b.ts'),
    };
    const files = sessionFilesFromRangeCapture(capture, new Set(['theirs/b.ts']), []);
    expect(files).toEqual(['mine/a.ts']);
  });

  it('keeps a file BOTH of us touched, on transcript evidence', () => {
    const capture = {
      commitDetails: [{ filesChanged: ['mine/a.ts'] }],
      diff: diffOf('mine/a.ts', 'shared/c.ts'),
    };
    const files = sessionFilesFromRangeCapture(capture, new Set(['shared/c.ts']), ['shared/c.ts']);
    expect(files.sort()).toEqual(['mine/a.ts', 'shared/c.ts']);
  });

  it('is empty on an empty capture', () => {
    expect(sessionFilesFromRangeCapture({}, new Set(), [])).toEqual([]);
  });
});
