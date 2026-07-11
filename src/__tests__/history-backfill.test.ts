// History backfill: when the server reports unknownShas (history it has no
// Commit row for — e.g. commits made before Origin's hooks were installed in
// a local repo), the post-commit hook extracts each commit's metadata + patch
// from local git and ingests them in batches. Without this, a local repo with
// 12 commits showed 3 in Origin forever (baton). The advertisement is gated
// on a per-repo sync marker so the steady-state commit path stops paying for
// the check once history is confirmed synced.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listRecentShas,
  buildCommitPayload,
  backfillUnknownCommits,
  extractCommitDiff,
  shouldAdvertiseHistory,
  writeSyncMarker,
  acquireBackfillLock,
  releaseBackfillLock,
} from '../history-backfill.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('history-backfill', () => {
  let dir: string;
  let fakeHome: string;
  let realHome: string | undefined;
  let shas: string[] = []; // oldest → newest

  beforeEach(() => {
    // Markers live under ~/.origin — point HOME at a scratch dir so tests
    // never touch (or depend on) the real machine state.
    realHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    process.env.HOME = fakeHome;

    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-backfill-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@origin.dev');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    // The dev machine's global core.hooksPath points at Origin's real git
    // hooks — every fixture commit would fire the network-calling
    // post-commit hook (seconds per commit, flaky under parallel load).
    git(dir, 'config', 'core.hooksPath', '/dev/null');
    shas = [];
    fs.writeFileSync(path.join(dir, 'sample.txt'), 'Row1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'Initial commit');
    shas.push(git(dir, 'rev-parse', 'HEAD'));
    fs.appendFileSync(path.join(dir, 'sample.txt'), 'Row2\n');
    git(dir, 'commit', '-q', '-am', 'Add row 2\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    shas.push(git(dir, 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(dir, 'other.txt'), 'hello\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-am', 'Add other file');
    shas.push(git(dir, 'rev-parse', 'HEAD'));
  });

  afterEach(() => {
    // `process.env.HOME = undefined` would coerce to the literal string
    // "undefined" and poison os.homedir() for every later test in the worker.
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('listRecentShas returns HEAD ancestry, newest first', () => {
    expect(listRecentShas(dir)).toEqual([...shas].reverse());
  });

  it('listRecentShas returns [] outside a git repo', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-nogit-'));
    try {
      expect(listRecentShas(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('buildCommitPayload extracts full metadata, files, and patch — including the root commit', () => {
    const root = buildCommitPayload(dir, shas[0]);
    expect(root).not.toBeNull();
    expect(root!.message).toBe('Initial commit');
    expect(root!.author).toBe('Test');
    expect(root!.filesChanged).toEqual(['sample.txt']);
    expect(root!.diff).toContain('+Row1');
    expect(root!.committedAt).toBeTruthy();
    // History commits carry NO branch — stamping today's branch on all of
    // ancestry (incl. merged feature work) would be wrong and permanent.
    expect('branch' in root!).toBe(false);
  });

  it('buildCommitPayload keeps the message BODY so AI trailers survive for detection', () => {
    const p = buildCommitPayload(dir, shas[1]);
    expect(p!.message).toContain('Add row 2');
    expect(p!.message).toContain('Co-Authored-By: Claude');
  });

  it('buildCommitPayload rejects a non-hex sha without touching git', () => {
    expect(buildCommitPayload(dir, 'HEAD; rm -rf /')).toBeNull();
  });

  it('extractCommitDiff handles normal and root commits (shared with the live hook)', () => {
    expect(extractCommitDiff(dir, shas[2]).diff).toContain('+hello');
    const root = extractCommitDiff(dir, shas[0]);
    expect(root.diff).toContain('+Row1');
    expect(root.filesChanged).toEqual(['sample.txt']);
  });

  it('backfillUnknownCommits ingests every unknown sha and reports the accepted count', async () => {
    const ingest = vi.fn().mockImplementation(async ({ commits }) => ({ ingested: commits.length }));

    const result = await backfillUnknownCommits({
      repoPath: dir,
      hookCwd: dir,
      unknownShas: [shas[0], shas[1], 'garbage', 'zz'],
      ingest,
    });

    expect(result).toEqual({ accepted: 2, failed: false });
    expect(ingest).toHaveBeenCalledTimes(1);
    const sent = ingest.mock.calls[0][0];
    expect(sent.repoPath).toBe(dir);
    expect(sent.commits.map((c: any) => c.sha)).toEqual([shas[0], shas[1]]);
    expect(sent.commits[0].diff).toContain('+Row1');
  });

  it('backfillUnknownCommits attaches the server-known corroboration shas to every batch', async () => {
    // Batch commits are by definition unknown to the server, so the batch
    // payload must carry known SHAs or the server's basename-fallback
    // confidence gate can't corroborate a moved no-remote checkout and
    // would auto-register a duplicate repo row mid-backfill.
    const ingest = vi.fn().mockImplementation(async ({ commits }) => ({ ingested: commits.length }));

    await backfillUnknownCommits({
      repoPath: dir,
      hookCwd: dir,
      unknownShas: [shas[0], shas[1]],
      knownShas: [shas[2]],
      ingest,
    });

    expect(ingest.mock.calls[0][0].recentShas).toEqual([shas[2]]);

    // And omitted entirely when there's nothing to corroborate with.
    ingest.mockClear();
    await backfillUnknownCommits({ repoPath: dir, hookCwd: dir, unknownShas: [shas[0]], ingest });
    expect(ingest.mock.calls[0][0]).not.toHaveProperty('recentShas');
  });

  it('backfillUnknownCommits survives shas git no longer knows (pruned/rebased)', async () => {
    const ingest = vi.fn().mockResolvedValue({ ingested: 1 });

    const result = await backfillUnknownCommits({
      repoPath: dir,
      hookCwd: dir,
      unknownShas: ['d'.repeat(40), shas[2]],
      ingest,
    });

    expect(result.accepted).toBe(1);
    const sent = ingest.mock.calls[0][0];
    expect(sent.commits.map((c: any) => c.sha)).toEqual([shas[2]]);
  });

  it('a failed batch is reported but does not abort later batches', async () => {
    // Three ~500KB-capped diffs overflow the 1.2MB payload budget, forcing
    // a flush and pushing the remaining sha into a second batch. The first
    // batch's failure (e.g. a 413/timeout) must not strand the rest.
    const bigShas: string[] = [];
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, `big${i}.txt`), 'x'.repeat(600_000) + '\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `huge vendored blob ${i}`);
      bigShas.push(git(dir, 'rev-parse', 'HEAD'));
    }

    const ingest = vi.fn()
      .mockRejectedValueOnce(new Error('413'))
      .mockResolvedValue({ ingested: 1 });
    const errors: unknown[] = [];

    const result = await backfillUnknownCommits({
      repoPath: dir,
      hookCwd: dir,
      unknownShas: [...bigShas, shas[0]],
      ingest,
      onBatchError: (e) => errors.push(e),
    });

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls[0][0].commits.map((c: any) => c.sha)).toEqual(bigShas);
    expect(ingest.mock.calls[1][0].commits.map((c: any) => c.sha)).toEqual([shas[0]]);
    expect(result).toEqual({ accepted: 1, failed: true });
    expect(errors).toHaveLength(1);
  });

  describe('shouldAdvertiseHistory (sync-marker gating)', () => {
    it('advertises when the repo has never been synced', () => {
      const d = shouldAdvertiseHistory(dir, dir);
      expect(d.advertise).toBe(true);
      expect(d.head).toBe(shas[2]);
      expect(d.count).toBe(3);
    });

    it('skips in steady state: marker current, one new commit', () => {
      writeSyncMarker(dir, shas[2], 3);
      fs.appendFileSync(path.join(dir, 'sample.txt'), 'Row3\n');
      git(dir, 'commit', '-q', '-am', 'one more');
      expect(shouldAdvertiseHistory(dir, dir).advertise).toBe(false);
    });

    it('re-advertises after a multi-commit jump (pull/merge landed history)', () => {
      writeSyncMarker(dir, shas[0], 1); // marker from when only the root existed
      expect(shouldAdvertiseHistory(dir, dir).advertise).toBe(true);
    });

    it('re-advertises when the marker head is no longer an ancestor (rebase/amend)', () => {
      writeSyncMarker(dir, shas[2], 3);
      git(dir, 'commit', '-q', '--amend', '-m', 'Add other file (amended)');
      // Count unchanged (3 == marker.count, not > marker.count + 1), but
      // HEAD was rewritten — the old tip is gone from our ancestry.
      expect(shouldAdvertiseHistory(dir, dir).advertise).toBe(true);
    });
  });

  it('the backfill lock is exclusive while fresh and releasable', () => {
    expect(acquireBackfillLock(dir)).toBe(true);
    expect(acquireBackfillLock(dir)).toBe(false);
    releaseBackfillLock(dir);
    expect(acquireBackfillLock(dir)).toBe(true);
    releaseBackfillLock(dir);
  });
});
