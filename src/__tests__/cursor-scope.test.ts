import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { cursorScope, cursorScopeFile, removeCursorScope, writeCursorScope } from '../cursor-scope.js';

describe('cursor background scope', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cursor-scope-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('grants git and read-only commands, denies network tools, never everything', () => {
    const { allow, deny } = cursorScope().permissions;
    expect(allow).toContain('Shell(git)');
    expect(allow).not.toContain('Shell(*)');
    expect(deny).toEqual(expect.arrayContaining(['Shell(curl)', 'Shell(wget)']));
  });

  it('writes the file, keeps it out of git, and removes it (and the empty dir) at the end', () => {
    const file = writeCursorScope(repo)!;
    expect(file).toBe(cursorScopeFile(repo));
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(cursorScope());
    // Ignored: `git status` doesn't offer it to the agent's commit.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' })).toBe('');
    removeCursorScope(file);
    expect(fs.existsSync(path.join(repo, '.cursor'))).toBe(false);
  });

  it("leaves a repo's own .cursor/cli.json alone, and never deletes a changed file", () => {
    fs.mkdirSync(path.join(repo, '.cursor'));
    fs.writeFileSync(cursorScopeFile(repo), '{"permissions":{"allow":["Shell(npm)"]}}');
    expect(writeCursorScope(repo)).toBeNull();
    removeCursorScope(cursorScopeFile(repo));
    expect(fs.existsSync(cursorScopeFile(repo))).toBe(true);
  });
});
