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
import { discoverWorkTreesFromCommand, sessionRepoRoots, sessionTrees } from '../commands/hooks.js';

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

  it('adopts a worktree created by the command after it exists, for diffs and commits', () => {
    const created = path.join(os.tmpdir(), `origin-created-wt-${Date.now()}`);
    const input = { tool_input: { command: `git worktree add -b created ${created}` } };
    const state: any = { repoPath: repo, sessionId: 'session-12345678', prompts: ['make another worktree'] };

    // pre-tool-use: the named target does not exist yet.
    expect(discoverWorkTreesFromCommand(state, input)).toBe(false);
    git(repo, 'worktree', 'add', '-q', '-b', 'created', created);
    try {
      // post-tool-use: adoption persists a clean baseline for later writes.
      expect(discoverWorkTreesFromCommand(state, input)).toBe(true);
      expect(state.discoveredWorkTrees).toHaveLength(1);
      expect(samePath(state.discoveredWorkTrees[0].path, created)).toBe(true);
      expect(sessionRepoRoots(state).some((p) => samePath(p, created))).toBe(true);
      expect(sessionTrees(state).some((p) => samePath(p, created))).toBe(true);
    } finally {
      try { git(repo, 'worktree', 'remove', '--force', created); } catch { /* ignore */ }
      try { fs.rmSync(created, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('post-tool-use re-probes only the paths that were missing at pre-tool-use', () => {
    const created = path.join(os.tmpdir(), `origin-created-wt-post-${Date.now()}`);
    // The command names BOTH an existing worktree and one it is about to create.
    const input = { tool_use_id: 'toolu_1', tool_input: { command: `git -C ${wt} status && git worktree add -b made ${created}` } };
    const state: any = { repoPath: repo, sessionId: 'session-12345678', prompts: ['make another worktree'] };

    expect(discoverWorkTreesFromCommand(state, input, 'pre')).toBe(true);
    expect(state.discoveredWorkTrees.map((w: any) => w.path).some((p: string) => samePath(p, wt))).toBe(true);
    expect(state.pendingWorktreeTargets).toEqual([{ toolCallId: 'toolu_1', promptIndex: 0, paths: [created] }]);

    git(repo, 'worktree', 'add', '-q', '-b', 'made', created);
    try {
      expect(discoverWorkTreesFromCommand(state, input, 'post')).toBe(true);
      expect(state.discoveredWorkTrees).toHaveLength(2);
      expect(samePath(state.discoveredWorkTrees[1].path, created)).toBe(true);
      // Consumed: a second post for the same call finds nothing to do.
      expect(state.pendingWorktreeTargets).toEqual([]);
      expect(discoverWorkTreesFromCommand(state, input, 'post')).toBe(false);
    } finally {
      try { git(repo, 'worktree', 'remove', '--force', created); } catch { /* ignore */ }
      try { fs.rmSync(created, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('post-tool-use does no probing when every named path already existed', () => {
    const input = { tool_input: { command: `cd ${wt} && echo hi > a.ts` } };
    const state: any = { repoPath: repo, sessionId: 'session-12345678', prompts: ['work there'] };
    // Nothing was pending, so post does not look — even at a real worktree
    // pre-tool-use would have adopted.
    expect(discoverWorkTreesFromCommand(state, input, 'post')).toBe(false);
    expect(state.discoveredWorkTrees).toBeUndefined();

    expect(discoverWorkTreesFromCommand(state, input, 'pre')).toBe(true);
    expect(state.pendingWorktreeTargets).toBeUndefined();
  });

  it('parallel calls each resolve their own pending targets by tool call id', () => {
    const a = path.join(os.tmpdir(), `origin-par-a-${Date.now()}`);
    const b = path.join(os.tmpdir(), `origin-par-b-${Date.now()}`);
    const inA = { tool_use_id: 'A', tool_input: { command: `git worktree add -b pa ${a}` } };
    const inB = { tool_use_id: 'B', tool_input: { command: `git worktree add -b pb ${b}` } };
    const state: any = { repoPath: repo, sessionId: 'session-12345678', prompts: ['two worktrees'] };

    discoverWorkTreesFromCommand(state, inA, 'pre');
    discoverWorkTreesFromCommand(state, inB, 'pre');
    expect(state.pendingWorktreeTargets).toHaveLength(2);
    git(repo, 'worktree', 'add', '-q', '-b', 'pb', b);
    try {
      // B finishes first; A's entry must survive it.
      expect(discoverWorkTreesFromCommand(state, inB, 'post')).toBe(true);
      expect(state.pendingWorktreeTargets.map((e: any) => e.toolCallId)).toEqual(['A']);
      expect(samePath(state.discoveredWorkTrees[0].path, b)).toBe(true);
    } finally {
      try { git(repo, 'worktree', 'remove', '--force', b); } catch { /* ignore */ }
      for (const d of [a, b]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });
});
