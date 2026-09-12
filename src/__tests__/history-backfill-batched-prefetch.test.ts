// The backfill window used TWO git spawns PER COMMIT — `git log -1` for
// metadata and `diff-tree` for the file list — and caps at 500 commits. At
// ~34ms per spawn on the origin repo that is ~27s of pure process startup, on
// a hook the agent kills at its timeout: measured 200 commits at 11.0s
// one-at-a-time versus 67ms batched (164x).
//
// prefetchCommitPayloads does both in two processes for the whole list. This
// file pins the only thing that matters — the batched read must produce
// EXACTLY what the per-commit read produced — over the shapes that break
// naive batching:
//
//   • a ROOT commit (no parent; needs --root, and `diff-tree` without it is
//     silent)
//   • a MERGE — `diff-tree` omits it ENTIRELY, not even a sha header, so it
//     must fall back to the per-commit ladder that asks for first-parent names
//   • a message ENDING ON A BLANK LINE, mid-sequence — a trailing one is
//     trimmed on both sides and proves nothing
//   • a sha that is GONE. Without `--ignore-missing`, one rebased-away sha
//     makes `git log` exit 128 and the ENTIRE batch returns nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCommitPayload, prefetchCommitPayloads } from '../history-backfill.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('prefetchCommitPayloads — batched reads equal the per-commit reads', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-batch-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@origin.dev');
    git(dir, 'config', 'user.name', 'Origin Test');

    // 1. root commit
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'root commit');

    // 2. a message whose body ENDS on a blank line, mid-sequence
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'subject line\n\nbody paragraph\n\n');

    // 3. a side branch, merged back with a real merge commit
    git(dir, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'three\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'side work');
    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'd.txt'), 'four\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'main work');
    git(dir, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side into main');
  });

  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const shasNewestFirst = () => git(dir, 'rev-list', 'HEAD').split('\n').filter(Boolean);

  it('produces identical payloads for every commit, including the merge and the root', () => {
    const shas = shasNewestFirst();
    expect(shas.length).toBe(5); // root, blank-line body, main work, side work, merge

    const prefetch = prefetchCommitPayloads(dir, shas);
    for (const sha of shas) {
      const perCommit = buildCommitPayload(dir, sha);
      const batched = buildCommitPayload(dir, sha, prefetch);
      expect(batched, `payload for ${sha.slice(0, 8)}`).toEqual(perCommit);
    }
  });

  it('gives the merge its first-parent file list, not an empty one', () => {
    const merge = git(dir, 'rev-parse', 'HEAD');
    expect(git(dir, 'rev-list', '--parents', '-n', '1', merge).split(' ').length).toBe(3);

    // diff-tree omits a merge completely, so it is absent from the map — NOT
    // an empty array, which would read as "this commit changed nothing".
    const prefetch = prefetchCommitPayloads(dir, [merge]);
    expect(prefetch.files.has(merge)).toBe(false);

    const batched = buildCommitPayload(dir, merge, prefetch);
    expect(batched?.filesChanged).toContain('c.txt');
    expect(batched).toEqual(buildCommitPayload(dir, merge));
  });

  it('keeps the root commit\'s files', () => {
    const root = git(dir, 'rev-list', '--max-parents=0', 'HEAD');
    const prefetch = prefetchCommitPayloads(dir, [root]);
    expect(prefetch.files.get(root)).toEqual(['a.txt']);
    expect(buildCommitPayload(dir, root, prefetch)).toEqual(buildCommitPayload(dir, root));
  });

  it('preserves a message that ends on a blank line', () => {
    const sha = git(dir, 'log', '--format=%H', '--grep', 'subject line').split('\n')[0];
    const prefetch = prefetchCommitPayloads(dir, [sha]);
    const batched = buildCommitPayload(dir, sha, prefetch);
    expect(batched?.message).toBe(buildCommitPayload(dir, sha)?.message);
    expect(batched?.message).toBe('subject line\n\nbody paragraph');
  });

  it('survives a sha that no longer exists instead of voiding the whole batch', () => {
    const shas = shasNewestFirst();
    const dead = '0'.repeat(40);
    const prefetch = prefetchCommitPayloads(dir, [dead, ...shas]);

    // The live ones are all still there — this is what --ignore-missing buys.
    for (const sha of shas) {
      expect(prefetch.meta.has(sha), `${sha.slice(0, 8)} lost to the dead sha`).toBe(true);
      expect(buildCommitPayload(dir, sha, prefetch)).toEqual(buildCommitPayload(dir, sha));
    }
    // And the dead one resolves to nothing rather than throwing.
    expect(prefetch.meta.has(dead)).toBe(false);
    expect(buildCommitPayload(dir, dead, prefetch)).toBeNull();
  });
});
