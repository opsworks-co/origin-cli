// `origin doctor` has to tell apart the ways a capture daemon can be useless.
// A live pid is not proof of work: a watcher wedged on a hung git call is still
// a process, and the only outward symptom of EITHER failure is sessions quietly
// not appearing — which is how a dead daemon went unnoticed for an hour.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { watchHealth, touchWatchMeta, writeWatchMeta, watchMetaPath, STALLED_AFTER_MS } from '../watch-meta.js';

describe('watchHealth', () => {
  let dir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-health-')));
    pidFile = path.join(dir, 'transcript-watch.pid');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const writeMeta = (meta: Record<string, unknown>) =>
    fs.writeFileSync(watchMetaPath(pidFile), JSON.stringify(meta));

  it('reports stopped when there is no pid file', () => {
    expect(watchHealth(pidFile, '1.0.0').state).toBe('stopped');
  });

  it('reports dead when the pid file outlives its process', () => {
    fs.writeFileSync(pidFile, '999999');
    writeMeta({ pid: 999999, version: '1.0.0', startedAt: new Date().toISOString() });
    const h = watchHealth(pidFile, '1.0.0');
    expect(h.state).toBe('dead');
    expect(h.pid).toBe(999999);
  });

  it('reports stalled when the process lives but stopped polling', () => {
    // Our own pid is definitely alive — the point is that aliveness alone is
    // not health.
    fs.writeFileSync(pidFile, String(process.pid));
    writeMeta({
      pid: process.pid,
      version: '1.0.0',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      lastCycleAt: new Date(Date.now() - STALLED_AFTER_MS - 60_000).toISOString(),
    });
    const h = watchHealth(pidFile, '1.0.0');
    expect(h.state).toBe('stalled');
    expect(h.sinceLastCycleMs).toBeGreaterThan(STALLED_AFTER_MS);
  });

  it('reports ok when it is alive and polling on the current build', () => {
    fs.writeFileSync(pidFile, String(process.pid));
    writeMeta({
      pid: process.pid,
      version: '1.0.0',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      lastCycleAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const h = watchHealth(pidFile, '1.0.0');
    expect(h.state).toBe('ok');
    expect(h.sinceLastCycleMs).toBeLessThan(30_000);
  });

  it('reports stale-build when it polls fine but on older code', () => {
    fs.writeFileSync(pidFile, String(process.pid));
    writeMeta({
      pid: process.pid,
      version: '0.9.0',
      startedAt: new Date().toISOString(),
      lastCycleAt: new Date().toISOString(),
    });
    expect(watchHealth(pidFile, '1.0.0').state).toBe('stale-build');
  });

  it('treats a daemon with no lastCycleAt as running, not stalled', () => {
    // Daemons from builds before the stamp existed must not be declared broken.
    fs.writeFileSync(pidFile, String(process.pid));
    writeMeta({ pid: process.pid, version: '1.0.0', startedAt: new Date().toISOString() });
    const h = watchHealth(pidFile, '1.0.0');
    expect(h.state).toBe('ok');
    expect(h.sinceLastCycleMs).toBeUndefined();
  });
});

describe('touchWatchMeta', () => {
  let dir: string;
  let pidFile: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-touch-')));
    pidFile = path.join(dir, 'transcript-watch.pid');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('stamps the owning process and throttles repeat writes', () => {
    writeWatchMeta(pidFile, '1.0.0', process.pid);
    const t0 = Date.parse('2026-08-05T12:00:00.000Z');
    touchWatchMeta(pidFile, t0);
    const first = JSON.parse(fs.readFileSync(watchMetaPath(pidFile), 'utf-8'));
    expect(first.lastCycleAt).toBe(new Date(t0).toISOString());

    touchWatchMeta(pidFile, t0 + 1_000); // inside the throttle — no write
    expect(JSON.parse(fs.readFileSync(watchMetaPath(pidFile), 'utf-8')).lastCycleAt)
      .toBe(new Date(t0).toISOString());

    touchWatchMeta(pidFile, t0 + 60_000); // past it — stamped
    expect(JSON.parse(fs.readFileSync(watchMetaPath(pidFile), 'utf-8')).lastCycleAt)
      .toBe(new Date(t0 + 60_000).toISOString());
  });

  it('refuses to stamp a sidecar owned by another pid', () => {
    // Otherwise a dead daemon's stale sidecar could be freshened by any passing
    // process and read as healthy.
    writeWatchMeta(pidFile, '1.0.0', 999999);
    touchWatchMeta(pidFile, Date.now());
    expect(JSON.parse(fs.readFileSync(watchMetaPath(pidFile), 'utf-8')).lastCycleAt).toBeUndefined();
  });
});
