/**
 * The pre-push hook's Origin refs go out in ONE `git push`, inside ONE budget,
 * and a remote that refuses refs/notes/* is not asked again for a day.
 *
 * Before: the origin-sessions branch, refs/notes/origin, both memory refs and
 * the acceptance ref were each pushed by their own `git push` (each a fresh
 * connection — another hardware-key touch on SSH) with their own 15–30s
 * timeouts and push → fetch → push retries. A slow remote, or one that
 * refuses notes (Gerrit, some Bitbucket setups), held the user's push for
 * minutes, on every push.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  NOTES_REFUSED_TTL_MS,
  PRE_PUSH_PUBLISH_BUDGET_MS,
  parsePushPorcelain,
  publishPrePushRefs,
  remoteRefusesNotes,
  type PrePushRef,
} from '../git-notes.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function configureUser(repo: string): void {
  git(repo, 'config', 'user.email', 'test@origin.dev');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
}

/** Wrap the real git so the test can count what the publisher ran. */
function countingExec() {
  const calls: string[][] = [];
  const exec = ((file: string, args: string[], opts: object) => {
    calls.push(args);
    return execFileSync(file, args, opts as never);
  }) as unknown as typeof execFileSync;
  return { exec, calls, count: (sub: string) => calls.filter((a) => a[0] === sub).length };
}

