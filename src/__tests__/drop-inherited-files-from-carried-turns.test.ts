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
import { inheritedFilesForTurn, trailerNamesSessionTurn } from '../commands/hooks.js';
import { watchedOnlyEditFiles } from '../commands/hooks/stop.js';
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

// e87a35d5 / ec55247e. Prod 6b770703 turn 29 started on an abandoned PR head
// and ran `git checkout main && git pull`; the pull brought another session's
// #1750. The window 5718d5f2c → edf6d7e88 is DIVERGENT — the start is not an
// ancestor of the end — and inheritedFilesForTurn answered nothing for any
// such window, so every fixture that moved in a straight line was green on
// the unfixed code. And the row named no files, so the pass skipped it while
// its card still carried the journal's record of the pull.
describe('a turn that leaves its PR branch for main', () => {
  function divergentTurn() {
    // The session's own PR branch, where the turn begins.
    git(['checkout', '-qb', 'my-pr']);
    write('a.ts', 'a1\na2 my pr\n');
    git(['add', '-A']); git(['commit', '-qm', 'my PR']);
    const s0 = boundary(0, 'turn0');
    // Main moved on with another session's PR, then the turn checks it out.
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--ff-only', upstream]);
    const s1 = boundary(1, 'turn1');
    return { s0, s1 };
  }
  const card = (files: string[]) => JSON.stringify({ edits: files.map((file) => ({ file, op: 'write', evidence: 'write_journal' })) });

  it('reads the commits the end side brought in, though the window is not a straight line', () => {
    const { s0, s1 } = divergentTurn();
    // The precondition that matters: git itself says the start is not an ancestor.
    expect(() => git(['merge-base', '--is-ancestor', s0.shadowSha, s1.shadowSha])).toThrow();
    const state = stateFor([s0, s1]);
    expect([...inheritedFilesForTurn(repo, state, s0.shadowSha, s1.shadowSha, 0)].sort()).toEqual(['b.ts', 'c.ts']);
  });

  it("marks the pulled files for the card on a row that names none, and leaves the row alone", () => {
    const { s0, s1 } = divergentTurn();
    const state = stateFor([s0, s1]);
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: [], diff: '' };
    const n = dropInheritedFilesFromTurns(state, [row], {
      inheritedFiles: (from, to, local) => inheritedFilesForTurn(repo, state, from, to, local),
      authoredFiles: () => new Set(),
      watchedFiles: () => watchedOnlyEditFiles(card(['b.ts', 'c.ts'])),
    });
    expect(n).toBe(1);
    expect(row.inheritedFiles).toEqual(['b.ts', 'c.ts']);
    // Its emptiness is not this pass's to decide: a shell-only turn's work
    // lives in the card.
    expect(row.chatOnly).toBeUndefined();
    expect(row.contentAuthoritative).toBeUndefined();
    expect(row.filesChanged).toEqual([]);
  });

  it('keeps a pulled file the turn shows it authored', () => {
    const { s0, s1 } = divergentTurn();
    const state = stateFor([s0, s1]);
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: [], diff: '' };
    dropInheritedFilesFromTurns(state, [row], {
      inheritedFiles: (from, to, local) => inheritedFilesForTurn(repo, state, from, to, local),
      authoredFiles: () => new Set(['c.ts']),
      watchedFiles: () => ['b.ts', 'c.ts'],
    });
    expect(row.inheritedFiles).toEqual(['b.ts']);
  });

  it('names nothing for a backward checkout — the end is the fork', () => {
    git(['checkout', '-qb', 'ahead']);
    write('b.ts', 'b1\nb2 ahead\n');
    git(['add', '-A']); git(['commit', '-qm', 'someone ahead'], { GIT_COMMITTER_EMAIL: 'x@y.z' });
    const s0 = boundary(0, 'turn0');
    git(['checkout', '-q', 'main']);
    const s1 = boundary(1, 'turn1');
    expect([...inheritedFilesForTurn(repo, stateFor([s0, s1]), s0.shadowSha, s1.shadowSha, 0)]).toEqual([]);
  });
});

