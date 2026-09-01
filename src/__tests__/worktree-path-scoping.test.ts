/**
 * A worktree session must record its files under the SAME names everything
 * else uses.
 *
 * Claude Code (and the Agent tool) run isolated sessions in a linked worktree
 * at `<repo>/.claude/worktrees/<name>`. That path is textually inside the main
 * checkout, so any capture path that relativises against `state.repoPath`
 * produces `.claude/worktrees/<name>/packages/cli/src/x.ts` for a file whose
 * git-derived name — from the shell probe, from `git diff`, from every sibling
 * session — is `packages/cli/src/x.ts`.
 *
 * Three consequences, all measured on session 6e9947a5 turn 1:
 *
 *   1. One file, two rows. `inferred-ledger-not-ownership.test.ts` appeared
 *      TWICE in the turn's filesChanged, once in each shape.
 *   2. The tool-call form was then DISCARDED: `**\/.claude/worktrees/**` is a
 *      deliberate ignore rule (a sibling worktree's files are not the main
 *      checkout's work), so it deleted this session's own proof-grade
 *      evidence — the only entries with source:'tool_call'.
 *   3. Ownership never matched, because `ours` held the worktree-prefixed name
 *      while the exclusion compared against repo-relative ones.
 *
 * The repair is one idea applied in every producer: relativise against the
 * tree the session is WRITING IN, and drop what falls outside it. For a
 * non-worktree session the work tree IS repoPath, so nothing changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sessionRepoRoots } from '../commands/hooks.js';
import { scopeCapturedPath } from '../transcript.js';
import { shouldIgnoreFile } from '../ignore-patterns.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

describe('worktree path scoping', () => {
  let main: string;
  let worktree: string;

  beforeEach(() => {
    main = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-wt-'));
    git(main, 'init', '-q', '-b', 'main', '.');
    git(main, 'config', 'user.email', 't@example.com');
    git(main, 'config', 'user.name', 'T');
    fs.mkdirSync(path.join(main, 'packages/cli/src'), { recursive: true });
    fs.writeFileSync(path.join(main, 'packages/cli/src/x.ts'), 'export const a = 1;\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-qm', 'init');

    // Exactly how the harness lays one out.
    worktree = path.join(main, '.claude', 'worktrees', 'feature');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  });

  afterEach(() => {
    try { fs.rmSync(main, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('puts the work tree first in the session roots', () => {
    const roots = sessionRepoRoots({ repoPath: main, lastCwd: worktree });
    expect(roots.length).toBeGreaterThanOrEqual(2);
    expect(fs.realpathSync.native(roots[0])).toBe(fs.realpathSync.native(worktree));
  });

  it('records a worktree file under its git name, not a .claude/worktrees name', () => {
    const roots = sessionRepoRoots({ repoPath: main, lastCwd: worktree });
    const abs = path.join(worktree, 'packages/cli/src/x.ts');

    expect(scopeCapturedPath(roots, abs)).toBe('packages/cli/src/x.ts');
  });

  it('the old root order produced the name the ignore rule then deletes', () => {
    // Pinning the mechanism, so a regression is legible rather than mysterious.
    const oldRoots = [main];
    const abs = path.join(worktree, 'packages/cli/src/x.ts');
    const scoped = scopeCapturedPath(oldRoots, abs);

    expect(scoped).toBe('.claude/worktrees/feature/packages/cli/src/x.ts');
    expect(shouldIgnoreFile(scoped as string)).toBe(true);
    // …while the name the new order produces survives.
    expect(shouldIgnoreFile('packages/cli/src/x.ts')).toBe(false);
  });

  it('still drops a file outside every root', () => {
    const roots = sessionRepoRoots({ repoPath: main, lastCwd: worktree });
    const outside = path.join(os.tmpdir(), 'scratchpad', 'msg.txt');

    expect(scopeCapturedPath(roots, outside)).toBeNull();
  });

  it('a non-worktree session is unaffected', () => {
    const roots = sessionRepoRoots({ repoPath: main, lastCwd: main });
    expect(fs.realpathSync.native(roots[0])).toBe(fs.realpathSync.native(main));

    const abs = path.join(main, 'packages/cli/src/x.ts');
    expect(scopeCapturedPath(roots, abs)).toBe('packages/cli/src/x.ts');
  });

  it('a cwd in an UNRELATED repo does not become a root', () => {
    // sessionWorkTree only accepts a tree sharing the main repo's common dir;
    // otherwise a session whose cwd wandered elsewhere would pull that repo's
    // files in. Guarding it here because this function now feeds path scoping.
    const other = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-other-'));
    try {
      git(other, 'init', '-q', '-b', 'main', '.');
      const roots = sessionRepoRoots({ repoPath: main, lastCwd: other });
      const real = roots.map((r) => fs.realpathSync.native(r));
      expect(real).not.toContain(fs.realpathSync.native(other));
      expect(real).toContain(fs.realpathSync.native(main));
    } finally {
      try { fs.rmSync(other, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('survives a state with no lastCwd', () => {
    expect(sessionRepoRoots({ repoPath: main })).toContain(main);
    expect(sessionRepoRoots({})).toEqual([]);
  });
});
