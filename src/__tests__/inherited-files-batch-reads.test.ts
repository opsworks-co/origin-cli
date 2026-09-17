/**
 * `inheritedFilesForTurn` listed each foreign commit's files with its own
 * `diff-tree` and read every file twice with `git show <rev>:<path>` — ~365
 * spawns for a turn that merged a 300-commit main. Both are now batched. The
 * batches must answer exactly what the per-commit reads do, and must actually
 * answer: a batch that silently fails falls back per commit, which keeps the
 * results right and the cost unchanged, so emptiness is asserted here too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitChangedFilesBatch, inheritedFilesForTurn, readFilesAtRevBatch } from '../commands/hooks.js';
import { commitChangedFiles } from '../history-backfill.js';
import { readFileAtRev } from '../git-capture.js';

let repo: string;
const git = (a: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
const head = (): string => git(['rev-parse', 'HEAD']);
const write = (file: string, content: string | Buffer): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
};
const pulled = { GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub' };

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inherited-batch-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('commitChangedFilesBatch', () => {
  it('lists what commitChangedFiles lists: root, rename, delete, merge', () => {
    write('a.txt', 'a\n'); write('dir/b.txt', 'b\n');
    git(['add', '.']); git(['commit', '-qm', 'root']);
    const root = head();
    git(['mv', 'a.txt', 'renamed.txt']); git(['commit', '-qm', 'rename']);
    const rename = head();
    git(['rm', '-q', 'dir/b.txt']); git(['commit', '-qm', 'delete']);
    const del = head();
    git(['checkout', '-q', '-b', 'side', root]);
    write('side.txt', 'side\n'); git(['add', '.']); git(['commit', '-qm', 'side']);
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--no-edit', 'side']);
    const merge = head();
    const shas = [merge, del, rename, root];
    const batch = commitChangedFilesBatch(repo, [...shas, merge.slice(0, 9)]);
    expect(batch.size).toBe(5);
    for (const sha of shas) expect(batch.get(sha)).toEqual(commitChangedFiles(repo, sha));
    expect(batch.get(merge.slice(0, 9))).toEqual(commitChangedFiles(repo, merge));
    expect(batch.get(merge)).toEqual(['side.txt']);
  });
});

describe('readFilesAtRevBatch', () => {
  it('reads what readFileAtRev reads, and leaves trees and odd paths to it', () => {
    write('text.txt', '  padded\n\n');
    write('bin.dat', Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    write('dir/inner.txt', 'inner\n');
    fs.symlinkSync('text.txt', path.join(repo, 'link'));
    git(['add', '.']); git(['commit', '-qm', 'files']);
    const rev = head();
    const pairs: Array<[string, string]> = [
      [rev, 'text.txt'], [rev, 'bin.dat'], [rev, 'link'], [rev, 'dir/inner.txt'],
      [rev, 'absent.txt'], [rev, 'dir'], [rev, '../escape'], ['not-a-sha', 'text.txt'],
    ];
    const batch = readFilesAtRevBatch(repo, pairs);
    for (const [r, file] of pairs) {
      const key = `${r}:${file}`;
      if (file === 'dir') { expect(batch.has(key)).toBe(false); continue; }
      expect(batch.has(key)).toBe(true);
      expect(batch.get(key)).toEqual(readFileAtRev(repo, r, file));
    }
    expect(batch.get(`${rev}:text.txt`)).toBe('  padded\n\n');
    expect(batch.get(`${rev}:absent.txt`)).toBeNull();
  });
});

describe('inheritedFilesForTurn', () => {
  it('names the files foreign commits left as-is, deletions included, and not what the turn changed after', () => {
    write('base.txt', 'base\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
    const base = head();
    const from = git(['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'origin shadow 0']);
    git(['checkout', '-q', '-b', 'upstream']);
    write('kept.txt', 'kept\n'); write('gone.txt', 'gone\n'); write('changed.txt', 'theirs\n');
    write('bin.dat', Buffer.from([0xff, 0x00]));
    git(['add', '.']); git(['commit', '-qm', 'upstream 1'], pulled);
    git(['rm', '-q', 'gone.txt']); git(['commit', '-qm', 'upstream 2'], pulled);
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--no-edit', 'upstream']);
    write('changed.txt', 'mine\n'); git(['add', '.']); git(['commit', '-qm', 'turn edit']);
    const end = head();
    const to = git(['commit-tree', `${end}^{tree}`, '-p', end, '-m', 'origin shadow 1']);
    const state: any = {
      sessionId: '9e9e9e9e-1111-2222',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      promptShadows: [{ promptIndex: 0, shadowSha: from }, { promptIndex: 1, shadowSha: to }],
    };
    expect([...inheritedFilesForTurn(repo, state, from, to, 0)].sort()).toEqual(['bin.dat', 'gone.txt', 'kept.txt']);
  });
});
