/**
 * Inherited lines that git will not merge are still one tree — built file by
 * file.
 *
 * A turn that checks out a PR branch and then merges main inherits two lines.
 * #1650 names the tree the turn started from by merging them (`combineTips`),
 * but that merge is not always there: a conflict with no side to take, git
 * older than `merge-tree --write-tree`, or — the ordinary one — more commits
 * in the merged-in line than the walk budget allows. Each fell back to the
 * newest line BY DATE, and every file only the other line touched read at a
 * tree that predates it.
 *
 * Here main has moved on by 301 commits, so the budget trips. The PR is the
 * newer line; main's last commit changed turn-diff.ts. Taken at the PR's tree,
 * turn-diff.ts is as it was before main touched it, and the write the merge
 * made to it is the turn's — the write-journal's before-state, the write
 * backfill and the shell window all measure from that one sha.
 *
 * The file-by-file tree also depends on reading a merge correctly. A merge's
 * changed-file list names everything it brought in, so turn-diff.ts looked
 * "resolved by the turn's own merge" and was left at the turn's start. git
 * merged it cleanly; only the paths git could not merge are the turn's.
 *
 * Driven against real git through the same wiring Stop, session-end and the
 * heartbeat use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inheritedBaselineForTurn, inheritedBeforeStatesForTurn } from '../commands/hooks.js';

const SESSION = 'c5487aa9-8594-4af0-9bc3-42aafd775cc7';
const EARLIER_TURN = 't_earlier';
const TURN = 't_checked_out_then_merged_busy_main';
const PR_FILE = 'packages/cli/src/__tests__/capture-e2e-codex-native-resume.test.ts';
const MAIN_FILE = 'packages/cli/src/turn-diff.ts';

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';

const at = (iso: string) => ({ GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso });

function foreignCommit(message: string, trailer: string, iso: string, email = 'dev@test.dev'): string {
  git(['add', '-A']);
  git(['commit', '-q', '-m', `${message}\n\nOrigin-Session: ${trailer} | Codex | 30 prompts`], {
    ...at(iso), GIT_COMMITTER_EMAIL: email,
  });
  return git(['rev-parse', 'HEAD']);
}

function shadowOf(ref: string): string {
  const tree = git(['rev-parse', `${ref}^{tree}`]);
  return git(['commit-tree', tree, '-p', ref, '-m', 'origin shadow prompt-1']);
}

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'no-combine-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'no-combine-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
  write('README.md', 'seed\n');
  write(MAIN_FILE, lines(4, 'turnDiff'));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'seed'], at('2026-09-14T12:00:00Z'));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function stateFor(shadow: string, own: string[]) {
  return {
    sessionId: SESSION, sessionTag: 'fb6151ba-bf4', repoPath: repo, lastCwd: repo,
    startedAt: '2026-09-14T23:56:45.000Z',
    prompts: ['earlier', 'review and merge 1642'],
    promptTurnIds: [EARLIER_TURN, TURN],
    promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
    sessionCommitShas: own,
    commitTurns: own.map((sha) => ({ sha, turnId: TURN })),
  } as any;
}

/**
 * Checks out another session's PR (which creates PR_FILE), merges a main that
 * moved on by `mainCommits` commits (the last changing MAIN_FILE), and makes
 * its own commit on top.
 */
