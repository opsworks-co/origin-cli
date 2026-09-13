import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureGitState } from '../git-capture.js';
import { describe, expect, it } from 'vitest';
import { budgetedTurnCapture } from '../commands/hooks/stop.js';
import { verifyTurn } from '../capture-verify.js';

const patch = (file: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-before\n+after\n`;

describe('multi-repo synthesized turn content', () => {
  it('keeps claims from two real repositories while storing only the primary diff', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-multi-content-'));
    try {
      const captures = ['primary', 'secondary'].map((name) => {
        const repo = path.join(root, name);
        fs.mkdirSync(repo);
        const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
        git('init');
        git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
        git('config', 'user.name', 'Test');
        git('config', 'user.email', 'test@example.com');
        fs.writeFileSync(path.join(repo, 'same.ts'), 'before\n');
        git('add', '.');
        git('commit', '-m', 'baseline');
        const baseline = git('rev-parse', 'HEAD');
        fs.writeFileSync(path.join(repo, 'same.ts'), 'after\n');
        if (name === 'secondary') { git('add', '.'); git('commit', '-m', 'change'); }
        return captureGitState(repo, baseline, { fullContext: true });
      });
      expect(captures[1].commitDetails.flatMap((c) => c.filesChanged)).toContain('same.ts');
      expect(captures[0].uncommittedDiff).toContain('+after');
      const row = budgetedTurnCapture(captures[0].diff, captures[0].uncommittedDiff || '', ['primary/same.ts', 'secondary/same.ts']);
      expect(row.contentUnavailableFiles).toEqual(['primary/same.ts', 'secondary/same.ts']);
      expect(row.filesChanged).toContain('same.ts');
      expect(verifyTurn({ promptIndex: 0, ...row })).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['diff', 'uncommittedDiff'] as const)('declares remote content absent from %s without hiding a same-named local file', (field) => {
    const row = budgetedTurnCapture(field === 'diff' ? patch('src/a.ts') : '', field === 'uncommittedDiff' ? patch('src/a.ts') : '', ['other/src/a.ts', 'other/src/b.ts']);
    expect(row.filesChanged).toEqual(['src/a.ts', 'other/src/a.ts', 'other/src/b.ts']);
    expect(row.contentUnavailableFiles).toEqual(['other/src/a.ts', 'other/src/b.ts']);
    expect(verifyTurn({ promptIndex: 0, ...row, linesAdded: 1, linesRemoved: 1 })).toEqual([]);
  });

  it('retains files when all content lives elsewhere', () => {
    const row = budgetedTurnCapture('', '', ['other/a.ts', 'other/a.ts']);
    expect(row.filesChanged).toEqual(['other/a.ts']);
    expect(row.contentUnavailableFiles).toEqual(['other/a.ts']);
    expect(verifyTurn({ promptIndex: 0, ...row, linesAdded: 0, linesRemoved: 0 })).toEqual([]);
  });

  it('does not mark content actually stored under its qualified path unavailable', () => {
    const row = budgetedTurnCapture(patch('other/a.ts'), '', ['other/a.ts']);
    expect(row.contentUnavailableFiles).toBeUndefined();
    expect(verifyTurn({ promptIndex: 0, ...row })).toEqual([]);
  });

  it('combines remote content declarations with files omitted by the budget', () => {
    const large = `diff --git a/large.ts b/large.ts\n--- /dev/null\n+++ b/large.ts\n@@ -0,0 +1 @@\n+${'x'.repeat(210_000)}\n`;
    const row = budgetedTurnCapture(patch('local.ts') + large, '', ['other/a.ts']);
    expect(row.contentUnavailableFiles).toEqual(expect.arrayContaining(['large.ts', 'other/a.ts']));
    expect(row.filesChanged).toEqual(expect.arrayContaining(['local.ts', 'large.ts', 'other/a.ts']));
    expect(verifyTurn({ promptIndex: 0, ...row })).toEqual([]);
  });

  it('still reports an undeclared missing local file', () => {
    const row = budgetedTurnCapture(patch('local.ts'), '', ['other/a.ts']);
    row.filesChanged.push('a.ts');
    expect(verifyTurn({ promptIndex: 0, ...row })).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'claimed_file_absent_from_diff', files: ['a.ts'] })]));
  });
});
