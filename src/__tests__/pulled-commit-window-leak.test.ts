/**
 * A rebase is not authorship.
 *
 * The shell-write window is `baseline..working-tree`, which answers "did the
 * repo move", not "did I write this". `mergeShasInWindow` +
 * `mergeAbsorbedFiles` already handle a `git merge`, but a REBASE or a
 * fast-forward `git pull` brings commits in with no merge commit to find — and
 * a rebase also re-parents the turn's shadow baseline onto a lineage the
 * incoming work is not in, so every file those commits touched reads as this
 * turn's writes.
 *
 * Session 3dbff831 turn 1 ran `git rebase origin/main`, which fast-forwarded
 * PR #1371 in. The turn authored a one-line version bump and was credited with
 * 3 files, +108/-22 — exactly #1371's `codex-rollout-patches.test.ts`
 * (+102/-20), `codex-watch.test.ts` (+5/-1) and the bump.
 *
 * The exclusion is per FILE and by CONTENT, because the two cases sit side by
 * side in that same rebase: #1371 changed `package.json` AND so did the turn.
 * A file the working tree still holds exactly as the foreign commit wrote it
 * is unexplainable as this turn's work; one the turn changed on top is not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { filesLeftByForeignCommits } from '../commands/hooks.js';
import type { SessionState } from '../session-state.js';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();

describe('a commit a rebase pulled in is not the turn\'s work', () => {
  let dir: string;

  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  const commit = (msg: string) => {
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', msg]);
    return gitIn(dir, ['rev-parse', 'HEAD']).trim();
  };

  const state = (overrides: Partial<SessionState> = {}): SessionState => ({
    sessionId: 'c0ffee00-1111-2222-3333-444455556666',
    sessionCommitShas: [],
    ...overrides,
  } as unknown as SessionState);

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-pulled-')));
    gitIn(dir, ['init', '-q']);
    // A local identity that does NOT match the foreign commits below, so
    // ownership is decided the way it is in production rather than by accident.
    gitIn(dir, ['config', 'user.email', 'me@local.test']);
    gitIn(dir, ['config', 'user.name', 'Me']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    write('README.md', 'seed\n');
    commit('seed');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /** A commit by someone else, trailered to a session that is not ours. */
  const foreignCommit = (msg: string): string => {
    gitIn(dir, ['add', '-A']);
    gitIn(dir, [
      '-c', 'user.email=other@elsewhere.test', '-c', 'user.name=Other',
      'commit', '-q', '-m', `${msg}\n\nOrigin-Session: 5840bf7c-316 | Claude Code | 10 prompts`,
    ]);
    return gitIn(dir, ['rev-parse', 'HEAD']).trim();
  };

  it('excludes a file the working tree still holds exactly as the pulled commit wrote it', () => {
    const baseline = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    write('src/codex-rollout-patches.test.ts', 'their work\n');
    foreignCommit('fix(cli): a stylesheet\'s hunks anchored on `}`');

    const pulled = filesLeftByForeignCommits(dir, state(), baseline);

    expect([...pulled]).toEqual(['src/codex-rollout-patches.test.ts']);
  });

  it('KEEPS a file the pulled commit touched that the turn then changed again', () => {
    // package.json: #1371 bumped it, and the turn bumped it again on top.
    // Excluding the whole commit's file list would lose the turn's real work.
    const baseline = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    write('package.json', '{"version":"0.20260831.1417"}\n');
    write('src/codex-watch.test.ts', 'their work\n');
    foreignCommit('someone else');
    // The turn's own edit, on top, uncommitted.
    write('package.json', '{"version":"0.20260831.1455"}\n');

    const pulled = filesLeftByForeignCommits(dir, state(), baseline);

    expect(pulled.has('package.json')).toBe(false);
    expect(pulled.has('src/codex-watch.test.ts')).toBe(true);
  });

  it('claims nothing when the commit in the window is the session\'s own', () => {
    const baseline = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    write('src/mine.ts', 'my work\n');
    const sha = commit('my own commit');

    const pulled = filesLeftByForeignCommits(dir, state({ sessionCommitShas: [sha] }), baseline);

    expect(pulled.size).toBe(0);
  });

  it('excludes a file the pulled commit DELETED and the turn has not recreated', () => {
    write('doomed.ts', 'bye\n');
    const baseline = commit('add doomed');
    fs.rmSync(path.join(dir, 'doomed.ts'));
    foreignCommit('they deleted it');

    const pulled = filesLeftByForeignCommits(dir, state(), baseline);

    expect(pulled.has('doomed.ts')).toBe(true);
  });

  it('is a no-op when no commit landed in the window at all', () => {
    const baseline = gitIn(dir, ['rev-parse', 'HEAD']).trim();
    write('scratch.ts', 'uncommitted work\n');

    expect(filesLeftByForeignCommits(dir, state(), baseline).size).toBe(0);
  });

  it('is a no-op on an unusable baseline rather than throwing', () => {
    expect(filesLeftByForeignCommits(dir, state(), null).size).toBe(0);
    expect(filesLeftByForeignCommits(dir, state(), 'not-a-sha').size).toBe(0);
    expect(filesLeftByForeignCommits(dir, state(), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef').size).toBe(0);
  });
});
