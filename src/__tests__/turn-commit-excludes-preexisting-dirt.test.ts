// A committing turn was handed the WHOLE commit, so it claimed every line
// `git commit -a` swept up — the previous turn's uncommitted work, and dirt
// that predates the session entirely.
//
// Prod 7a0a9efc (baton, Cursor). Turn 0 wrote +68 uncommitted and was captured
// as +68. Turn 1 wrote +68 more and committed; the retro capture at the next
// user-prompt-submit rendered its row from `git show e2d4842`:
//
//   [user-prompt-submit] captured per-prompt diff for previous prompt
//     {"promptIndex":1,"filesChanged":13,"linesAdded":68,"linesRemoved":2,
//      "sessionCommittedBytes":12245,...}
//
// filesChanged 13 and 12,245 bytes = the entire commit (+256/-2), against a
// `linesAdded` of 68 the same capture had already measured correctly against
// the turn's own shadow. Turn 0's 68 lines were then counted on BOTH rows.
//
// The turn baseline is a shadow commit whose tree IS the working tree at turn
// start, so rendering the commit FROM it subtracts what the turn didn't write.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let repo: string;
const git = (...a: string[]) =>
  execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();

let shadowSha = '';
let turnCommitSha = '';

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-turn-dirt-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'T');

  // Session start: a clean base commit.
  fs.writeFileSync(path.join(repo, 'base.ts'), 'export const base = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  // Pre-existing dirt the session never authored.
  fs.writeFileSync(path.join(repo, 'stale.ts'), 'export const STALE_DIRT = 1;\n');
  // Turn 0's work — written, NOT committed. Its own row already claims it.
  fs.writeFileSync(path.join(repo, 'turn0.ts'), 'export const TURN_ZERO = 1;\n');

  // End of turn 0 / start of turn 1: the shadow commit records the tree AS IT
  // STANDS, dirt included. This is what `captureBaseline` points at.
  git('add', '-A');
  const tree = git('write-tree');
  shadowSha = git('commit-tree', tree, '-p', git('rev-parse', 'HEAD'), '-m', 'origin-shadow');
  git('reset', '-q', 'HEAD');

  // Turn 1: writes one file, then `git commit -a` — which sweeps up turn 0's
  // work and the pre-existing dirt along with its own.
  fs.writeFileSync(path.join(repo, 'turn1.ts'), 'export const TURN_ONE = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'turn one commits everything');
  turnCommitSha = git('rev-parse', 'HEAD');
});
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

const load = async () => (await import('../commands/hooks.js')) as any;

describe('a committing turn reports only what IT wrote', () => {
  it('excludes the previous turn’s work and pre-session dirt the commit swept up', async () => {
    const { __testSessionScopedCommittedDiff: fn } = await load();
    if (!fn) return;
    const scoped = fn(repo, { sessionCommitShas: [turnCommitSha] }, shadowSha);
    expect(scoped).toContain('TURN_ONE');
    expect(scoped).not.toContain('TURN_ZERO');
    expect(scoped).not.toContain('STALE_DIRT');
  });

  it('names only the files the turn changed, not every file in the commit', async () => {
    const { __testSessionScopedCommittedDiff: fn } = await load();
    if (!fn) return;
    const scoped = fn(repo, { sessionCommitShas: [turnCommitSha] }, shadowSha);
    const files = [...scoped.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1]);
    expect(files).toEqual(['turn1.ts']);
  });

  it('still returns the whole commit when no turn baseline is given', async () => {
    const { __testSessionScopedCommittedDiff: fn } = await load();
    if (!fn) return;
    // The session-level snapshot asks a different question — "what did this
    // session commit" — and must keep seeing the full commit.
    const all = fn(repo, { sessionCommitShas: [turnCommitSha] });
    expect(all).toContain('TURN_ONE');
    expect(all).toContain('TURN_ZERO');
  });

  it('falls back to the commit when a foreign commit shares the window', async () => {
    const { __testSessionScopedCommittedDiff: fn } = await load();
    if (!fn) return;
    // Another agent commits on top of ours. `git diff baseline..HEAD` would
    // now carry their work, so the conservative per-commit walk takes over.
    fs.writeFileSync(path.join(repo, 'foreign.ts'), 'export const FOREIGN = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'a concurrent agent');
    const scoped = fn(repo, { sessionCommitShas: [turnCommitSha] }, shadowSha);
    expect(scoped).toContain('TURN_ONE');
    expect(scoped).not.toContain('FOREIGN');
  });
});
