// A main-checkout handshake adopted into a linked worktree must start from
// the WORKTREE's tree, not main's.
//
// Session e1095412 (2026-09-08): Claude Code registered its session on the
// primary checkout at b766fba4, the desktop app moved it into a worktree
// whose branch was already fourteen commits ahead, and the adoption kept
// main's baseline. Two minutes in, before the session had written a line,
// its first Stop stored a header of +6431/-2115 across eight commits — the
// trailer fallback (`ownedRangeCommitShas`) had walked main's HEAD to the
// worktree's and kept every commit trailered by the previous session there.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { captureSessionStartBaseline } from '../commands/hooks/session-start.js';
import { restampWorktreeBootstrap } from '../worktree-bootstrap.js';
import { ownedRangeCommitShas } from '../commands/hooks/stop.js';
import { SHADOW_IDENTITY_EMAIL } from '../git-capture.js';

let root = '';
let main = '';
let wt = '';
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

let mainHead = '';
let wtHead = '';

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rebaseline-')));
  main = path.join(root, 'repo');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t.t'); git(main, 'config', 'user.name', 'T');
  git(main, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(main, 'README.md'), '# r\n');
  // The linked worktree lives under .claude/ inside main; keep main clean.
  fs.writeFileSync(path.join(main, '.gitignore'), '.claude/\n');
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'base');
  mainHead = git(main, 'rev-parse', 'HEAD');
  // The worktree's branch is ahead of main by a commit this session never made.
  wt = path.join(main, '.claude', 'worktrees', 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
  fs.writeFileSync(path.join(wt, 'ahead.ts'), Array.from({ length: 40 }, (_, i) => `export const AHEAD_${i} = ${i};`).join('\n') + '\n');
  git(wt, 'add', '-A');
  // Committed an hour ago: it really was "already on the branch" when the
  // session started, and the ownership predicate's date guard can see that.
  execFileSync('git', ['commit', '-qm', 'work already on the branch'], {
    cwd: wt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 3600_000).toISOString() },
  });
  wtHead = git(wt, 'rev-parse', 'HEAD');
  // And it is dirty in a way main is not.
  fs.writeFileSync(path.join(wt, 'notes.md'), 'scratch\n');
});
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('captureSessionStartBaseline', () => {
  it('reads HEAD, the dirt and the shadow from the tree it is given', () => {
    const b = captureSessionStartBaseline(wt, 'test-wt');
    expect(b.headShaAtStart).toBe(wtHead);
    expect(b.sessionStartDirtyFiles).toEqual(['notes.md']);
    expect(b.sessionStartShadowSha).toBeTruthy();
    expect(b.prePromptSha).toBe(b.sessionStartShadowSha);
    expect(b.prePromptDirtyFiles).toEqual([]);
    // The shadow was taken in the worktree: its tree holds the dirt.
    expect(git(wt, 'log', '-1', '--format=%ae', b.sessionStartShadowSha!)).toBe(SHADOW_IDENTITY_EMAIL);
    expect(git(wt, 'ls-tree', '--name-only', b.sessionStartShadowSha!)).toContain('notes.md');
  });

  it('on a clean tree the baseline is HEAD itself, with no shadow', () => {
    const b = captureSessionStartBaseline(main, 'test-main');
    expect(b).toEqual({
      headShaAtStart: mainHead, sessionStartShadowSha: null, prePromptSha: mainHead,
      prePromptDirtyFiles: [], sessionStartDirtyFiles: [],
    });
  });
});

describe('adopting a main handshake into a worktree', () => {
  const handshake = () => ({
    sessionId: 'sess-adopt', sessionTag: 'adopt', agentSlug: 'claude-code',
    startedAt: new Date().toISOString(), prompts: [] as string[],
    repoPath: main, canonicalRepoPath: main, lastCwd: main, branch: 'main',
    ...captureSessionStartBaseline(main, 'hs'),
  });

  it('without the baseline, the trailer fallback walks the branch\'s existing commit', () => {
    const s = handshake();
    restampWorktreeBootstrap(s, { lastCwd: wt, repoPath: wt, canonicalRepoPath: main, branch: 'feature' });
    // main's HEAD → the worktree's HEAD spans a local commit with no trailer,
    // which the ownership predicate used to keep by committer identity alone.
    // Its date guard now refuses it — the commit predates the session — so
    // the leak needs BOTH layers gone to show: strip `startedAt` too.
    expect(ownedRangeCommitShas(wt, s as any)).toEqual([]);
    expect(ownedRangeCommitShas(wt, { ...s, startedAt: undefined } as any)).toEqual([wtHead]);
  });

  it('with the baseline, the session starts where the worktree is and owns nothing yet', () => {
    const s = handshake();
    restampWorktreeBootstrap(s, {
      lastCwd: wt, repoPath: wt, canonicalRepoPath: main, branch: 'feature',
      baseline: captureSessionStartBaseline(wt, 'adopt'),
    });
    expect(s.headShaAtStart).toBe(wtHead);
    expect(ownedRangeCommitShas(wt, s as any)).toEqual([]);
  });
});