describe('watchedOnlyEditFiles', () => {
  it('names only files the card holds on watched evidence', () => {
    const raw = JSON.stringify({ edits: [
      { file: 'pulled.ts', evidence: 'write_journal' },
      { file: 'probed.ts', evidence: 'command_probe' },
      { file: 'mine.ts', evidence: 'command_named' },
      { file: 'tool.ts', evidence: 'tool_call' },
      { file: 'noev.ts' },
    ] });
    expect(watchedOnlyEditFiles(raw).sort()).toEqual(['probed.ts', 'pulled.ts']);
    expect(watchedOnlyEditFiles(undefined)).toEqual([]);
    expect(watchedOnlyEditFiles('not json')).toEqual([]);
  });
});

// Independent review of the e87a35d5 fix: three ways it took a turn's real
// work. Each reproduced against the first version of the fix.
describe('what the review found the first fix took', () => {
  const nested = () => {
    fs.mkdirSync(path.join(repo, 'packages', 'api'), { recursive: true });
  };

  it("keeps root package.json when a pulled commit changed packages/api/package.json (card)", () => {
    nested();
    write('package.json', '{"root":1}\n'); write('packages/api/package.json', '{"api":1}\n');
    git(['add', '-A']); git(['commit', '-qm', 'pkgs']);
    git(['checkout', '-qb', 'theirs']);
    write('packages/api/package.json', '{"api":2}\n');
    git(['add', '-A']); git(['commit', '-qm', 'their bump'], { GIT_COMMITTER_EMAIL: 'x@y.z' });
    git(['checkout', '-q', 'main']);
    const s0 = boundary(0, 'turn0');
    write('package.json', '{"root":1,"lodash":1}\n'); // the turn's own shell edit
    git(['merge', '-q', '--ff-only', 'theirs']);
    const s1 = boundary(1, 'turn1');
    const state = stateFor([s0, s1]);
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: [], diff: '' };
    dropInheritedFilesFromTurns(state, [row], {
      inheritedFiles: (from, to, local) => inheritedFilesForTurn(repo, state, from, to, local),
      authoredFiles: () => new Set(),
      watchedFiles: () => ['package.json', 'packages/api/package.json'],
    });
    expect(row.inheritedFiles).toEqual(['packages/api/package.json']);
  });

  it('keeps root package.json in the ROW of a divergent turn', () => {
    nested();
    write('package.json', '{"root":1}\n'); write('packages/api/package.json', '{"api":1}\n');
    git(['add', '-A']); git(['commit', '-qm', 'pkgs']);
    git(['checkout', '-qb', 'theirs']);
    write('packages/api/package.json', '{"api":2}\n');
    git(['add', '-A']); git(['commit', '-qm', 'their bump'], { GIT_COMMITTER_EMAIL: 'x@y.z' });
    git(['checkout', '-q', 'main']);
    git(['checkout', '-qb', 'my-pr']);
    write('a.ts', 'a1\nmine\n'); git(['add', '-A']); git(['commit', '-qm', 'my pr']);
    const s0 = boundary(0, 'turn0');
    write('package.json', '{"root":1,"lodash":1}\n');
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--ff-only', 'theirs']);
    const s1 = boundary(1, 'turn1');
    const state = stateFor([s0, s1]);
    // The row names both: its own root edit and the nested file the checkout
    // brought in. Only the nested one is inherited.
    const row: InheritedFilesRow = {
      promptIndex: 0, filesChanged: ['package.json', 'packages/api/package.json'],
      diff: 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{"root":1}\n+{"root":1,"lodash":1}\n'
        + 'diff --git a/packages/api/package.json b/packages/api/package.json\n--- a/packages/api/package.json\n+++ b/packages/api/package.json\n@@ -1 +1 @@\n-{"api":1}\n+{"api":2}\n',
    };
    dropInheritedFilesFromTurns(state, [row], {
      inheritedFiles: (from, to, local) => inheritedFilesForTurn(repo, state, from, to, local),
      authoredFiles: () => new Set(),
    });
    expect(row.filesChanged).toEqual(['package.json']);
    expect(row.diff).toContain('lodash');
    expect(row.diff).not.toContain('"api":2');
    expect(row.inheritedFiles).toEqual(['packages/api/package.json']);
  });

  it("keeps a divergent turn's file that its own PR's squash landed, with no commitTurns record", () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    git(['checkout', '-qb', 'my-pr']);
    write('a.ts', 'a1\nearlier turn\n'); git(['add', '-A']); git(['commit', '-qm', 'earlier turn']);
    const s0 = boundary(0, 'turn0');
    write('x.ts', 'written by a script\n'); // command_probe: watched-only
    git(['add', '-A']); git(['commit', '-qm', 'x']);
    // GitHub squash-merges the PR onto main: new sha, GitHub committer, our trailer.
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--squash', 'my-pr']);
    git(['commit', '-qm', `my PR (#9)\n\nOrigin-Session: ${sid.slice(0, 12)} | Claude Code | 2 prompts`], {
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
    });
    const s1 = boundary(1, 'turn1');
    const state = stateFor([s0, s1]);
    expect([...inheritedFilesForTurn(repo, state, s0.shadowSha, s1.shadowSha, 0)]).not.toContain('x.ts');
  });

  // ffca44d8: the same squash, reached along a STRAIGHT line — the turn started
  // on main, branched, landed its PR and pulled main. Another session's PR
  // (#1642, b.ts/c.ts) landed on main in the same window and stays inherited.
  const squashOnMain = (sid: string, turnPart: string) => {
    git(['checkout', '-qb', 'my-pr']);
    write('x.ts', 'written by a script\n'); // command_probe: watched-only
    git(['add', '-A']); git(['commit', '-qm', 'x']);
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--ff-only', upstream]);
    git(['merge', '-q', '--squash', 'my-pr']);
    git(['commit', '-qm', `my PR (#9)\n\n* x\n\nOrigin-Session: ${sid.slice(0, 12)} | Claude Code | 3 prompts${turnPart}`], {
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
    });
  };

  it("keeps a straight-line turn's file that its own PR's squash landed, when the trailer names this turn", () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const s0 = boundary(0, 'turn0');
    squashOnMain(sid, ' | turn 1');
    const s1 = boundary(1, 'turn1');
    const state = stateFor([s0, s1]);
    const inherited = inheritedFilesForTurn(repo, state, s0.shadowSha, s1.shadowSha, 0);
    expect([...inherited]).not.toContain('x.ts');
    expect([...inherited].sort()).toEqual(['b.ts', 'c.ts']);
  });

  it('a later turn that pulls an EARLIER turn\'s squash still treats it as inherited', () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const s0 = boundary(0, 'turn0');
    squashOnMain(sid, ' | turn 1'); // made by turn 1 — this window is turn 2's
    const s1 = boundary(1, 'turn1');
    const state = stateFor([{ ...s0, promptIndex: 1 }, { ...s1, promptIndex: 2 }], {
      prompts: ['first', 'go ahead', 'next'], promptTurnIds: ['t_0', 't_1', 't_2'],
    });
    expect([...inheritedFilesForTurn(repo, state, s0.shadowSha, s1.shadowSha, 1)]).toContain('x.ts');
  });

  it('a straight-line squash whose trailer names no turn (older CLI) stays inherited', () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const s0 = boundary(0, 'turn0');
    squashOnMain(sid, '');
    const s1 = boundary(1, 'turn1');
    expect([...inheritedFilesForTurn(repo, stateFor([s0, s1]), s0.shadowSha, s1.shadowSha, 0)]).toContain('x.ts');
  });

  it('a resumed session numbers its turns from promptIndexBase', () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const s0 = boundary(0, 'turn0');
    squashOnMain(sid, ' | turn 8'); // server row 7 = local turn 0 of a launch based at 7
    const s1 = boundary(1, 'turn1');
    const state = stateFor([s0, s1], { promptIndexBase: 7 });
    expect([...inheritedFilesForTurn(repo, state, s0.shadowSha, s1.shadowSha, 0)]).not.toContain('x.ts');
  });
});

describe('trailerNamesSessionTurn', () => {
  const me = { sessionId: '11111111-2222-4333-8444-555555555555' };
  it.each([
    ['Origin-Session: 11111111-222 | Claude Code | 3 prompts | turn 4', 4, true],
    ['Origin-Session: 11111111-222 | Claude Code | 3 prompts | turn 4', 3, false],
    ['Origin-Session: 11111111-222 | Claude Code | 3 prompts', 3, false],
    ['Origin-Session: 99999999-222 | Claude Code | turn 4', 4, false],
    // A squash: one line per squashed commit — the second names this turn.
    ['* a\n\nOrigin-Session: 11111111-222 | Claude Code | turn 2\n\n* b\n\nOrigin-Session: 11111111-222 | Claude Code | turn 4', 4, true],
    ['Origin-Session: 11111111-222 | Claude Code | turn 14', 4, false],
  ])('%j turn %i → %s', (body, turn, want) => expect(trailerNamesSessionTurn(body as string, me, turn as number)).toBe(want));
});
