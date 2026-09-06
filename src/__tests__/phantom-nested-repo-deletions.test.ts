// `git init` inside the work tree hides every file beneath it. The parent's
// next diff renders that as DELETING all of them — and nothing was deleted.
//
// Prod b6f3cc59: turn 2 created five files inside `inventory/` at 17:27:40-45
// as ordinary untracked files, and was correctly captured as +192. Turn 3 ran
// `git init` in `inventory/` at 17:31:18 — nine seconds before its Stop — and
// rendered "+0 -192". All five files are still on disk. The turn read as
// destroying its predecessor's work.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dropPhantomNestedRepoDeletions } from '../commands/hooks.js';
import { fileURLToPath } from 'url';
import { hooksSource } from './helpers/hooks-source.js';

let repo: string;
let turnStart: number;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' });

const del = (f: string, lines: number) => [
  `diff --git a/${f} b/${f}`, 'deleted file mode 100644', 'index abc1234..0000000',
  `--- a/${f}`, '+++ /dev/null', `@@ -1,${lines} +0,0 @@`,
  ...Array.from({ length: lines }, (_, i) => `-line ${i}`), '',
].join('\n');

const mod = (f: string) => [
  `diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, '@@ -1 +1 @@',
  '-old', '+new', '',
].join('\n');

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-phantom-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'keep\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');

  // A nested repo that genuinely predates the turn — created FIRST, with a real
  // wall-clock gap before turnStart. Faking it with utimesSync is not portable:
  // macOS drags birthtime back with mtime (so it passed locally) while Linux
  // keeps the real birthtime (so CI caught it).
  fs.mkdirSync(path.join(repo, 'old_nested'));
  fs.writeFileSync(path.join(repo, 'old_nested', 'old.py'), 'old\n');
  execFileSync('git', ['init', '-q', '.'], { cwd: path.join(repo, 'old_nested') });

  const settle = (ms: number) => { const t = Date.now() + ms; while (Date.now() < t) { /* spin */ } };
  settle(30);
  turnStart = Date.now();
  settle(30);

  // The turn: files that already existed, then a `git init` above them.
  fs.mkdirSync(path.join(repo, 'inventory'));
  for (const f of ['item.py', 'utils.py']) {
    fs.writeFileSync(path.join(repo, 'inventory', f), 'x\n');
  }
  execFileSync('git', ['init', '-q', '.'], { cwd: path.join(repo, 'inventory') });

  // A file that really was removed, inside that same fresh nested repo.
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'tmp\n');
  fs.rmSync(path.join(repo, 'gone.txt'));
});
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

const run = (diff: string, files: string[] = []) =>
  dropPhantomNestedRepoDeletions(repo, files, diff, turnStart);

describe('dropPhantomNestedRepoDeletions', () => {
  it('drops the deletion of a file a fresh nested repo merely hid', () => {
    const r = run(del('inventory/item.py', 40) + del('inventory/utils.py', 30),
      ['inventory/item.py', 'inventory/utils.py']);
    expect(r.dropped.sort()).toEqual(['inventory/item.py', 'inventory/utils.py']);
    expect(r.diff).toBe('');
    expect(r.linesRemoved).toBe(0);
    expect(r.filesChanged).toEqual([]);
  });

  it('keeps a REAL deletion — the file is actually gone', () => {
    const r = run(del('gone.txt', 5), ['gone.txt']);
    expect(r.dropped).toEqual([]);
    expect(r.linesRemoved).toBe(5);
  });

  it('keeps a deletion under a nested repo that predates the turn', () => {
    // Its files were already invisible; a deletion here is not this turn's
    // `git init` talking.
    fs.writeFileSync(path.join(repo, 'old_nested', 'old.py'), 'old\n');
    const r = run(del('old_nested/old.py', 9), ['old_nested/old.py']);
    expect(r.dropped).toEqual([]);
    expect(r.linesRemoved).toBe(9);
  });

  it('never touches a modification, only whole-file deletions', () => {
    const r = run(mod('inventory/item.py'), ['inventory/item.py']);
    expect(r.dropped).toEqual([]);
    expect(r.diff).toContain('+new');
  });

  it('keeps the surviving sections and recounts from what is left', () => {
    const r = run(del('inventory/item.py', 40) + mod('keep.txt'), ['inventory/item.py', 'keep.txt']);
    expect(r.dropped).toEqual(['inventory/item.py']);
    expect(r.filesChanged).toEqual(['keep.txt']);
    expect(r.diff).toContain('keep.txt');
    expect(r).toMatchObject({ linesAdded: 1, linesRemoved: 1 });
  });

  it('is inert without a usable turn window', () => {
    const r = dropPhantomNestedRepoDeletions(repo, ['inventory/item.py'], del('inventory/item.py', 40), NaN);
    expect(r.dropped).toEqual([]);
    expect(r.linesRemoved).toBe(40);
  });
});

// #1346 shipped a nested-repo fix wired into the Claude Code payloads while the
// bug was on Antigravity, so it was a no-op for the agent it was written for.
// This filter has the same exposure: the capture it must clean is agy's.
describe('the filter is actually wired into the Antigravity capture', () => {
  const src = hooksSource();

  it('runs on the agy diff, after the concurrent-dirt scoping', () => {
    const at = src.indexOf('antigravity capture: dropped concurrent-agent dirt');
    expect(at).toBeGreaterThan(-1);
    // The phantom filter follows it and reassigns the same four variables the
    // payload reads; anything less and the cleaned diff never reaches the wire.
    const after = src.slice(at, at + 1400);
    expect(after).toContain('dropPhantomNestedRepoDeletions(workRoot');
    for (const v of ['filesChanged =', 'diff =', 'linesAdded =', 'linesRemoved =']) {
      expect(after).toContain(v);
    }
  });

  it('is bounded by the turn’s own prompt time, not the session start', () => {
    const at = src.indexOf('dropPhantomNestedRepoDeletions(workRoot');
    expect(src.slice(at - 300, at)).toContain('parsed.promptTimes[currentIdx]');
  });
});
