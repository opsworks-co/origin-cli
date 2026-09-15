/**
 * An earlier turn's saved row keeps only what that turn wrote. Driven against
 * real git.
 *
 * Session c5487aa9 turn 3 ran `git checkout --detach origin/main` (#1642) and
 * wrote nothing. A re-Stop saved it as 5 of #1642's files; #1648 stopped new
 * rows going wrong, but every later Stop re-sent the saved one, because
 * nothing re-checks an earlier turn's row and the shadow-window pass declines
 * a contended tree and a window spanning inherited commits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit } from '../git-capture.js';
import { dropInheritedFilesFromTurns, type InheritedFilesRow } from '../drop-inherited-files.js';
import { inheritedFilesForTurn } from '../commands/hooks.js';

let repo: string;
let upstream: string;
const git = (args: string[], env: Record<string, string> = {}) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

/** A turn boundary the way the hooks record one. */
function boundary(promptIndex: number, tag: string) {
  const shadow = createShadowCommit(repo, tag);
  return shadow
    ? { promptIndex, shadowSha: shadow }
    : { promptIndex, shadowSha: git(['rev-parse', 'HEAD']), completeBaseline: true };
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-carried-rows-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'me@example.com']);
  git(['config', 'user.name', 'Me']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
  write('a.ts', 'a1\n'); write('b.ts', 'b1\n'); write('c.ts', 'c1\n');
  git(['add', '-A']); git(['commit', '-qm', 'base']);
  // Another session's PR, squash-merged on GitHub.
  git(['checkout', '-qb', 'upstream']);
  write('b.ts', 'b1\nb2 upstream\n'); write('c.ts', 'c1\nc2 upstream\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'fix(codex): another PR (#1642)\n\nOrigin-Session: f53bd03d-2fd | Codex | 31 prompts'], {
    GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
  });
  upstream = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', 'main']);
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

const section = (file: string, from: string) => `${git(['diff', from, upstream, '--', file])}\n`;

function stateFor(shadows: any[], extra: Record<string, unknown> = {}) {
  return {
    sessionId: '11111111-2222-4333-8444-555555555555',
    repoPath: repo,
    prompts: ['go ahead', 'next'],
    promptTurnIds: ['t_0', 't_1'],
    promptShadows: shadows,
    commitTurns: [],
    sessionCommitShas: [],
    ...extra,
  } as any;
}

function run(state: any, rows: InheritedFilesRow[], authored: string[] = []) {
  return dropInheritedFilesFromTurns(state, rows, {
    inheritedFiles: (from, to, local) => inheritedFilesForTurn(repo, state, from, to, local),
    authoredFiles: () => new Set(authored),
  });
}

describe('a closed turn that only checked out another PR', () => {
  it('goes out empty instead of carrying the PR', () => {
    const s0 = boundary(0, 'turn0');
    const base = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '--detach', upstream]);
    const s1 = boundary(1, 'turn1');
    const row: InheritedFilesRow = {
      promptIndex: 0,
      filesChanged: ['b.ts', 'c.ts'],
      diff: section('b.ts', base) + section('c.ts', base),
      linesAdded: 2, linesRemoved: 0,
    };

    expect(run(stateFor([s0, s1]), [row])).toBe(1);

    expect(row.filesChanged).toEqual([]);
    expect(row.diff?.trim()).toBe('');
    expect([row.linesAdded, row.linesRemoved]).toEqual([0, 0]);
    expect(row.chatOnly).toBe(true);
    expect(row.contentAuthoritative).toBe(true);
    expect(row.inheritedFiles).toEqual(['b.ts', 'c.ts']);
  });
});

describe('what the turn wrote stays', () => {
  it('keeps its own file and a file it edited on top of the checkout', () => {
    const s0 = boundary(0, 'turn0');
    const base = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '--detach', upstream]);
    write('a.ts', 'a1\na2 mine\n');
    write('b.ts', 'b1\nb2 upstream\nb3 mine\n');
    const s1 = boundary(1, 'turn1');
    const row: InheritedFilesRow = {
      promptIndex: 0,
      filesChanged: ['a.ts', 'b.ts', 'c.ts'],
      diff: `${git(['diff', base, s1.shadowSha, '--', 'a.ts', 'b.ts'])}\n${section('c.ts', base)}`,
    };

    expect(run(stateFor([s0, s1]), [row])).toBe(1);

    expect(row.filesChanged).toEqual(['a.ts', 'b.ts']);
    expect(row.diff).toContain('+a2 mine');
    expect(row.diff).toContain('+b3 mine');
    expect(row.diff).not.toContain('c2 upstream');
    expect(row.chatOnly).toBeUndefined();
    expect(row.inheritedFiles).toEqual(['c.ts']);
  });

  it('keeps an inherited-looking file the turn shows it authored', () => {
    const s0 = boundary(0, 'turn0');
    const base = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '--detach', upstream]);
    const s1 = boundary(1, 'turn1');
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: ['b.ts', 'c.ts'], diff: section('b.ts', base) + section('c.ts', base) };

    run(stateFor([s0, s1]), [row], ['c.ts']);

    expect(row.filesChanged).toEqual(['c.ts']);
  });

  it('leaves a turn alone whose window holds only its own commit', () => {
    const s0 = boundary(0, 'turn0');
    write('c.ts', 'c1\nc2 mine\n');
    git(['add', '-A']); git(['commit', '-qm', 'mine']);
    const s1 = boundary(1, 'turn1');
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: ['c.ts'], diff: `${git(['diff', 'HEAD~1', 'HEAD'])}\n` };

    expect(run(stateFor([s0, s1]), [row])).toBe(0);
    expect(row.filesChanged).toEqual(['c.ts']);
    expect(row.contentAuthoritative).toBeUndefined();
  });

  it('leaves the turn still in flight to its own capture', () => {
    const s0 = boundary(0, 'turn0');
    git(['checkout', '-q', '--detach', upstream]);
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: ['b.ts', 'c.ts'] };

    expect(run(stateFor([s0]), [row])).toBe(0);
    expect(row.filesChanged).toEqual(['b.ts', 'c.ts']);
  });
});
