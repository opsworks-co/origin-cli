import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run, runDetailed } from '../utils/exec.js';
import { fitDiffToBudget } from '../diff-budget.js';

let repo: string;
const git = (...args: string[]) => run('git', args, { cwd: repo });
const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);
const apply = (args: string[], input: string) => {
  const result = runDetailed('git', ['apply', ...args, '-'], { cwd: repo, input });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
};
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-context-'));
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('context shrinks before changes are omitted', () => {
  it('keeps distant changes in every file and applies to the original tree', () => {
    const rows = Array.from({ length: 4500 }, (_, i) => `line ${i} ${'context '.repeat(12)}`);
    for (const file of ['a.ts', 'b.ts', 'c.ts']) write(file, rows.join('\n') + '\n');
    git('add', '.');
    for (const file of ['a.ts', 'b.ts', 'c.ts']) {
      const changed = [...rows];
      changed[1] = '++counter;';
      changed[4400] = 'changed near the end';
      write(file, changed.join('\n') + '\n');
    }
    const full = git('diff', '--unified=2000');
    const fitted = fitDiffToBudget(full, 20_000);
    expect(Buffer.byteLength(full)).toBeGreaterThan(200_000);
    expect(fitted.truncated).toBe(false);
    expect(fitted.omittedFiles).toEqual([]);
    expect(fitted.partialFiles).toEqual([]);
    expect(Buffer.byteLength(fitted.diff)).toBeLessThan(20_000);
    expect(apply(['--numstat'], fitted.diff))
      .toBe(git('diff', '--numstat'));
    apply(['--reverse', '--check'], fitted.diff);
    apply(['--reverse'], fitted.diff);
    expect(git('diff')).toBe('');
    apply(['--check'], fitted.diff);
  });

  it('preserves no-newline markers and mode-only changes beside compacted hunks', () => {
    const rows = Array.from({ length: 300 }, (_, i) => `unchanged ${i}`);
    write('a.txt', [...rows, 'before'].join('\n'));
    git('add', '.');
    write('a.txt', [...rows, 'after'].join('\n'));
    const mode = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n';
    const full = git('diff', '--unified=2000');
    const fitted = fitDiffToBudget(full + mode, 1000);
    expect(fitted.truncated).toBe(false);
    expect(fitted.diff.match(/\\ No newline at end of file/g)).toHaveLength(2);
    expect(fitted.diff).toContain(mode);
    apply(['--reverse', '--check', '--include=a.txt'], fitted.diff);
  });

  it('still reports omissions when the changed content itself exceeds the budget', () => {
    const text = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n'
      + '@@ -0,0 +1,500 @@\n' + '+new content\n'.repeat(500);
    const fitted = fitDiffToBudget(text, 1000);
    expect(fitted.truncated).toBe(true);
    expect(fitted.omittedFiles).toEqual(['new.txt']);
    expect(fitted.diff).toBe('');
  });
});
