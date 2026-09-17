import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentPartOfManagedSection, stripOriginManagedBlock } from '../managed-block-diff.js';

const managed = '<!-- origin-managed -->\nOrigin: Session tracking active\ndigest\n<!-- origin-managed -->\n\n';
const budget = '<!-- origin-budget-lock -->\nStop.\n<!-- origin-budget-lock -->\n\n';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('context-file line endings', () => {
  it.each(['', managed, budget + managed])('preserves CRLF user lines after block removal (%#)', (prefix) => {
    const rules = '# Rules\r\n\r\nKeep these bytes.\r\n';
    expect(stripOriginManagedBlock(prefix.replace(/\n/g, '\r\n') + rules)).toBe(rules);
  });

  it('preserves mixed line endings around an LF managed block', () => {
    expect(stripOriginManagedBlock('before\r\n' + managed + 'after\nlast\r\n'))
      .toBe('before\r\nafter\nlast\r\n');
  });

  it.each(['\n', '\r\n'])('produces a patch git can apply without changing user line endings (%j)', (eol) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-context-crlf-'));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('config', 'core.safecrlf', 'false');
    const file = path.join(dir, 'CLAUDE.md');
    const before = ['# Rules', '', 'Old rule.', 'Keep this line.', ''].join(eol);
    const after = before.replace('Old rule.', 'New rule.');
    // Origin's own block uses LF even when the user's rules use CRLF.
    fs.writeFileSync(file, managed + before);
    git('add', 'CLAUDE.md');
    fs.writeFileSync(file, managed.replace('digest', 'refreshed digest') + after);
    const patch = agentPartOfManagedSection(git('diff', '--unified=2000'), 'CLAUDE.md');
    expect(patch).not.toContain('origin-managed');
    expect(patch).not.toContain('digest');
    fs.writeFileSync(file, before);
    execFileSync('git', ['apply', '--check', '-'], { cwd: dir, input: patch + '\n' });
    execFileSync('git', ['apply', '-'], { cwd: dir, input: patch + '\n' });
    expect(fs.readFileSync(file, 'utf8')).toBe(after);
  });
});
