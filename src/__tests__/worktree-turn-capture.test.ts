// End-to-end proof of the under-capture: the SAME turn, captured against the
// main checkout vs against the worktree it actually wrote in.
//
// This is the shape of session 81d65cb5 — a turn that produced a commit of
// +249/-16 across 6 files, all written in a linked worktree, captured as +40
// on one file it never touched. The window is only as good as the tree it is
// pointed at, and it was pointed at the tree the turn never used.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shellWindowEdits } from '../shell-write-capture.js';
import { createShadowCommit, filesChangedSinceShadow, readFileAtRev } from '../git-capture.js';
import { sessionWorkTree, shellWindowTarget, samePath } from '../session-worktree.js';
import { getWorkingGitRoot, getGitCommonDir, getHeadSha } from '../session-state.js';

const deps = { gitRoot: getWorkingGitRoot, gitCommonDir: getGitCommonDir };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

// The baseline the hook would take: a shadow of the dirty tree, or HEAD when
// the tree is clean (createShadowCommit returns null there by design).
function baselineFor(treePath: string, tag: string): string {
  return (createShadowCommit(treePath, tag) || getHeadSha(treePath)) as string;
}

// The window's IO, bound to whichever tree we are diffing.
function windowFor(treePath: string, baseline: string) {
  return shellWindowEdits(
    {
      listChangedFiles: (sha: string) => filesChangedSinceShadow(treePath, sha),
      readAtRev: (sha: string, file: string) => readFileAtRev(treePath, sha, file),
      readWorking: (file: string) => {
        const abs = path.join(treePath, file);
        return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
      },
    },
    { baselineSha: baseline, coveredFiles: [], isIgnored: () => false },
  );
}

describe('a turn that writes inside a linked worktree', () => {
  let repo: string;
  let wt: string;

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wtcap-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@origin.dev');
    git(repo, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'seed');

    wt = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wtcap-linked-')));
    fs.rmSync(wt, { recursive: true, force: true });
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  });

  afterEach(() => {
    try { git(repo, 'worktree', 'remove', '--force', wt); } catch { /* ignore */ }
    for (const d of [wt, repo]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('is invisible to the main checkout and visible in the worktree', () => {
    // Baselines snapshotted in BOTH trees at the start of the turn, exactly as
    // the hook now does.
    const mainBaseline = baselineFor(repo, 'turn-main');
    const wtBaseline = baselineFor(wt, 'turn-wt');
    expect(mainBaseline).toBeTruthy();
    expect(wtBaseline).toBeTruthy();

    // The turn's work — three files, all written in the worktree.
    fs.writeFileSync(path.join(wt, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(wt, 'b.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(wt, 'seed.txt'), 'hi\nand more\n');

    // Old behaviour: window aimed at repoPath. The files are not there.
    const fromMain = windowFor(repo, mainBaseline);
    expect(fromMain.edits).toHaveLength(0);

    // Fixed: aimed at the tree the turn actually wrote in.
    const fromWorkTree = windowFor(wt, wtBaseline);
    const files = fromWorkTree.edits.map((e) => e.file).sort();
    expect(files).toEqual(['a.ts', 'b.ts', 'seed.txt']);
    const a = fromWorkTree.edits.find((e) => e.file === 'a.ts');
    expect(a?.newContent).toBe('export const a = 1;\n');
  });

  it('routes the window to the worktree pair via shellWindowTarget', () => {
    const wtBaseline = baselineFor(wt, 'turn-wt');
    const state = {
      repoPath: repo,
      lastCwd: wt,
      prePromptWorkTree: { path: wt, sha: wtBaseline, promptIndex: 0 },
    };

    // What the hook computes for this turn.
    // samePath: git answers forward-slash on Windows (see session-worktree).
    const resolved = sessionWorkTree(state.repoPath, state.lastCwd, deps);
    expect(samePath(resolved, wt)).toBe(true);

    const target = shellWindowTarget(state, 0, 'main-baseline', resolved);
    expect(samePath(target.repoPath, wt)).toBe(true);
    expect(target.baseline).toBe(wtBaseline);

    fs.writeFileSync(path.join(wt, 'c.ts'), 'export const c = 3;\n');
    const out = windowFor(target.repoPath, target.baseline as string);
    expect(out.edits.map((e) => e.file)).toContain('c.ts');
  });

  it('keeps using the main pair when the session never entered a worktree', () => {
    const mainBaseline = baselineFor(repo, 'turn-main');
    const state = { repoPath: repo, lastCwd: repo, prePromptWorkTree: null };

    const resolved = sessionWorkTree(state.repoPath, state.lastCwd, deps);
    expect(samePath(resolved, repo)).toBe(true);
    const t = shellWindowTarget(state, 0, mainBaseline, resolved);
    expect(samePath(t.repoPath, repo)).toBe(true);
    expect(t.baseline).toBe(mainBaseline);

    fs.writeFileSync(path.join(repo, 'd.ts'), 'export const d = 4;\n');
    const out = windowFor(repo, mainBaseline);
    expect(out.edits.map((e) => e.file)).toContain('d.ts');
  });
});
