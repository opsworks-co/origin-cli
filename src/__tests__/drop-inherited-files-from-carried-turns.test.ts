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
import { filesRestoredFromHistory } from '../restored-from-history.js';

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

// ─── Files a turn only restored from history (session 874ff028) ────────────
//
// A pathspec checkout of an OLDER commit and its later restoration bring no
// commit into either window, so inheritedFiles answers nothing for them.

describe('a turn that only put files back to versions history already had', () => {
  let older: string;
  /** main = base -> the other session's PR (#1676), as in the incident. */
  function mergedPr() {
    older = git(['rev-parse', 'HEAD']);
    git(['merge', '-q', '--ff-only', upstream]);
  }
  const runWithHistory = (state: any, rows: InheritedFilesRow[], authored: string[] = []) =>
    dropInheritedFilesFromTurns(state, rows, {
      inheritedFiles: (from, to, local) => inheritedFilesForTurn(repo, state, from, to, local),
      authoredFiles: () => new Set(authored),
      restoredFromHistory: (from, to, _local, files) => filesRestoredFromHistory(repo, from, to, files),
    });

  it('drops the removal: a pathspec checkout of an older commit straddling the boundary', () => {
    mergedPr();
    write('a.ts', 'a1\nmine\n');
    const s0 = boundary(0, 'turn0');
    git(['add', '-A']); git(['commit', '-qm', 'wip']);
    git(['checkout', older, '--', 'b.ts', 'c.ts']);
    const s1 = boundary(1, 'turn1');
    const row: InheritedFilesRow = {
      promptIndex: 0,
      filesChanged: ['b.ts', 'c.ts'],
      diff: `${git(['diff', s0.shadowSha, s1.shadowSha, '--', 'b.ts', 'c.ts'])}\n`,
    };

    // Without the history test, nothing names these files.
    expect(run(stateFor([s0, s1]), [{ ...row }])).toBe(0);
    expect(runWithHistory(stateFor([s0, s1]), [row])).toBe(1);
    expect(row.filesChanged).toEqual([]);
    expect(row.chatOnly).toBe(true);
    expect(row.inheritedFiles).toEqual(['b.ts', 'c.ts']);
  });

  it('drops the mirror: the restoration in the next turn, still in flight', () => {
    mergedPr();
    write('a.ts', 'a1\nmine\n');
    git(['add', '-A']); git(['commit', '-qm', 'wip']);
    git(['checkout', older, '--', 'b.ts', 'c.ts', 'a.ts']);
    const s0 = boundary(0, 'turn0');
    git(['checkout', 'HEAD', '--', '.']);
    git(['reset', '-q', '--soft', 'HEAD~1']);
    git(['reset', '-q']);
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: ['a.ts', 'b.ts', 'c.ts'], diff: '' };

    // The turn has no next shadow: its end is the live working tree.
    expect(runWithHistory({ ...stateFor([s0]), prompts: ['explain'] }, [row])).toBe(1);
    expect(row.filesChanged).toEqual([]);
    expect(row.inheritedFiles).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('keeps a file the turn authored, even when its bytes are an older version (an Edit-tool revert)', () => {
    mergedPr();
    const s0 = boundary(0, 'turn0');
    write('b.ts', 'b1\n');
    const s1 = boundary(1, 'turn1');
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: ['b.ts'], diff: `${git(['diff', s0.shadowSha, s1.shadowSha])}\n` };

    expect(runWithHistory(stateFor([s0, s1]), [row], ['b.ts'])).toBe(0);
    expect(row.filesChanged).toEqual(['b.ts']);
  });

  it('drops a shell-only revert with no authorship evidence (accepted: it looks like the background job)', () => {
    mergedPr();
    const s0 = boundary(0, 'turn0');
    git(['checkout', 'HEAD~1', '--', 'b.ts']);
    const s1 = boundary(1, 'turn1');
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: ['b.ts'], diff: `${git(['diff', s0.shadowSha, s1.shadowSha])}\n` };

    expect(runWithHistory(stateFor([s0, s1]), [row])).toBe(1);
    expect(row.filesChanged).toEqual([]);
  });

  it('keeps work a LATER turn committed: history is read from the window start, not HEAD', () => {
    const s0 = boundary(0, 'turn0');
    write('a.ts', 'a1\nwritten by a shell command\n');
    write('new.ts', 'brand new\n');
    const s1 = boundary(1, 'turn1');
    git(['add', '-A']); git(['commit', '-qm', 'the next turn commits it']);
    const s2 = boundary(2, 'turn2');
    const row: InheritedFilesRow = {
      promptIndex: 0,
      filesChanged: ['a.ts', 'new.ts'],
      diff: `${git(['diff', s0.shadowSha, s1.shadowSha])}\n`,
    };

    expect(runWithHistory(stateFor([s0, s1, s2]), [row])).toBe(0);
    expect(row.filesChanged).toEqual(['a.ts', 'new.ts']);
    expect(filesRestoredFromHistory(repo, s0.shadowSha, s1.shadowSha, ['a.ts', 'new.ts']).size).toBe(0);
  });

  it('answers nothing for a checkout of a NEWER commit (the c5487aa9 shape stays with inheritedFiles)', () => {
    const s0 = boundary(0, 'turn0');
    git(['checkout', '-q', '--detach', upstream]);
    const s1 = boundary(1, 'turn1');
    expect(filesRestoredFromHistory(repo, s0.shadowSha, s1.shadowSha, ['b.ts', 'c.ts']).size).toBe(0);
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: ['b.ts', 'c.ts'] };
    expect(runWithHistory(stateFor([s0, s1]), [row])).toBe(1);
    expect(row.inheritedFiles).toEqual(['b.ts', 'c.ts']);
  });

  it('ends a closed turn at the tree its Stop recorded, not at the next prompt', () => {
    mergedPr();
    const s0 = boundary(0, 'turn0');
    write('a.ts', 'a1\nmine\n');
    const end = boundary(0, 'turn0-end');
    git(['checkout', older, '--', 'b.ts']);
    const s1 = boundary(1, 'turn1');
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: ['a.ts', 'b.ts'] };
    const state = { ...stateFor([s0, s1]), turnEndShadows: [{ promptIndex: 0, shadowSha: end.shadowSha, capturedAt: '' }] };
    const seen: Array<string | null> = [];
    dropInheritedFilesFromTurns(state, [row], {
      inheritedFiles: (_from, to) => { seen.push(to); return new Set(); },
      authoredFiles: () => new Set(['a.ts']),
      restoredFromHistory: (from, to, _l, files) => { seen.push(to); return filesRestoredFromHistory(repo, from, to, files); },
    });
    expect(seen).toEqual([end.shadowSha, end.shadowSha]);
  });
});
