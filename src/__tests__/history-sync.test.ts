// Session-start / manual history sync: the post-commit hook only heals a
// local repo's missing history when a NEW commit is made — a repo used
// read-only or pull-only (reviewing agents' branches, pulling teammates'
// work) never fires it, so "12 commits in git, 3 in Origin" persisted there.
// syncRepoHistory runs the same advertise-and-backfill round standalone: the
// session-start hook spawns it in a detached child, and `origin sync` runs
// it forced. The ingest endpoint requires a non-empty commits[], so the
// round re-sends HEAD's full payload as the recentShas carrier.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  syncRepoHistory,
  shouldSyncStandalone,
  writeSyncMarker,
  acquireBackfillLock,
  releaseBackfillLock,
  writeAttemptStamp,
  hasFreshFailedAttempt,
} from '../history-backfill.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('syncRepoHistory', () => {
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

    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-histsync-')));
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
    git(dir, 'commit', '-q', '-am', 'Add row 2');
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

  it('advertises HEAD ancestry with the full HEAD payload as carrier, then backfills the unknowns', async () => {
    const ingest = vi.fn()
      // Advertise round: server has never seen the two older commits.
      .mockResolvedValueOnce({ ingested: 1, unknownShas: [shas[0], shas[1]] })
      // Backfill batch.
      .mockResolvedValueOnce({ ingested: 2 });

    const result = await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });

    expect(result).toEqual({ status: 'synced', advertised: 3, unknown: 2, accepted: 2 });
    expect(ingest).toHaveBeenCalledTimes(2);

    // The advertise call: recentShas newest-first, and HEAD re-sent as a
    // COMPLETE payload — if HEAD itself is unknown server-side, the upsert's
    // update path (patch/files only) could never repair a skeletal row.
    const advertise = ingest.mock.calls[0][0];
    expect(advertise.repoPath).toBe(dir);
    expect(advertise.recentShas).toEqual([...shas].reverse());
    expect(advertise.commits.map((c: any) => c.sha)).toEqual([shas[2]]);
    expect(advertise.commits[0].message).toBe('Add other file');
    expect(advertise.commits[0].diff).toContain('+hello');

    // The backfill call carries the unknowns, plus the server-KNOWN subset
    // of the advertisement (here: just-ingested HEAD) as corroboration for
    // the server's repo-resolution confidence gate — batch commits are by
    // definition unknown, so without it a moved no-remote checkout would
    // fail the gate mid-backfill and fragment into a duplicate repo row.
    const backfill = ingest.mock.calls[1][0];
    expect(backfill.recentShas).toEqual([shas[2]]);
    expect(backfill.commits.map((c: any) => c.sha)).toEqual([shas[0], shas[1]]);
  });

  it('a clean round writes the marker: the next round is a no-op without touching the network', async () => {
    const ingest = vi.fn().mockResolvedValue({ ingested: 1, unknownShas: [] });

    expect((await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest })).status).toBe('synced');
    expect(ingest).toHaveBeenCalledTimes(1);

    const again = await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });
    expect(again).toEqual({ status: 'in-sync', advertised: 0, unknown: 0, accepted: 0 });
    expect(ingest).toHaveBeenCalledTimes(1); // no second network round
  });

  it('force bypasses the marker gate (manual `origin sync` re-checks with the server)', async () => {
    writeSyncMarker(dir, shas[2], 3); // marker says fully current
    const ingest = vi.fn().mockResolvedValue({ ingested: 1, unknownShas: [] });

    const result = await syncRepoHistory({ repoPath: dir, hookCwd: dir, force: true, ingest });

    expect(result.status).toBe('synced');
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('respects the backfill lock (concurrent session starts race to spawn)', async () => {
    expect(acquireBackfillLock(dir)).toBe(true);
    const ingest = vi.fn();
    try {
      const result = await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });
      expect(result.status).toBe('locked');
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      releaseBackfillLock(dir);
    }
  });

  it('releases the lock after a round so the next trigger can run', async () => {
    const ingest = vi.fn().mockResolvedValue({ ingested: 1, unknownShas: [] });
    await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });
    expect(acquireBackfillLock(dir)).toBe(true);
    releaseBackfillLock(dir);
  });

  it('a failed advertise ingest leaves the marker untouched so the next trigger retries', async () => {
    const ingest = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });
    expect(result.status).toBe('partial');

    // Marker absent → the gate still wants to advertise.
    ingest.mockResolvedValue({ ingested: 1, unknownShas: [] });
    expect((await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest })).status).toBe('synced');
  });

  it('a failed backfill batch reports partial and keeps the marker stale', async () => {
    const ingest = vi.fn()
      .mockResolvedValueOnce({ ingested: 1, unknownShas: [shas[0], shas[1]] })
      .mockRejectedValueOnce(new Error('413'));

    const result = await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });
    expect(result).toEqual({ status: 'partial', advertised: 3, unknown: 2, accepted: 0 });

    // Next round re-advertises (marker was not written).
    ingest.mockResolvedValue({ ingested: 1, unknownShas: [] });
    expect((await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest })).status).toBe('synced');
  });

  it('returns no-git outside a git repo without calling ingest', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-nogit-'));
    const ingest = vi.fn();
    try {
      const result = await syncRepoHistory({ repoPath: empty, hookCwd: empty, ingest });
      expect(result.status).toBe('no-git');
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('a single new commit since the marker DOES sync — the post-commit +1 slack must not apply here', async () => {
    // The post-commit gate tolerates count = marker+1 because its own
    // request carries that one commit. A standalone round has no carrier:
    // a repo that pulled exactly one commit must advertise, or a pull-only
    // repo's freshest commit stays invisible forever (verifier-confirmed).
    writeSyncMarker(dir, shas[2], 3);
    fs.appendFileSync(path.join(dir, 'sample.txt'), 'Row3\n');
    git(dir, 'commit', '-q', '-am', 'pulled commit');

    const ingest = vi.fn().mockResolvedValue({ ingested: 1, unknownShas: [] });
    const result = await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });
    expect(result.status).toBe('synced');
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('a failed round stamps a failed attempt (session-start backoff); a clean round clears it', async () => {
    const ingest = vi.fn().mockRejectedValueOnce(new Error('403 Repository not registered'));
    await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });
    expect(hasFreshFailedAttempt(dir)).toBe(true);

    ingest.mockResolvedValue({ ingested: 1, unknownShas: [] });
    await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });
    expect(hasFreshFailedAttempt(dir)).toBe(false);
  });

  describe('shouldSyncStandalone (strict gate)', () => {
    it('syncs when never synced, is quiet when head+count match the marker exactly', () => {
      expect(shouldSyncStandalone(dir, dir).sync).toBe(true);
      writeSyncMarker(dir, shas[2], 3);
      const gate = shouldSyncStandalone(dir, dir);
      expect(gate).toEqual({ sync: false, head: shas[2], count: 3 });
    });

    it('syncs on ANY head/count drift — one new commit, or an amend', () => {
      writeSyncMarker(dir, shas[2], 3);
      fs.appendFileSync(path.join(dir, 'sample.txt'), 'Row3\n');
      git(dir, 'commit', '-q', '-am', 'one more');
      expect(shouldSyncStandalone(dir, dir).sync).toBe(true);

      writeSyncMarker(dir, git(dir, 'rev-parse', 'HEAD'), 4);
      expect(shouldSyncStandalone(dir, dir).sync).toBe(false);
      git(dir, 'commit', '-q', '--amend', '-m', 'one more (amended)');
      expect(shouldSyncStandalone(dir, dir).sync).toBe(true);
    });

    it('reports no head outside a git repo', () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-nogit-'));
      try {
        expect(shouldSyncStandalone(empty, empty)).toEqual({ sync: false, head: null, count: 0 });
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  it('an attempt stamp alone never blocks syncRepoHistory itself (only the spawner checks it)', async () => {
    writeAttemptStamp(dir);
    const ingest = vi.fn().mockResolvedValue({ ingested: 1, unknownShas: [] });
    const result = await syncRepoHistory({ repoPath: dir, hookCwd: dir, ingest });
    expect(result.status).toBe('synced');
    expect(hasFreshFailedAttempt(dir)).toBe(false); // cleared by the clean round
  });
});
