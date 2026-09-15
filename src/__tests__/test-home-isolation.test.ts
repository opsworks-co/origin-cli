// Two CLI suites running at once on one machine must not share a HOME.
//
// 2026-09-15: the full suite failed 17 tests across 7 capture-e2e-* files
// while a second worktree's session ran its own e2e tests — both runs had
// worker 1 at <tmp>/origin-cli-test-home/1, so they shared ~/.origin/config.json
// (each e2e test's fake API URL), journals and state mirrors, and one run's
// globalSetup deleted the other's homes. See setup/test-home.ts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import {
  RUN_ID_ENV,
  newRunId,
  runIdForMainProcess,
  runHomeRoot,
  sweepDeadRuns,
  testRunsBase,
  workerHome,
} from './setup/test-home.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('test HOME is scoped to the vitest run', () => {
  it('two runs give the same worker id different homes', () => {
    const a = newRunId(4242);
    const b = newRunId(4242);
    expect(a).not.toBe(b);
    expect(workerHome(a, '1')).not.toBe(workerHome(b, '1'));
  });

  it('this worker HOME is inside this run, not a bare worker-id path', () => {
    const runId = process.env[RUN_ID_ENV];
    expect(runId).toMatch(/^\d+-[0-9a-f]+$/);
    expect(path.dirname(process.env.HOME!)).toBe(runHomeRoot(runId!));
  });

  it('reuses an id only when this process minted it', () => {
    const env: NodeJS.ProcessEnv = {};
    const first = runIdForMainProcess(env, 100);
    expect(runIdForMainProcess(env, 100)).toBe(first);
    // A child vitest inherits the parent's id — it must mint its own.
    const child = runIdForMainProcess({ ...env }, 200);
    expect(child).not.toBe(first);
    expect(child.startsWith('200-')).toBe(true);
  });

  it('crash-residue sweep removes only dead runs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sweep-'));
    try {
      const base = testRunsBase(tmp);
      for (const name of ['111-aaaaaaaaaaaa', '222-bbbbbbbbbbbb', 'unrelated']) {
        fs.mkdirSync(path.join(base, name, '1'), { recursive: true });
      }
      const removed = sweepDeadRuns(tmp, (pid) => pid === 222);
      expect(removed).toEqual(['111-aaaaaaaaaaaa']);
      expect(fs.readdirSync(base).sort()).toEqual(['222-bbbbbbbbbbbb', 'unrelated']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('two concurrent vitest runs get different homes and neither loses its own', async () => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-probe-'));
    const vitestBin = path.join(
      path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
      'vitest.mjs',
    );
    // Strip this worker's vitest identity so the children behave like
    // independent top-level runs started from a shell.
    const baseEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('VITEST') || k === RUN_ID_ENV || k === 'TEST') continue;
      baseEnv[k] = v;
    }
    const run = (label: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [vitestBin, 'run', 'src/__tests__/setup/test-home-probe.test.ts'],
          {
            cwd: CLI_ROOT,
            env: { ...baseEnv, ORIGIN_HOME_PROBE_DIR: probeDir, ORIGIN_HOME_PROBE_LABEL: label },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => resolve({ code, out }));
      });

    try {
      const [a, b] = await Promise.all([run('a'), run('b')]);
      expect(a.code, a.out).toBe(0);
      expect(b.code, b.out).toBe(0);

      const homeA = fs.readFileSync(path.join(probeDir, 'a.ok'), 'utf8');
      const homeB = fs.readFileSync(path.join(probeDir, 'b.ok'), 'utf8');
      expect(homeA).not.toBe(homeB);
      expect(path.dirname(homeA)).not.toBe(path.dirname(homeB));

      // Each run's teardown removed its own run dir; ours is still here.
      expect(fs.existsSync(path.dirname(homeA))).toBe(false);
      expect(fs.existsSync(path.dirname(homeB))).toBe(false);
      expect(fs.existsSync(process.env.HOME!)).toBe(true);
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  }, 120_000);
});
