/**
 * The last-line normalisation for a turn's file list.
 *
 * The per-producer scoping fixes are the real repair. This is the choke point
 * that makes a miss by ANY producer non-fatal, and the only thing that can heal
 * rows an older build already wrote — the re-capture merge UNIONS file lists,
 * so a stale path shape would otherwise persist for the life of the session.
 *
 * Every case below is taken from session 6e9947a5, where all four turns ended
 * up carrying the same file twice (once repo-relative, once
 * `.claude/worktrees/<name>/…`) plus the scratch file this agent writes its
 * commit messages into.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { normalizeTurnFiles } from '../commands/hooks.js';

const REPO = path.resolve('/repo');
const WT = path.join(REPO, '.claude', 'worktrees', 'capture-attrib-repro');
const OPTS = { roots: [WT, REPO], workTree: WT };

describe('normalizeTurnFiles', () => {
  it('collapses our own worktree prefix onto the repo-relative name', () => {
    expect(normalizeTurnFiles(
      ['.claude/worktrees/capture-attrib-repro/packages/cli/src/x.ts'],
      OPTS,
    )).toEqual(['packages/cli/src/x.ts']);
  });

  it('de-duplicates the two shapes of ONE file into one row', () => {
    // The exact turn-3 shape.
    expect(normalizeTurnFiles([
      'packages/cli/src/__tests__/worktree-path-scoping.test.ts',
      '.claude/worktrees/capture-attrib-repro/packages/cli/src/__tests__/worktree-path-scoping.test.ts',
    ], OPTS)).toEqual(['packages/cli/src/__tests__/worktree-path-scoping.test.ts']);
  });

  it('keeps the slot of whichever shape came first', () => {
    expect(normalizeTurnFiles([
      '.claude/worktrees/capture-attrib-repro/a.ts',
      'b.ts',
      'a.ts',
    ], OPTS)).toEqual(['a.ts', 'b.ts']);
  });

  it("drops a DIFFERENT worktree's file", () => {
    expect(normalizeTurnFiles([
      '.claude/worktrees/somebody-else/packages/cli/src/x.ts',
      'packages/cli/src/x.ts',
    ], OPTS)).toEqual(['packages/cli/src/x.ts']);
  });

  it('drops an absolute path outside every root', () => {
    expect(normalizeTurnFiles([
      '/private/tmp/claude-501/abc/scratchpad/msg.txt',
      'packages/cli/src/x.ts',
    ], OPTS)).toEqual(['packages/cli/src/x.ts']);
  });

  it('relativises an absolute path INSIDE the work tree', () => {
    expect(normalizeTurnFiles(
      [path.join(WT, 'packages/cli/src/x.ts')],
      OPTS,
    )).toEqual(['packages/cli/src/x.ts']);
  });

  it('relativises an absolute path inside the canonical repo', () => {
    expect(normalizeTurnFiles(
      [path.join(REPO, 'apps/web/src/Page.tsx')],
      OPTS,
    )).toEqual(['apps/web/src/Page.tsx']);
  });

  it('is a no-op for a non-worktree session', () => {
    const plain = { roots: [REPO], workTree: REPO };
    expect(normalizeTurnFiles(
      ['packages/cli/src/x.ts', 'apps/web/src/Page.tsx'],
      plain,
    )).toEqual(['packages/cli/src/x.ts', 'apps/web/src/Page.tsx']);
  });

  it('drops every worktree path when we are NOT in a worktree', () => {
    // With no work tree of our own, `.claude/worktrees/…` can only be
    // somebody else's — which is exactly what that ignore rule always meant.
    const plain = { roots: [REPO], workTree: REPO };
    expect(normalizeTurnFiles(
      ['.claude/worktrees/other/x.ts', 'packages/cli/src/x.ts'],
      plain,
    )).toEqual(['packages/cli/src/x.ts']);
  });

  it('handles empty, missing and junk input without throwing', () => {
    expect(normalizeTurnFiles(undefined, OPTS)).toEqual([]);
    expect(normalizeTurnFiles([], OPTS)).toEqual([]);
    expect(normalizeTurnFiles(['', null as any, 0 as any, 'ok.ts'], OPTS)).toEqual(['ok.ts']);
  });

  it('leaves relative paths alone when no roots are supplied', () => {
    // Degrades to the previous behaviour rather than blanking a turn: with no
    // roots there is nothing to judge membership against.
    expect(normalizeTurnFiles(['packages/cli/src/x.ts'], { roots: [], workTree: null }))
      .toEqual(['packages/cli/src/x.ts']);
  });
});
