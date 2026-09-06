// `git init` inside the checkout creates a submodule boundary. From the
// parent, git reports the DIRECTORY and nothing under it — at any `-u` level:
//
//   $ git status --porcelain -uall
//   ?? random_project/          <- dice.py never appears
//
// So no diff-based capture can see that work, and the turn renders exactly
// like one that did nothing.
//
// Prod 2a8dc4d4 (kotleta, Antigravity) turn 5: the agent created
// `random_project/` as its own repo and wrote dice.py at 16:37:12, eleven
// seconds before the turn's Stop. The row read 0 files. Four of that session's
// five turns were legitimately zero, so this one was indistinguishable from
// them — which is the actual damage.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { nestedRepoFilesWritten } from '../commands/hooks.js';
import { fileURLToPath } from 'url';
import { hooksSource } from './helpers/hooks-source.js';

let repo: string;
let turnStart: number;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-nested-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });

  // Written BEFORE the turn — must not be claimed by it.
  fs.mkdirSync(path.join(repo, 'older_project'));
  execFileSync('git', ['init', '-q', '.'], { cwd: path.join(repo, 'older_project') });
  fs.writeFileSync(path.join(repo, 'older_project', 'old.py'), 'old\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(repo, 'older_project', 'old.py'), old, old);

  turnStart = Date.now() - 5_000;

  // The turn's work: a nested repo, plus an ORDINARY untracked dir that the
  // normal capture can already see and must not be double-counted here.
  fs.mkdirSync(path.join(repo, 'random_project'));
  execFileSync('git', ['init', '-q', '.'], { cwd: path.join(repo, 'random_project') });
  fs.writeFileSync(path.join(repo, 'random_project', 'dice.py'), 'import random\n');
  fs.mkdirSync(path.join(repo, 'plain_dir'));
  fs.writeFileSync(path.join(repo, 'plain_dir', 'visible.js'), 'export const a = 1;\n');
});
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('nestedRepoFilesWritten', () => {
  it('reproduces git hiding the nested repo from the parent', () => {
    const status = execFileSync('git', ['status', '--porcelain', '-uall'],
      { cwd: repo, encoding: 'utf-8' });
    expect(status).toContain('random_project/');
    expect(status).not.toContain('dice.py'); // the whole problem, in one line
  });

  it('finds the file the parent repo cannot see', () => {
    expect(nestedRepoFilesWritten(repo, turnStart)).toContain('random_project/dice.py');
  });

  it('ignores a nested repo written before the turn', () => {
    expect(nestedRepoFilesWritten(repo, turnStart)).not.toContain('older_project/old.py');
  });

  it('ignores an ordinary untracked directory the normal capture already sees', () => {
    const found = nestedRepoFilesWritten(repo, turnStart);
    expect(found.some((f) => f.includes('plain_dir'))).toBe(false);
  });

  it('never walks into the nested .git itself', () => {
    expect(nestedRepoFilesWritten(repo, turnStart).some((f) => f.includes('.git/'))).toBe(false);
  });

  it('caps how much it will claim', () => {
    expect(nestedRepoFilesWritten(repo, turnStart, { limit: 0 })).toEqual([]);
  });

  it('claims nothing when the window is unknown', () => {
    expect(nestedRepoFilesWritten(repo, NaN)).toEqual([]);
  });

  it('does not follow a path that climbs out of the tree', () => {
    // Status text is parsed, so a hostile/odd entry must not escape the root.
    expect(nestedRepoFilesWritten(repo, turnStart, { statusText: '?? ../elsewhere/\n' })).toEqual([]);
  });
});

// The detector is worthless unless every payload producer consults it. It was
// shipped wired into the Claude Code Stop and session-end paths only — and the
// session that motivated it was ANTIGRAVITY, which builds its own promptChanges
// with its own out-of-repo source. The fix was a no-op for the exact agent it
// was written for, and only a source-level check catches that.
describe('every producer of outOfRepoFiles consults the nested-repo source', () => {
  const src = hooksSource();

  it('the Antigravity payload includes nested-repo writes', () => {
    // agy's `outsideFiles` is derived from transcript paths outside workRoot; a
    // nested repo is INSIDE it, so that source can never see one.
    const at = src.indexOf('outOfRepoWrites(workRoot, parsed.promptFilesEdited');
    expect(at).toBeGreaterThan(-1);
    // Window spans the block that assembles agy's outsideFiles.
    const agy = src.slice(at - 1200, at + 400);
    expect(agy).toContain('nestedRepoFilesWritten');
  });

  it('the generic payload sites merge both sources', () => {
    // Two sites (Stop, session-end) build promptChanges from promptEditsByIndex.
    const merged = src.split('...(outOfRepoFilesFor(').length - 1;
    expect(merged).toBe(2);
    // …and none of them still uses the un-merged helper inline in a payload.
    expect(src).not.toContain('...(outOfRepoFilesFromEditsJson(promptEditsByIndex?.get(pm.promptIndex))),');
  });
});