describe('publishPrePushRefs', () => {
  let baseDir: string;
  let remote: string;
  let repoA: string;
  let repoB: string;
  let c1: string;

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-prepush-one-')));
    remote = path.join(baseDir, 'remote.git');
    fs.mkdirSync(remote);
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    // The remote's own hooks (the refusal tests install some), not a global hooksPath.
    git(remote, 'config', 'core.hooksPath', path.join(remote, 'hooks'));
    repoA = path.join(baseDir, 'repoA');
    fs.mkdirSync(repoA);
    git(repoA, 'init', '-q', '-b', 'main');
    configureUser(repoA);
    fs.writeFileSync(path.join(repoA, 'a.txt'), 'a\n');
    git(repoA, 'add', '.');
    git(repoA, 'commit', '-q', '-m', 'C1');
    c1 = git(repoA, 'rev-parse', 'HEAD');
    git(repoA, 'remote', 'add', 'origin', remote);
    git(repoA, 'push', '-q', 'origin', 'main');
    repoB = path.join(baseDir, 'repoB');
    git(baseDir, 'clone', '-q', remote, repoB);
    configureUser(repoB);
  });

  afterEach(() => {
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const remoteRef = (ref: string): string | null => {
    try { return git(remote, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; }
  };

  it('pushes every Origin ref that exists locally in a single git push', () => {
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{"origin":{}}', c1);
    git(repoA, 'notes', '--ref=origin-memory', 'add', '-m', '{"sessions":[]}', c1);
    git(repoA, 'notes', '--ref=origin-acceptance', 'add', '-m', '{"acceptanceRate":1}', c1);
    git(repoA, 'branch', 'origin-sessions');
    const extra: PrePushRef = { ref: 'refs/heads/origin-sessions', staging: 'refs/remotes/origin/origin-sessions', reconcile: () => true };
    const { exec, count } = countingExec();

    const result = publishPrePushRefs(repoA, 'origin', { includeMemory: true, extraRefs: [extra], exec });

    expect(count('push')).toBe(1);
    expect(count('fetch')).toBe(0);
    expect(result.pushes).toBe(1);
    expect(result.outcomes).toEqual({
      'refs/notes/origin': 'pushed',
      'refs/notes/origin-memory': 'pushed',
      'refs/notes/origin-acceptance': 'pushed',
      'refs/heads/origin-sessions': 'pushed',
    });
    for (const ref of ['refs/notes/origin', 'refs/notes/origin-memory', 'refs/notes/origin-acceptance', 'refs/heads/origin-sessions']) {
      expect(remoteRef(ref)).toBe(git(repoA, 'rev-parse', ref));
    }
    // The memory refs stay behind the prompt-text gate.
    const again = publishPrePushRefs(repoA, 'origin', { includeMemory: false, exec });
    expect(Object.keys(again.outcomes)).not.toContain('refs/notes/origin-memory');
  });

  it('a non-fast-forward is one fetch, a local merge and one retry push — for all rejected refs together', () => {
    // repoA publishes notes on C1 first.
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"a"}}', c1);
    git(repoA, 'notes', '--ref=origin-acceptance', 'add', '-m', '{"from":"a"}', c1);
    git(repoA, 'push', '-q', 'origin', 'refs/notes/origin', 'refs/notes/origin-acceptance');
    // repoB writes its own on a new commit: unrelated notes histories.
    fs.writeFileSync(path.join(repoB, 'b.txt'), 'b\n');
    git(repoB, 'add', '.');
    git(repoB, 'commit', '-q', '-m', 'C2');
    const c2 = git(repoB, 'rev-parse', 'HEAD');
    git(repoB, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"b"}}', c2);
    git(repoB, 'notes', '--ref=origin-acceptance', 'add', '-m', '{"from":"b"}', c2);
    const { exec, count } = countingExec();

    const result = publishPrePushRefs(repoB, 'origin', { includeMemory: false, exec });

    expect(count('push')).toBe(2);
    expect(count('fetch')).toBe(1);
    expect(result.outcomes).toEqual({ 'refs/notes/origin': 'pushed', 'refs/notes/origin-acceptance': 'pushed' });
    // Both clones' notes are on the remote.
    git(repoB, 'fetch', '-q', 'origin', '+refs/notes/origin:refs/notes/v1', '+refs/notes/origin-acceptance:refs/notes/v2');
    expect(git(repoB, 'notes', '--ref=v1', 'show', c1)).toContain('"a"');
    expect(git(repoB, 'notes', '--ref=v1', 'show', c2)).toContain('"b"');
    expect(git(repoB, 'notes', '--ref=v2', 'show', c1)).toContain('"a"');
    expect(git(repoB, 'notes', '--ref=v2', 'show', c2)).toContain('"b"');
  });

  it('remembers a remote that refuses refs/notes/* and skips notes there for a day', () => {
    // An `update` hook declines only notes refs, the way Gerrit does.
    const hook = path.join(remote, 'hooks', 'update');
    fs.writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/notes/*) echo "notes not permitted" >&2; exit 1;; esac\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    git(repoA, 'notes', '--ref=origin-acceptance', 'add', '-m', '{}', c1);
    git(repoA, 'branch', 'origin-sessions');
    const extra: PrePushRef = { ref: 'refs/heads/origin-sessions', staging: 'refs/remotes/origin/origin-sessions', reconcile: () => true };
    const t0 = Date.now();

    const first = publishPrePushRefs(repoA, 'origin', { includeMemory: false, extraRefs: [extra], now: () => t0 });
    expect(first.outcomes).toEqual({
      'refs/notes/origin': 'refused',
      'refs/notes/origin-acceptance': 'refused',
      'refs/heads/origin-sessions': 'pushed',
    });
    expect(first.notesRefusedRecorded).toBe(true);
    expect(remoteRefusesNotes(repoA, 'origin', t0 + 1000)).toBe(true);

    // The next push does not offer notes at all — and with nothing else to
    // send, runs no git push.
    const { exec, count } = countingExec();
    const second = publishPrePushRefs(repoA, 'origin', { includeMemory: false, now: () => t0 + 60_000, exec });
    expect(second.notesSkipped).toBe(true);
    expect(count('push')).toBe(0);

    // A day later it asks again.
    expect(remoteRefusesNotes(repoA, 'origin', t0 + NOTES_REFUSED_TTL_MS + 1)).toBe(false);
    const third = countingExec();
    publishPrePushRefs(repoA, 'origin', { includeMemory: false, now: () => t0 + NOTES_REFUSED_TTL_MS + 1, exec: third.exec });
    expect(third.count('push')).toBe(1);
  });

  it('does not remember a refusal of the whole push (the branch was declined too)', () => {
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "push declined" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    git(repoA, 'branch', 'origin-sessions');
    const extra: PrePushRef = { ref: 'refs/heads/origin-sessions', staging: 'refs/remotes/origin/origin-sessions', reconcile: () => true };

    const result = publishPrePushRefs(repoA, 'origin', { includeMemory: false, extraRefs: [extra] });

    expect(result.outcomes['refs/notes/origin']).toBe('refused');
    expect(result.outcomes['refs/heads/origin-sessions']).toBe('refused');
    expect(result.notesRefusedRecorded).toBe(false);
    expect(remoteRefusesNotes(repoA, 'origin')).toBe(false);
  });

  it('a hanging remote costs at most the one budget, and nothing runs after it', () => {
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    let clock = 1_000_000;
    const calls: Array<{ args: string[]; timeout: number }> = [];
    const exec = ((file: string, args: string[], opts: { timeout: number }) => {
      calls.push({ args, timeout: opts.timeout });
      if (args[0] === 'push' || args[0] === 'fetch') {
        clock += opts.timeout; // hangs until killed
        throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
      }
      return execFileSync(file, args, opts as never);
    }) as unknown as typeof execFileSync;
    const start = clock;

    const result = publishPrePushRefs(repoA, 'origin', { includeMemory: false, now: () => clock, exec });

    expect(result.deadlineExceeded).toBe(true);
    expect(result.outcomes).toEqual({ 'refs/notes/origin': 'failed' });
    expect(calls.filter((c) => c.args[0] === 'push')).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === 'fetch')).toHaveLength(0);
    expect(clock - start).toBeLessThanOrEqual(PRE_PUSH_PUBLISH_BUDGET_MS);
    // A hang is not a refusal: the next push tries again.
    expect(remoteRefusesNotes(repoA, 'origin')).toBe(false);
  });
});

describe('parsePushPorcelain', () => {
  it('reads each destination ref and its result', () => {
    const out = [
      'To /tmp/remote.git',
      '*\trefs/notes/origin-acceptance:refs/notes/origin-acceptance\t[new reference]',
      '!\trefs/notes/origin:refs/notes/origin\t[rejected] (non-fast-forward)',
      '!\trefs/notes/origin-memory:refs/notes/origin-memory\t[remote rejected] (prohibited by Gerrit)',
      '=\trefs/heads/origin-sessions:refs/heads/origin-sessions\t[up to date]',
      'Done',
    ].join('\n');
    const parsed = parsePushPorcelain(out);
    expect(parsed.get('refs/notes/origin-acceptance')).toEqual({ flag: '*', summary: '[new reference]' });
    expect(parsed.get('refs/notes/origin')?.summary).toBe('[rejected] (non-fast-forward)');
    expect(parsed.get('refs/notes/origin-memory')?.summary).toMatch(/^\[remote rejected\]/);
    expect(parsed.get('refs/heads/origin-sessions')?.flag).toBe('=');
    expect(parsed.size).toBe(4);
  });
});
