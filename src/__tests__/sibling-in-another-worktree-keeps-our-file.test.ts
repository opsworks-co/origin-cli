// A sibling session in ANOTHER worktree does not own our copy of a file.
//
// `uncommittedExcludeUnion` compares sibling claims to ours as repo-relative
// strings, which is the only name a git-derived claim ever has. Across linked
// worktrees that string stops naming one file: `packages/cli/package.json` in
// worktree A and the same path in worktree B are two different files on disk.
// Excluding on the string alone deletes real authored work, and it does so
// hardest on the files a repo touches most — which is exactly the set every
// concurrent session has open.
//
// Session 97846e3a (Cursor, in its own worktree) is the shape. Its turn ran
// `node packages/cli/scripts/version-bump.cjs`, so the +1/-1 on
// `packages/cli/package.json` had no Edit/Write tool call behind it and the
// turn window was the only path that could see it. The window DID see it and
// skipped it as `foreign`, because three live siblings — two in
// `.claude/worktrees/memory-todo-review-9b9248`, one in
// `~/.cursor/worktrees/origin/05c3` — carried that path in their own claims.
// The bump reached the session header (post-commit reads git) and no turn's
// capture, which is `verify-capture`'s `header_file_unclaimed_by_turns`. A
// stored row is final, so that contradiction blocks the CLI release gate
// permanently.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordShellWindowEdits, siblingSharesOurTree, uncommittedExcludeUnion } from '../commands/hooks.js';
import { createShadowCommit } from '../git-capture.js';
import { getHeadSha } from '../session-state.js';

const BUMPED = 'packages/cli/package.json';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('a sibling in another worktree cannot claim our file', () => {
  let repo: string;
  let wt: string;
  let commonGitDir: string;

  const writeSiblingState = (tag: string, state: Record<string, unknown>) => {
    fs.writeFileSync(
      path.join(commonGitDir, `origin-session-${tag}.json`),
      JSON.stringify({ sessionId: tag, sessionTag: tag, ...state }),
    );
  };

  /** Our session: writing in the linked worktree, nothing in its ledger. */
  const ourState = () => ({
    sessionId: 'ours',
    sessionTag: 'ours',
    repoPath: wt,
    lastCwd: wt,
    prePromptDirtyFiles: [],
    sessionStartDirtyFiles: [],
    liveEdits: [],
    completedPromptMappings: [],
  });

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-xwt-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@origin.dev');
    git(repo, 'config', 'user.name', 'Test');
    fs.mkdirSync(path.join(repo, 'packages', 'cli'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, BUMPED),
      JSON.stringify({ name: '@origin/cli', version: '0.20260909.2214' }, null, 2) + '\n',
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'seed');
    commonGitDir = path.join(repo, '.git');

    wt = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-xwt-linked-')));
    fs.rmSync(wt, { recursive: true, force: true });
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  });

  afterEach(() => {
    try { git(repo, 'worktree', 'remove', '--force', wt); } catch { /* ignore */ }
    for (const d of [wt, repo]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('captures a script-driven version bump the main checkout also has open', () => {
    const ours = ourState();
    writeSiblingState('ours', ours);
    // A live sibling working in the MAIN checkout, claiming the same path.
    writeSiblingState('theirs', {
      repoPath: repo,
      lastCwd: repo,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [BUMPED] }],
    });

    const baseline = (createShadowCommit(wt, 'ours') || getHeadSha(wt)) as string;
    expect(baseline).toBeTruthy();

    // The write the defect is about: a spawned child process rewrites the file.
    // No Edit/Write tool call exists for it, so the turn window is the only
    // path that can see it at all.
    const bumper = path.join(wt, 'bump.cjs');
    fs.writeFileSync(bumper, `
      const fs = require('fs');
      const p = process.argv[2];
      const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      pkg.version = '0.20260909.2300';
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\\n');
    `);
    execFileSync(process.execPath, [bumper, path.join(wt, BUMPED)], { cwd: wt });
    fs.rmSync(bumper);

    expect(recordShellWindowEdits(ours as any, wt, 0, baseline)).toBe(true);
    const captured = (ours.liveEdits as any[]).flatMap((e) => e.edits.map((x: any) => x.file));
    expect(captured).toContain(BUMPED);
  });

  it('still excludes a sibling working in OUR tree', () => {
    const ours = ourState();
    writeSiblingState('ours', ours);
    writeSiblingState('theirs', {
      repoPath: wt,
      lastCwd: wt,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [BUMPED] }],
    });

    expect(uncommittedExcludeUnion(ours as any)).toContain(BUMPED);
  });

  it('still excludes a sibling whose tree is unknown', () => {
    const ours = ourState();
    writeSiblingState('ours', ours);
    writeSiblingState('theirs', {
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [BUMPED] }],
    });

    expect(uncommittedExcludeUnion(ours as any)).toContain(BUMPED);
  });

  it('still excludes a sibling recorded elsewhere that has cd-ed into our tree', () => {
    const ours = ourState();
    writeSiblingState('ours', ours);
    writeSiblingState('theirs', {
      repoPath: repo,
      lastCwd: path.join(wt, 'packages', 'cli'),
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [BUMPED] }],
    });

    expect(uncommittedExcludeUnion(ours as any)).toContain(BUMPED);
  });

  it('drops a sibling from the union when its tree is provably not ours', () => {
    const ours = ourState();
    writeSiblingState('ours', ours);
    writeSiblingState('theirs', {
      repoPath: repo,
      lastCwd: repo,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [BUMPED] }],
    });

    expect(uncommittedExcludeUnion(ours as any)).not.toContain(BUMPED);
  });

  describe('siblingSharesOurTree', () => {
    it('keeps a sibling when we cannot resolve our own tree', () => {
      expect(siblingSharesOurTree({ repoPath: '/somewhere/else' }, '')).toBe(true);
    });
    it('keeps a sibling with no recorded tree', () => {
      expect(siblingSharesOurTree({}, '/a/b')).toBe(true);
    });
    it('keeps a sibling recorded in our tree', () => {
      expect(siblingSharesOurTree({ repoPath: '/a/b' }, '/a/b')).toBe(true);
    });
    it('drops a sibling recorded in another tree', () => {
      expect(siblingSharesOurTree({ repoPath: '/a/c', lastCwd: '/a/c' }, '/a/b')).toBe(false);
    });
    it('keeps a multi-repo sibling that spans our tree', () => {
      expect(siblingSharesOurTree({ repoPath: '/a/c', repoPaths: ['/a/c', '/a/b'] }, '/a/b')).toBe(true);
    });
  });
});
