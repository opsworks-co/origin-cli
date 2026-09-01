// End-to-end for the shape that actually lost this session's work:
//   W=/abs/path/to/worktree
//   cd $W && <write files>
// lastCwd never moves, so the harness-based resolver sees nothing. The literal
// path in the ASSIGNMENT is what makes the writes recoverable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shellWindowEdits } from '../shell-write-capture.js';
import { createShadowCommit, filesChangedSinceShadow, readFileAtRev } from '../git-capture.js';
import {
  candidateDirsFromCommand, worktreesAmongCandidates, sessionWorkTree, samePath,
} from '../session-worktree.js';
import { getWorkingGitRoot, getGitCommonDir, getHeadSha } from '../session-state.js';

const deps = { gitRoot: getWorkingGitRoot, gitCommonDir: getGitCommonDir };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();
const baselineFor = (t: string, tag: string) => (createShadowCommit(t, tag) || getHeadSha(t)) as string;

function windowFor(tree: string, baseline: string) {
  return shellWindowEdits(
    {
      listChangedFiles: (sha: string) => filesChangedSinceShadow(tree, sha),
      readAtRev: (sha: string, f: string) => readFileAtRev(tree, sha, f),
      readWorking: (f: string) => {
        const abs = path.join(tree, f);
        return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
      },
    },
    { baselineSha: baseline, coveredFiles: [], isIgnored: () => false },
  );
}

describe('cd-into-worktree inside one Bash call', () => {
  let repo: string; let wt: string;

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cdwt-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@origin.dev'); git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'x\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seed');
    wt = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cdwt-linked-')));
    fs.rmSync(wt, { recursive: true, force: true });
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
  });

  afterEach(() => {
    try { git(repo, 'worktree', 'remove', '--force', wt); } catch { /* ignore */ }
    for (const d of [wt, repo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('captures the writes the harness-based resolver cannot see', () => {
    // lastCwd stays in the main checkout — the harness never moved.
    const lastCwd = repo;
    expect(samePath(sessionWorkTree(repo, lastCwd, deps), repo)).toBe(true);

    // pre-tool-use: the command names the worktree, so we baseline it there.
    const command = `W=${wt}\ncd $W && echo hi > a.ts`;
    const discovered = worktreesAmongCandidates(repo, candidateDirsFromCommand(command), deps);
    expect(discovered.length).toBe(1);
    const wtBaseline = baselineFor(discovered[0], 'discovered');

    // the command runs: three files written inside the worktree.
    fs.writeFileSync(path.join(wt, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(wt, 'b.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(wt, 'seed.txt'), 'x\nmore\n');

    // The main tree still shows nothing — this is the bug, unchanged.
    const mainBaseline = baselineFor(repo, 'main');
    expect(windowFor(repo, mainBaseline).edits).toHaveLength(0);

    // The discovered worktree shows all of it.
    const got = windowFor(discovered[0], wtBaseline).edits.map((e) => e.file).sort();
    expect(got).toEqual(['a.ts', 'b.ts', 'seed.txt']);
  });

  it('does NOT adopt a worktree the command never mentions', () => {
    // Only paths the turn actually named are baselined — otherwise every
    // sibling agent's worktree would be swept into this turn.
    const discovered = worktreesAmongCandidates(repo, candidateDirsFromCommand('ls -la && git status'), deps);
    expect(discovered).toEqual([]);
  });

  it('cannot recover a path that only ever appears as a variable', () => {
    // The honest limit: `$W` was expanded in a shell we never saw, and the
    // assignment happened in an EARLIER, separate Bash call. Documented here
    // so the gap is visible rather than assumed closed.
    const discovered = worktreesAmongCandidates(repo, candidateDirsFromCommand('cd $W && echo hi > a.ts'), deps);
    expect(discovered).toEqual([]);
  });
});
