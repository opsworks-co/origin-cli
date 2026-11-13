// Regression: a sandboxed agent (Codex's workspace-write) forbids writes INSIDE
// .git → EPERM. saveSessionState used to write straight into .git with no error
// handling, so the throw aborted the whole Stop hook — the agent then reported
// "hook timed out after 10s". The write must degrade to a sandbox-safe location
// (~/.origin/sessions), and load must find it there.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import {
  saveSessionState,
  loadSessionState,
  getStatePath,
  getGlobalFallbackStatePath,
} from '../session-state.js';
import { TransientFsRetryExhaustedError } from '../transient-fs.js';

describe('session-state sandbox fallback (.git read-only → ~/.origin/sessions)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not throw and persists to the global fallback when the .git write is denied', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);

    // Real git repo so getStatePath resolves the primary path INSIDE .git.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sbx-'));
    execSync('git init -q', { cwd: repo });

    const tag = 'sbxtag1';
    const gitStatePath = getStatePath(repo, tag);
    expect(gitStatePath).toContain(`${path.sep}.git${path.sep}`);
    const fbPath = getGlobalFallbackStatePath(repo, tag);
    expect(fbPath).toContain(tmpHome);

    // Simulate the sandbox: any write INTO .git throws EPERM; others are real.
    const realWrite = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (typeof p === 'string' && p.includes(`${path.sep}.git${path.sep}`)) {
        const e: any = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e;
      }
      return (realWrite as any)(p, ...rest);
    }) as any);

    const state: any = {
      sessionId: 'sess-abcdef-123456',
      claudeSessionId: 'agent-xyz',
      sessionTag: tag,
      prompts: [],
    };

    expect(() => saveSessionState(state, repo, tag)).not.toThrow();
    expect(fs.existsSync(fbPath)).toBe(true);        // landed in the fallback
    expect(fs.existsSync(gitStatePath)).toBe(false); // never made it into .git

    // Reads use real fs again, but keep HOME mocked so the fallback resolves.
    spy.mockRestore();
    const loaded = loadSessionState(repo, tag);
    expect(loaded?.sessionId).toBe('sess-abcdef-123456');
  });

  it('still writes into .git normally when it is writable (no behavior change)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-ok-'));
    execSync('git init -q', { cwd: repo });
    const tag = 'oktag1';
    const state: any = { sessionId: 'sess-ok-999', claudeSessionId: 'agent-ok', sessionTag: tag, prompts: [] };
    saveSessionState(state, repo, tag);
    expect(fs.existsSync(getStatePath(repo, tag))).toBe(true); // primary .git path used
    expect(loadSessionState(repo, tag)?.sessionId).toBe('sess-ok-999');
  });

  it('does not route exhausted state-file rename contention to the cwd-keyed fallback', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-busy-'));
    execSync('git init -q', { cwd: repo });
    const tag = 'busytag1';
    const statePath = getStatePath(repo, tag);
    const fallbackPath = getGlobalFallbackStatePath(repo, tag);
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (to === statePath) throw Object.assign(new Error('EPERM: target remains held'), { code: 'EPERM' });
      return realRename(from, to);
    }) as any);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 600));
    const state: any = { sessionId: 'sess-busy-123', claudeSessionId: 'agent-busy', sessionTag: tag, prompts: [] };

    expect(() => saveSessionState(state, repo, tag)).toThrow(TransientFsRetryExhaustedError);
    expect(fs.existsSync(fallbackPath)).toBe(false);
    expect(fs.existsSync(statePath + '.tmp.' + process.pid)).toBe(false);
  });

  it('retries a transient refusal while replacing the sandbox fallback file', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-fallback-busy-'));
    execSync('git init -q', { cwd: repo });
    const tag = 'fallbackbusy1';
    const statePath = getStatePath(repo, tag);
    const fallbackPath = getGlobalFallbackStatePath(repo, tag);
    const realWrite = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (typeof file === 'string' && file.startsWith(statePath)) {
        throw Object.assign(new Error('sandbox denied .git write'), { code: 'EACCES' });
      }
      return (realWrite as any)(file, ...args);
    }) as any);
    const realRename = fs.renameSync.bind(fs);
    let refusals = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (to === fallbackPath && refusals++ < 2) throw Object.assign(new Error('held by Defender'), { code: 'EPERM' });
      return realRename(from, to);
    }) as any);
    const state: any = { sessionId: 'sess-fallback-busy', claudeSessionId: 'agent', sessionTag: tag, prompts: [] };

    expect(() => saveSessionState(state, repo, tag)).not.toThrow();
    expect(loadSessionState(repo, tag)?.sessionId).toBe('sess-fallback-busy');
    expect(refusals).toBe(3);
  });

  it('removes the fallback temp file when replacement contention outlasts the retry budget', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-fallback-stuck-'));
    execSync('git init -q', { cwd: repo });
    const tag = 'fallbackstuck1';
    const statePath = getStatePath(repo, tag);
    const fallbackPath = getGlobalFallbackStatePath(repo, tag);
    const realWrite = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (typeof file === 'string' && file.startsWith(statePath)) {
        throw Object.assign(new Error('sandbox denied .git write'), { code: 'EACCES' });
      }
      return (realWrite as any)(file, ...args);
    }) as any);
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (to === fallbackPath) throw Object.assign(new Error('target remains held'), { code: 'EBUSY' });
      return fs.renameSync(from, to);
    }) as any);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 600));
    const state: any = { sessionId: 'sess-fallback-stuck', claudeSessionId: 'agent', sessionTag: tag, prompts: [] };

    expect(() => saveSessionState(state, repo, tag)).toThrow(TransientFsRetryExhaustedError);
    expect(fs.existsSync(fallbackPath + '.tmp.' + process.pid)).toBe(false);
  });
});
