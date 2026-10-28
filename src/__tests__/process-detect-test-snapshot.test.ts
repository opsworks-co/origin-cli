// The Windows process snapshot can be supplied by a test (capture e2e tests
// that need "exactly one Codex process" on Windows, where no PATH shim can
// replace PowerShell). That override must never reach an ordinary CLI or hook
// run: it is honoured only with both Vitest markers present, and it goes
// through the same parser as a real PowerShell dump.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let powershellCalls = 0;
vi.mock('../utils/exec.js', () => ({
  runDetailed: () => {
    powershellCalls++;
    return { status: 0, stdout: JSON.stringify([{ ProcessId: 7, ParentProcessId: 1, CommandLine: 'explorer.exe' }]), stderr: '' };
  },
}));

const {
  TEST_WIN_PROCESS_SNAPSHOT_ENV, testWindowsSnapshotOverride, parseWindowsProcessRows,
  isProcessRunning, uniqueMatchingId, __resetProcessSnapshot,
} = await import('../utils/process-detect.js');
const { __resetPlatformCache } = await import('../utils/platform.js');
const { standalonePgrepChecks } = await import('../agents/registry.js');

// The snapshot capture-e2e-commit-in-another-repo.test.ts hands its hooks.
const ONLY_CODEX = JSON.stringify([{ ProcessId: 424242, ParentProcessId: 1, CommandLine: 'codex.exe exec' }]);

const MARKERS = ['ORIGIN_TEST_RUN_ID', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', TEST_WIN_PROCESS_SNAPSHOT_ENV] as const;
const realPlatform = process.platform;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(MARKERS.map((k) => [k, process.env[k]]));
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  __resetPlatformCache();
  __resetProcessSnapshot();
  powershellCalls = 0;
});
afterEach(() => {
  for (const k of MARKERS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  __resetPlatformCache();
  __resetProcessSnapshot();
});

describe('testWindowsSnapshotOverride', () => {
  const snap = { [TEST_WIN_PROCESS_SNAPSHOT_ENV]: ONLY_CODEX };

  it('is taken inside a Vitest run: run id plus a worker or pool id', () => {
    expect(testWindowsSnapshotOverride({ ...snap, ORIGIN_TEST_RUN_ID: '1-abcdef01', VITEST_WORKER_ID: '3' })).toBe(ONLY_CODEX);
    expect(testWindowsSnapshotOverride({ ...snap, ORIGIN_TEST_RUN_ID: '1-abcdef01', VITEST_POOL_ID: '2' })).toBe(ONLY_CODEX);
  });

  it('is ignored when either marker is missing', () => {
    expect(testWindowsSnapshotOverride({ ...snap })).toBeNull();
    expect(testWindowsSnapshotOverride({ ...snap, ORIGIN_TEST_RUN_ID: '1-abcdef01' })).toBeNull();
    expect(testWindowsSnapshotOverride({ ...snap, VITEST_WORKER_ID: '3', VITEST_POOL_ID: '2' })).toBeNull();
  });

  it('is null when no snapshot is set', () => {
    expect(testWindowsSnapshotOverride({ ORIGIN_TEST_RUN_ID: '1-abcdef01', VITEST_WORKER_ID: '3' })).toBeNull();
  });
});

describe('parseWindowsProcessRows', () => {
  it('reads the array and single-object shapes ConvertTo-Json prints', () => {
    expect(parseWindowsProcessRows(ONLY_CODEX)).toEqual([{ pid: 424242, ppid: 1, cmd: 'codex.exe exec' }]);
    expect(parseWindowsProcessRows('{"ProcessId":4,"ParentProcessId":0,"CommandLine":null}')).toEqual([{ pid: 4, ppid: 0, cmd: '' }]);
  });

  it('drops rows without an integer pid and reads malformed or empty output as no rows', () => {
    expect(parseWindowsProcessRows('[{"ProcessId":"x","CommandLine":"codex"}]')).toEqual([]);
    expect(parseWindowsProcessRows('not json')).toEqual([]);
    expect(parseWindowsProcessRows('  ')).toEqual([]);
  });
});

describe('Windows process detection with a test snapshot', () => {
  it('uses the snapshot, not PowerShell, inside a Vitest run', () => {
    process.env.ORIGIN_TEST_RUN_ID = '1-abcdef01';
    process.env.VITEST_WORKER_ID = '3';
    process.env[TEST_WIN_PROCESS_SNAPSHOT_ENV] = ONLY_CODEX;
    expect(isProcessRunning('pgrep -f "codex"')).toBe(true);
    expect(powershellCalls).toBe(0);
  });

  it('runs PowerShell and ignores the snapshot outside a Vitest run', () => {
    delete process.env.ORIGIN_TEST_RUN_ID;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.VITEST_POOL_ID;
    process.env[TEST_WIN_PROCESS_SNAPSHOT_ENV] = ONLY_CODEX;
    expect(isProcessRunning('pgrep -f "codex"')).toBe(false);
    expect(powershellCalls).toBe(1);
  });

  it('the e2e snapshot matches Codex and no other standalone agent', () => {
    process.env.ORIGIN_TEST_RUN_ID = '1-abcdef01';
    process.env.VITEST_WORKER_ID = '3';
    process.env[TEST_WIN_PROCESS_SNAPSHOT_ENV] = ONLY_CODEX;
    const checks = standalonePgrepChecks().map((c) => ({ cmd: c.cmd, id: c.model }));
    expect(uniqueMatchingId(checks)).toEqual({ id: 'codex', matched: ['codex'] });
  });
});
