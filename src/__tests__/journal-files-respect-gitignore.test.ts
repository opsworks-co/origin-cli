/**
 * The write journal records every byte the agent's run lands on disk. A turn's
 * evidence taken from it must honour the REPO's ignore rules, not only the
 * built-in patterns: Python's `__pycache__/x.cpython-314.pyc.4392877312`
 * atomic-write temp files passed `*.pyc` and reached the session-level file
 * list — prod ccffdc75 (vodka) read "9 files" in the header for a turn that
 * wrote four.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { journalFilesForTurn } from '../commands/hooks/stop.js';
import { shouldIgnoreFile } from '../ignore-patterns.js';

describe('journal evidence honours the repo ignore rules', () => {
  let dir = '';
  let journal = '';
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-jig-')));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
    journal = path.join(dir, 'journal.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (f: string, t: number) => JSON.stringify({ f, t, h: 'x'.repeat(64), n: 1, m: t });

  it('drops files the repo ignores and keeps the rest', () => {
    const t0 = Date.now() - 5_000;
    fs.writeFileSync(journal, [
      write('app.py', t0 + 10),
      write('build/out.js', t0 + 20),
      write('__pycache__/app.cpython-314.pyc.4392877312', t0 + 30),
      write('__pycache__/app.cpython-314.pyc', t0 + 40),
    ].join('\n') + '\n');
    const state: any = { repoPath: dir, writeJournalPath: journal, currentTurnStartedAt: t0 };
    expect(journalFilesForTurn(state)).toEqual(['app.py']);
  });

  it('the built-in patterns alone already reject interpreter caches', () => {
    expect(shouldIgnoreFile('__pycache__/app.cpython-314.pyc.4392877312')).toBe(true);
    expect(shouldIgnoreFile('__pycache__/app.cpython-314.pyc')).toBe(true);
    expect(shouldIgnoreFile('src/__pycache__/x.pyc')).toBe(true);
    expect(shouldIgnoreFile('app.py')).toBe(false);
    expect(shouldIgnoreFile('pycache_notes.md')).toBe(false);
  });
});