function checkoutThenMergeBusyMain(mainCommits: number) {
  const base = git(['rev-parse', 'HEAD']);

  // main moves on: `mainCommits - 1` commits that touch nothing the turn does,
  // then one that changes MAIN_FILE. GitHub committed all of them.
  // One fast-import process rather than hundreds of commit-tree spawns: the
  // fixture is about the count, and a slow one flakes under a loaded suite.
  const when = Math.floor(Date.parse('2026-09-15T00:05:00Z') / 1000);
  let stream = '';
  for (let i = 0; i < mainCommits - 1; i++) {
    const msg = `chore: main ${i}\n\nOrigin-Session: 02fb5c9e-e80 | Codex | 30 prompts\n`;
    stream += `commit refs/heads/upstream\ncommitter GitHub <noreply@github.com> ${when} +0000\n`
      + `data ${Buffer.byteLength(msg)}\n${msg}` + (i === 0 ? `from ${base}\n` : '') + '\n';
  }
  if (stream) execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: stream, stdio: ['pipe', 'pipe', 'pipe'] });
  else git(['branch', 'upstream', base]);
  git(['checkout', '-q', 'upstream']);
  write(MAIN_FILE, lines(4, 'turnDiff') + lines(8, 'fromMain'));
  const mainTip = foreignCommit('fix(capture): editsJson', '02fb5c9e-e80', '2026-09-15T00:09:52Z', 'noreply@github.com');
  git(['update-ref', 'refs/remotes/origin/main', mainTip]);

  // Another session's PR — the NEWER line by date.
  git(['checkout', '-q', '-b', 'pr-1642', base]);
  write(PR_FILE, lines(63, 'resume'));
  const pr = foreignCommit('fix(codex): resume the exact native conversation', 'f53bd03d-2fd', '2026-09-15T00:25:49Z');

  git(['checkout', '-q', 'main']);
  git(['branch', '-q', '-D', 'upstream']);

  // ── the turn ──
  const shadow = shadowOf('main');
  git(['checkout', '-q', '-b', 'review/pr-1642', pr]);
  git(['merge', '-q', '--no-ff', '--no-edit', 'origin/main',
    '-m', `Merge origin/main\n\nOrigin-Session: ${SESSION.slice(0, 12)} | Claude Code | 2 prompts`],
  at('2026-09-15T00:56:07Z'));
  const merge = git(['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(repo, PR_FILE), 'const added = true;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', `fix: ENOTEMPTY\n\nOrigin-Session: ${SESSION.slice(0, 12)} | Claude Code | 2 prompts`],
    at('2026-09-15T00:56:27Z'));
  const ours = git(['rev-parse', 'HEAD']);
  return { shadow, merge, ours, pr, mainTip };
}

const show = (rev: string, f: string): string | null => {
  try { return execFileSync('git', ['show', `${rev}:${f}`], { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }); }
  catch { return null; }
};

describe('inherited lines git will not merge', () => {
  it('the tree the turn started from holds both lines, not the newer one alone', () => {
    const { shadow, merge, ours, pr, mainTip } = checkoutThenMergeBusyMain(301);
    const state = stateFor(shadow, [merge, ours]);

    const inherited = inheritedBaselineForTurn(repo, state, shadow, 1);

    expect(inherited).toBeTruthy();
    // Newest by date is the PR — and its tree never saw main's change.
    expect(inherited).not.toBe(pr);
    expect(show(inherited!, PR_FILE)).toBe(show(pr, PR_FILE));
    expect(show(inherited!, MAIN_FILE)).toBe(show(mainTip, MAIN_FILE));
  });

  it('the write journal\'s before-states read each file where its line left it', () => {
    const { shadow, merge, ours, pr, mainTip } = checkoutThenMergeBusyMain(301);
    const state = stateFor(shadow, [merge, ours]);

    const before = inheritedBeforeStatesForTurn(repo, state, shadow, 1);

    // The merge rewrote MAIN_FILE on disk. Its before-state must be main's, or
    // the eight lines main added are journalled as the turn's.
    expect(before.get(MAIN_FILE)).toBe(show(mainTip, MAIN_FILE));
    expect(before.get(PR_FILE)).toBe(show(pr, PR_FILE));
  });

  it('a line under the budget still combines the ordinary way', () => {
    const { shadow, merge, ours, pr, mainTip } = checkoutThenMergeBusyMain(3);
    const state = stateFor(shadow, [merge, ours]);

    const inherited = inheritedBaselineForTurn(repo, state, shadow, 1);

    expect(git(['log', '-1', '--format=%s', inherited!])).toBe('origin inherited lines');
    expect(show(inherited!, PR_FILE)).toBe(show(pr, PR_FILE));
    expect(show(inherited!, MAIN_FILE)).toBe(show(mainTip, MAIN_FILE));
  });
});
