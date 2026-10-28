import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runRestoreTurn } from '../restore-turn.js';

// "Restore to this turn" from the web. Real git, real repos: the rules are about
// what git does to HEAD, the index, the tree and the stash list.

let repo: string;
const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf-8');
/** The tree a turn's Stop records: `git stash create`'s tree (HEAD's when clean). */
const turnTree = () => {
  const stash = g('stash', 'create');
  return g('rev-parse', `${stash || 'HEAD'}^{tree}`);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-turn-'));
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  write('a.txt', 'one\n');
  g('add', '.');
  g('commit', '-qm', 'base');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('runRestoreTurn — soft (new branch)', () => {
  it('creates a branch at the turn\'s tree without touching HEAD, the index, the working tree or the stash', () => {
    const base = g('rev-parse', 'HEAD');
    // Turn 1 leaves a.txt edited, uncommitted.
    write('a.txt', 'turn one\n');
    const tree = turnTree();
    // Later work, some of it committed, some still dirty.
    write('a.txt', 'later\n');
    g('commit', '-qam', 'later');
    write('a.txt', 'dirty now\n');
    write('new.txt', 'untracked\n');
    const headBefore = g('rev-parse', 'HEAD');
    const statusBefore = g('status', '--porcelain');

    const r = runRestoreTurn(repo, { mode: 'soft', treeSha: tree, baseSha: base, branchName: 'restore/abcd1234-t1', targetPromptIndex: 0 });

    expect(r.status).toBe('success');
    expect(r.branch).toBe('restore/abcd1234-t1');
    expect(g('rev-parse', 'restore/abcd1234-t1^{tree}')).toBe(tree);
    expect(g('rev-parse', 'restore/abcd1234-t1^')).toBe(base);
    expect(g('show', 'restore/abcd1234-t1:a.txt')).toBe('turn one');
    // Untouched.
    expect(g('rev-parse', 'HEAD')).toBe(headBefore);
    expect(g('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(g('status', '--porcelain')).toBe(statusBefore);
    expect(read('a.txt')).toBe('dirty now\n');
    expect(g('stash', 'list')).toBe('');
    expect(r.files).toEqual(['a.txt']);
    expect(r.message).toMatch(/untouched/);
  });

  it('never moves an existing branch — picks the next free name', () => {
    write('a.txt', 'turn\n');
    const tree = turnTree();
    g('checkout', '-q', '--', 'a.txt');
    g('branch', 'restore/x-t1');
    const existing = g('rev-parse', 'restore/x-t1');
    const r = runRestoreTurn(repo, { treeSha: tree, branchName: 'restore/x-t1' });
    expect(r.status).toBe('success');
    expect(r.branch).toBe('restore/x-t1-2');
    expect(g('rev-parse', 'restore/x-t1')).toBe(existing);
  });

  it('reports a snapshot that is not in this clone, and changes nothing', () => {
    const r = runRestoreTurn(repo, { treeSha: 'a'.repeat(40), branchName: 'restore/x-t1' });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/not in this clone/);
    expect(g('branch', '--list', 'restore/*')).toBe('');
  });
});

describe('runRestoreTurn — hard (reset this branch)', () => {
  it('refuses on a dirty tree: nothing reset, nothing stashed', () => {
    const base = g('rev-parse', 'HEAD');
    write('a.txt', 'turn\n');
    const tree = turnTree();
    g('commit', '-qam', 'later');
    write('a.txt', 'uncommitted work\n');
    const head = g('rev-parse', 'HEAD');

    const r = runRestoreTurn(repo, { mode: 'hard', treeSha: tree, baseSha: base });

    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/uncommitted change/);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(read('a.txt')).toBe('uncommitted work\n');
    expect(g('stash', 'list')).toBe('');
  });

  it('refuses when an untracked file would be overwritten', () => {
    const base = g('rev-parse', 'HEAD');
    write('b.txt', 'turn file\n');
    g('add', 'b.txt');
    const tree = turnTree();
    g('reset', '-q');
    // b.txt is now untracked with different content; the snapshot has b.txt.
    write('b.txt', 'mine\n');
    const r = runRestoreTurn(repo, { mode: 'hard', treeSha: tree, baseSha: base });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/b\.txt would be overwritten/);
    expect(read('b.txt')).toBe('mine\n');
  });

  it('refuses a base that is not in this branch\'s history', () => {
    g('checkout', '-qb', 'side');
    write('a.txt', 'side\n');
    g('commit', '-qam', 'side');
    const side = g('rev-parse', 'HEAD');
    const tree = g('rev-parse', 'HEAD^{tree}');
    g('checkout', '-q', 'main');
    const r = runRestoreTurn(repo, { mode: 'hard', treeSha: tree, baseSha: side });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/not in this branch's history/);
  });

  it('on a clean tree, resets the branch to the turn\'s commit and brings back its uncommitted files', () => {
    const base = g('rev-parse', 'HEAD');
    write('a.txt', 'turn one\n');
    const tree = turnTree();
    g('commit', '-qam', 'later');
    const head = g('rev-parse', 'HEAD');

    const r = runRestoreTurn(repo, { mode: 'hard', treeSha: tree, baseSha: base, targetPromptIndex: 0 });

    expect(r.status).toBe('success');
    expect(g('rev-parse', 'HEAD')).toBe(base);
    expect(g('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(read('a.txt')).toBe('turn one\n');
    // Back as uncommitted, the way the turn left it.
    expect(g('status', '--porcelain')).toBe('M a.txt');
    expect(g('stash', 'list')).toBe('');
    expect(r.message).toContain(`git reset --hard ${head.slice(0, 7)}`);
  });
});

describe('the transcript watcher delivers a queued turn restore and reports it back', () => {
  it('runs restore-turn (soft) and reports the result with its mode and turn', async () => {
    const { handleCloudCommands } = await import('../transcript-watch.js');
    const base = g('rev-parse', 'HEAD');
    write('a.txt', 'turn two\n');
    const tree = turnTree();
    g('checkout', '-q', '--', 'a.txt');
    const reports: unknown[][] = [];
    await handleCloudCommands(
      { originSessionId: 'sess-1', status: 'RUNNING', workRoot: repo } as any,
      {
        pingSession: async () => ({ command: { type: 'restore-turn', mode: 'soft', treeSha: tree, baseSha: base, branchName: 'restore/sess1-t2', targetPromptIndex: 1 } }),
        reportCommandResult: async (...args: unknown[]) => { reports.push(args); },
      } as any,
    );
    expect(reports).toHaveLength(1);
    const [id, type, status, message, extra] = reports[0] as [string, string, string, string, Record<string, unknown>];
    expect([id, type, status]).toEqual(['sess-1', 'restore-turn', 'success']);
    expect(message).toMatch(/Created branch restore\/sess1-t2/);
    expect(extra).toEqual({ mode: 'soft', targetPromptIndex: 1 });
    expect(g('show', 'restore/sess1-t2:a.txt')).toBe('turn two');
    expect(g('status', '--porcelain')).toBe('');
  });
});
