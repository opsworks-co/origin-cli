import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildRevertCommit, revertPromptCommand, type RevertPatch } from '../commands/revert-prompt.js';

// "Revert this prompt": real git — an origin remote, a clone with a running
// agent's dirty checkout, and the turn's diff applied in reverse.

let root: string;
let remote: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const g = (...args: string[]) => git(repo, ...args);
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

let turnDiff = '';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'revert-prompt-'));
  remote = path.join(root, 'remote.git');
  repo = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, repo);
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  write('cart.ts', 'export const items = [];\n// one\n// two\n// three\n// four\nexport const tax = 0.2;\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  // The prompt's work: a total line, and a new file.
  write('cart.ts', 'export const items = [];\nexport const total = items.reduce((a, b) => a + b);\n// one\n// two\n// three\n// four\nexport const tax = 0.2;\n');
  write('fmt.ts', 'export const fmt = (n: number) => n.toFixed(2);\n');
  g('add', '.');
  g('commit', '-qm', 'feat: totals');
  turnDiff = g('diff', 'HEAD~1', 'HEAD');
  // Later work by someone else, elsewhere in the same file.
  // Far enough from the prompt's line that git does not call it a conflict.
  write('cart.ts', 'export const items = [];\nexport const total = items.reduce((a, b) => a + b);\n// one\n// two\n// three\n// four\nexport const tax = 0.25;\n');
  g('commit', '-qam', 'later: tax');
  g('push', '-q', 'origin', 'main');
  // The checkout is now dirty and on another branch — an agent at work.
  g('checkout', '-q', '-b', 'claude/other');
  write('cart.ts', 'dirty work in progress\n');
  write('scratch.txt', 'untracked\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const patch = (over: Partial<RevertPatch> = {}): RevertPatch => ({
  sessionId: 'abcd1234-0000-0000-0000-000000000000', promptIndex: 2, promptTitle: 'add a running total\nmore text',
  diff: turnDiff, files: ['cart.ts', 'fmt.ts'], branchName: 'revert/abcd1234-prompt-3', ...over,
});

describe('buildRevertCommit', () => {
  it("undoes exactly the prompt's lines on the default branch, keeping later work, without touching the checkout", () => {
    const head = g('rev-parse', 'HEAD');
    const status = g('status', '--porcelain');
    const r = buildRevertCommit(repo, patch());
    expect(r).toMatchObject({ ok: true, branch: 'revert/abcd1234-prompt-3', base: 'origin/main' });

    expect(git(repo, 'show', 'revert/abcd1234-prompt-3:cart.ts')).toBe('export const items = [];\n// one\n// two\n// three\n// four\nexport const tax = 0.25;'); // later tax kept
    expect(() => git(repo, 'show', 'revert/abcd1234-prompt-3:fmt.ts')).toThrow();                                     // new file removed
    expect(g('rev-parse', 'revert/abcd1234-prompt-3^')).toBe(g('rev-parse', 'origin/main'));
    const msg = g('log', '-1', '--format=%B', 'revert/abcd1234-prompt-3');
    expect(msg).toContain('Revert prompt #3: add a running total');
    expect(msg).toContain('Origin-Revert: abcd1234-0000-0000-0000-000000000000 | turn 3');
    // The checkout is exactly as it was.
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(g('status', '--porcelain')).toBe(status);
    expect(g('stash', 'list')).toBe('');
  });

  it('stops on a conflict with a later change, and writes nothing', () => {
    git(root, 'clone', '-q', remote, path.join(root, 'other'));
    const other = path.join(root, 'other');
    git(other, 'config', 'user.email', 'o@example.com'); git(other, 'config', 'user.name', 'O');
    fs.writeFileSync(path.join(other, 'cart.ts'), 'export const items = [];\nexport const total = items.reduce((a, b) => a + b, 0);\n// one\n// two\n// three\n// four\nexport const tax = 0.25;\n');
    git(other, 'commit', '-qam', 'fix total'); git(other, 'push', '-q', 'origin', 'main');

    const r = buildRevertCommit(repo, patch());
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(['cart.ts']);
    expect(r.message).toContain('Nothing was changed');
    expect(() => g('rev-parse', '--verify', 'revert/abcd1234-prompt-3')).toThrow();
  });

  it('refuses an existing branch, an empty diff, and a revert that changes nothing', () => {
    g('branch', 'revert/abcd1234-prompt-3', 'origin/main');
    expect(buildRevertCommit(repo, patch()).message).toContain('already exists');
    expect(buildRevertCommit(repo, patch({ diff: '', branchName: 'revert/x' })).message).toContain('nothing to revert');
    // Reverting on the commit before the prompt: its lines aren't there.
    const r = buildRevertCommit(repo, patch({ branchName: 'revert/y' }), { base: 'main~2', fetch: false });
    expect(r.ok).toBe(false);
  });
});

describe('revertPromptCommand', () => {
  it('fetches the patch for the 1-based turn, builds the branch and pushes it', async () => {
    const asked: Array<[string, number]> = [];
    const logs: string[] = [];
    const r = await revertPromptCommand('abcd1234-0000-0000-0000-000000000000', '3', {}, {
      cwd: repo,
      fetchPatch: async (s, i) => { asked.push([s, i]); return patch(); },
      log: (s) => logs.push(s), error: (s) => logs.push(s),
    });
    expect(asked).toEqual([['abcd1234-0000-0000-0000-000000000000', 2]]);
    expect(r).toMatchObject({ ok: true, pushed: true });
    expect(git(remote, 'rev-parse', 'revert/abcd1234-prompt-3')).toBe(r.commitSha);
  });

  it('a turn that is not a number is refused before anything is asked', async () => {
    let asked = false;
    const r = await revertPromptCommand('s', 'two', {}, { cwd: repo, fetchPatch: async () => { asked = true; return patch(); }, log: () => {}, error: () => {} });
    expect(r.ok).toBe(false);
    expect(asked).toBe(false);
    process.exitCode = 0;
  });
});
