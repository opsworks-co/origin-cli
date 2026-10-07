/**
 * A moved-and-edited file counts as the edit, as `git show` counts it.
 *
 * Plumbing `git diff-tree` does not detect renames, so both numstat producers
 * counted the move as a whole delete plus a whole add: 3714563d, a 36-line edit
 * to a script moved from apps/api/scripts/ to apps/api/src/scripts/, was
 * stored as +128/−112 against git's +31/−15.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { captureGitState, commitLineCounts } from '../git-capture.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const LINES = Array.from({ length: 100 }, (_, i) => `export const v${i} = ${i};`);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rename-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.writeFileSync(path.join(repo, 'scripts', 'backfill.ts'), LINES.join('\n') + '\n');
  git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

function moveAndEdit(): string {
  fs.mkdirSync(path.join(repo, 'src', 'scripts'), { recursive: true });
  git('mv', 'scripts/backfill.ts', 'src/scripts/backfill.ts');
  // Edit 3 lines of the 100 and add 2.
  const edited = [...LINES];
  edited[10] = 'export const v10 = 1010;';
  edited[20] = 'export const v20 = 2020;';
  edited[30] = 'export const v30 = 3030;';
  edited.push('export const extra1 = 1;', 'export const extra2 = 2;');
  fs.writeFileSync(path.join(repo, 'src', 'scripts', 'backfill.ts'), edited.join('\n') + '\n');
  git('add', '-A'); git('commit', '-qm', 'move the backfill');
  return git('rev-parse', 'HEAD');
}

describe('a moved-and-edited file', () => {
  it('commitLineCounts counts the edit, not the whole file twice', () => {
    const sha = moveAndEdit();
    expect(commitLineCounts(repo, sha)).toEqual({ added: 5, removed: 3 });
  });

  it('the per-commit totals captureGitState sends count it the same way', () => {
    const before = git('rev-parse', 'HEAD');
    const sha = moveAndEdit();
    const state = captureGitState(repo, before);
    const c = (state?.commitDetails || []).find((d: any) => d.sha === sha) as any;
    expect(c, JSON.stringify(state?.commitDetails)).toBeTruthy();
    expect([c.linesAdded, c.linesRemoved]).toEqual([5, 3]);
  });
});
