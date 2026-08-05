// `origin upgrade` restarted the watcher daemons only after a successful
// install. A daemon left stale by any OTHER route — the CLI installed via
// `npm install -g`, or an upgrade that ran while the daemon was already up —
// was never cycled: the command printed "Already up to date!" and returned
// while the watcher kept capturing with the code it loaded at spawn. Observed
// live: the codex watcher ran 0.20260804.2042 for 20+ minutes after the box was
// on 0.20260805.2011.
//
// The pid file holds only a pid, so it can't answer "and what code is that?".
// These lock the version sidecar that can.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  watchMetaPath,
  writeWatchMeta,
  readWatchMeta,
  removeWatchMeta,
  watchFreshness,
} from '../watch-meta.js';

let tmp = '';
let pidFile = '';

const writePid = (pid: number) => fs.writeFileSync(pidFile, String(pid));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-watchmeta-'));
  pidFile = path.join(tmp, 'codex-watch.pid');
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('watchMetaPath', () => {
  it('sits beside the pid file, not inside it', () => {
    expect(watchMetaPath('/x/.origin/codex-watch.pid')).toBe('/x/.origin/codex-watch.meta.json');
    expect(watchMetaPath('/x/.origin/transcript-watch.pid')).toBe('/x/.origin/transcript-watch.meta.json');
  });

  it('never collides between the two watchers', () => {
    expect(watchMetaPath('/x/codex-watch.pid')).not.toBe(watchMetaPath('/x/transcript-watch.pid'));
  });
});

describe('watch meta round-trip', () => {
  it('records the version and pid it was written with', () => {
    writeWatchMeta(pidFile, '0.20260805.2011', 4242);
    const meta = readWatchMeta(pidFile);
    expect(meta?.version).toBe('0.20260805.2011');
    expect(meta?.pid).toBe(4242);
    expect(Date.parse(meta!.startedAt)).toBeGreaterThan(0);
  });

  it('returns null for a missing, empty, or malformed sidecar', () => {
    expect(readWatchMeta(pidFile)).toBeNull();
    fs.writeFileSync(watchMetaPath(pidFile), 'not json');
    expect(readWatchMeta(pidFile)).toBeNull();
    fs.writeFileSync(watchMetaPath(pidFile), JSON.stringify({ pid: 'x', version: 1 }));
    expect(readWatchMeta(pidFile)).toBeNull();
  });

  it('removeWatchMeta is idempotent', () => {
    writeWatchMeta(pidFile, '1.0.0', 1);
    removeWatchMeta(pidFile);
    removeWatchMeta(pidFile);
    expect(readWatchMeta(pidFile)).toBeNull();
  });
});

describe('watchFreshness — is the running daemon on this build?', () => {
  it('reports not-running with no pid file at all', () => {
    expect(watchFreshness(pidFile, '1.0.0')).toBe('not-running');
  });

  it('reports not-running for a dead pid, even with a sidecar left behind', () => {
    writePid(999999); // not a live process
    writeWatchMeta(pidFile, '1.0.0', 999999);
    expect(watchFreshness(pidFile, '1.0.0')).toBe('not-running');
  });

  it('reports not-running for a garbage pid file', () => {
    fs.writeFileSync(pidFile, 'banana');
    expect(watchFreshness(pidFile, '1.0.0')).toBe('not-running');
  });

  it('reports current when the live daemon recorded THIS version', () => {
    writePid(process.pid);
    writeWatchMeta(pidFile, '0.20260805.2011', process.pid);
    expect(watchFreshness(pidFile, '0.20260805.2011')).toBe('current');
  });

  it('reports stale when the live daemon recorded a DIFFERENT version', () => {
    writePid(process.pid);
    writeWatchMeta(pidFile, '0.20260804.2042', process.pid);
    // The exact live failure: daemon on 2042, box on 2011.
    expect(watchFreshness(pidFile, '0.20260805.2011')).toBe('stale');
  });

  it('reports stale for a daemon that predates the sidecar', () => {
    // Every already-running watcher self-heals exactly once after this ships.
    writePid(process.pid);
    expect(watchFreshness(pidFile, '0.20260805.2011')).toBe('stale');
  });

  it('reports stale when the sidecar describes a DIFFERENT pid', () => {
    // A daemon was replaced without rewriting the sidecar — its version claim
    // says nothing about the process actually running now.
    writePid(process.pid);
    writeWatchMeta(pidFile, '0.20260805.2011', process.pid + 1);
    expect(watchFreshness(pidFile, '0.20260805.2011')).toBe('stale');
  });

  it('treats a downgrade as stale too, not just an upgrade', () => {
    writePid(process.pid);
    writeWatchMeta(pidFile, '0.20260805.9999', process.pid);
    expect(watchFreshness(pidFile, '0.20260805.2011')).toBe('stale');
  });
});
