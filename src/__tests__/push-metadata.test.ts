/**
 * OR-9/A3: one publisher for refs/notes/origin, used by `origin push-metadata`,
 * the pre-push hook and the auto-push after a note write.
 *
 * Pinned here, against real git and bare remotes:
 *   - fast-forward publish to a named remote, divergent notes → union, the
 *     same commit on both sides → the local note wins, idempotent re-runs;
 *   - no notes / no remote / a rejecting or unreachable remote;
 *   - the push never re-enters pre-push (--no-verify);
 *   - privacy: nothing publishes to a remote other than `origin` unless that
 *     remote is named to `origin push-metadata <remote>` — not pre-push, not
 *     the command's default, whatever notesIncludePrompts says now;
 *   - credentials in a remote URL never reach output or the debug log;
 *   - one wall-clock budget, classified runner outcomes, the identity probe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HOOK_PUBLISH_BUDGET_MS, INTERACTIVE_PUBLISH_BUDGET_MS, NOTES_PUSH_MAX_ATTEMPTS, normalizeMaxAttempts, publishAttributionNotes, resolveAutoPublishRemote } from '../git-notes.js';
import { runPushMetadata } from '../commands/push-metadata.js';
import { __resetGitIdentityProbe } from '../utils/exec.js';
import { handlePrePush } from '../commands/hooks.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

let base: string;
let remote: string;   // bare, configured as `upstream` (deliberately not `origin`)
let local: string;
let other: string;    // a second clone of the same remote
let c1: string;
let c2: string;

function configure(repo: string) {
  git(repo, 'config', 'user.email', 'dev@example.com');
  git(repo, 'config', 'user.name', 'Dev');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

function remoteNote(sha: string): string | null {
  try { return git(remote, 'notes', '--ref=origin', 'show', sha); } catch { return null; }
}

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-push-metadata-')));
  remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
  local = path.join(base, 'local');
  fs.mkdirSync(local);
  git(local, 'init', '-q', '-b', 'main');
  configure(local);
  fs.writeFileSync(path.join(local, 'a.txt'), 'a\n');
  git(local, 'add', '.');
  git(local, 'commit', '-q', '-m', 'C1');
  c1 = git(local, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(local, 'b.txt'), 'b\n');
  git(local, 'add', '.');
  git(local, 'commit', '-q', '-m', 'C2');
  c2 = git(local, 'rev-parse', 'HEAD');
  git(local, 'remote', 'add', 'upstream', remote);
  git(local, 'push', '-q', 'upstream', 'main');
  other = path.join(base, 'other');
  execFileSync('git', ['clone', '-q', '-o', 'upstream', remote, other], { stdio: 'pipe' });
  configure(other);
});

afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('publishAttributionNotes', () => {
  it('fast-forward publish to a remote that is not called origin', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-local"}}', c1);
    const result = publishAttributionNotes(local, 'upstream');
    expect(result).toEqual({ status: 'pushed', remote: 'upstream', attempts: 1, merged: false });
    expect(remoteNote(c1)).toContain('s-local');
  });

  it('divergent notes on different commits: the remote ends with the union', () => {
    git(other, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-other"}}', c1);
    git(other, 'push', '-q', 'upstream', 'refs/notes/origin');
    git(local, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-local"}}', c2);

    const result = publishAttributionNotes(local, 'upstream');
    expect(result).toMatchObject({ status: 'pushed', merged: true, attempts: 2 });
    expect(remoteNote(c1)).toContain('s-other');
    expect(remoteNote(c2)).toContain('s-local');
    // And the local ref now holds both too.
    expect(git(local, 'notes', '--ref=origin', 'show', c1)).toContain('s-other');
  });

  it('the same commit annotated on both sides: the local note wins, not concatenated', () => {
    git(other, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-other"}}', c2);
    git(other, 'push', '-q', 'upstream', 'refs/notes/origin');
    git(local, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-local"}}', c2);

    expect(publishAttributionNotes(local, 'upstream').status).toBe('pushed');
    expect(remoteNote(c2)).toBe('{"origin":{"sessionId":"s-local"}}');
  });

  it('re-running is idempotent and loses nothing', () => {
    git(other, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-other"}}', c1);
    git(other, 'push', '-q', 'upstream', 'refs/notes/origin');
    git(local, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-local"}}', c2);
    publishAttributionNotes(local, 'upstream');
    const tip = git(remote, 'rev-parse', 'refs/notes/origin');

    expect(publishAttributionNotes(local, 'upstream')).toEqual({ status: 'pushed', remote: 'upstream', attempts: 1, merged: false });
    expect(git(remote, 'rev-parse', 'refs/notes/origin')).toBe(tip);
    expect(remoteNote(c1)).toContain('s-other');
    expect(remoteNote(c2)).toContain('s-local');
  });

  it('no local notes ref → no-notes, nothing pushed', () => {
    expect(publishAttributionNotes(local, 'upstream')).toEqual({ status: 'no-notes' });
    expect(() => git(remote, 'rev-parse', '--verify', 'refs/notes/origin')).toThrow();
  });

  it('an unknown remote → no-remote', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    expect(publishAttributionNotes(local, 'nope')).toEqual({ status: 'no-remote', remote: 'nope' });
  });

  it('a remote that rejects every push fails after a bounded number of attempts', () => {
    // A server-side hook refusing the notes ref: never a non-fast-forward, so
    // no merge can help and the publisher must not spin.
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "notes are frozen" >&2\nexit 1\n');
    fs.chmodSync(path.join(remote, 'hooks', 'pre-receive'), '755');
    // The fixture git config disables hooks everywhere; re-enable them on the server.
    git(remote, 'config', 'core.hooksPath', path.join(remote, 'hooks'));
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    const result = publishAttributionNotes(local, 'upstream');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.attempts).toBeLessThanOrEqual(NOTES_PUSH_MAX_ATTEMPTS);
    expect(result.reason).toMatch(/frozen|rejected|declined/);
  });

  it('an unreachable remote fails without throwing', () => {
    git(local, 'remote', 'add', 'gone', path.join(base, 'does-not-exist.git'));
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    expect(publishAttributionNotes(local, 'gone').status).toBe('failed');
  });

  it('never runs the pre-push hook (no recursion into Origin\'s own hook)', () => {
    const marker = path.join(base, 'pre-push-ran');
    fs.mkdirSync(path.join(local, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(local, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    fs.chmodSync(path.join(local, '.git', 'hooks', 'pre-push'), '755');
    git(local, 'config', 'core.hooksPath', path.join(local, '.git', 'hooks'));
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);

    expect(publishAttributionNotes(local, 'upstream').status).toBe('pushed');
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('origin push-metadata', () => {
  it('publishes and says where', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s1"}}', c1);
    const out = runPushMetadata(local, 'upstream');
    expect(out.exitCode).toBe(0);
    expect(out.lines.join('\n')).toContain('Published refs/notes/origin to upstream');
    expect(remoteNote(c1)).toContain('s1');
  });

  it('no notes is a successful no-op', () => {
    const out = runPushMetadata(local, 'upstream');
    expect(out.exitCode).toBe(0);
    expect(out.lines.join('\n')).toMatch(/Nothing to publish/);
  });

  it('a missing remote is a user error', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    expect(runPushMetadata(local, 'nope')).toMatchObject({ exitCode: 1, lines: ['No remote named "nope".'] });
    git(local, 'remote', 'remove', 'upstream');
    expect(runPushMetadata(local).exitCode).toBe(1);
  });

  it('a real publish failure exits non-zero and never prints credentials', () => {
    const logPath = path.join(os.homedir(), '.origin', 'hooks.log');
    const before = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
    // Port 9 (discard) on loopback: refused immediately, no real network.
    const secretUrl = 'http://ci-bot:s3cr3t-t0ken@127.0.0.1:9/repo.git';
    git(local, 'remote', 'add', 'mirror', secretUrl);
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);

    const byName = runPushMetadata(local, 'mirror');
    const byUrl = runPushMetadata(local, secretUrl);
    for (const out of [byName, byUrl]) {
      expect(out.exitCode).toBe(1);
      expect(out.lines.join('\n')).not.toContain('s3cr3t');
    }
    expect(byUrl.lines.join('\n')).toContain('http://***@127.0.0.1:9/repo.git');

    // And a pre-push whose origin is that URL logs nothing secret either.
    git(local, 'remote', 'add', 'origin', secretUrl);
    const origCwd = process.cwd();
    process.chdir(local);
    return handlePrePush().finally(() => process.chdir(origCwd)).then(() => {
      const after = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
      expect(after.slice(before.length)).toMatch(/refs\/notes\/origin publish \{"status":"failed"/);
      expect(after.slice(before.length)).not.toContain('s3cr3t');
    });
  });

  it('with no remote named it is `origin`, never the branch upstream or the first remote', () => {
    git(local, 'remote', 'add', 'aaa', remote);
    git(local, 'config', 'branch.main.remote', 'upstream');
    expect(resolveAutoPublishRemote(local)).toBe('');
    git(local, 'remote', 'add', 'origin', remote);
    expect(resolveAutoPublishRemote(local)).toBe('origin');
  });
});

// PR review blocker: refs/notes/origin can carry redacted prompt text — by
// default, and in older notes whatever notesIncludePrompts says now — and the
// publisher sends the WHOLE ref. So nothing publishes it to a remote other
// than `origin` unless that remote is named to `origin push-metadata <remote>`.
describe('privacy: where refs/notes/origin may go', () => {
  const origCwd = process.cwd();
  afterEach(() => process.chdir(origCwd));
  const PROMPT_NOTE = JSON.stringify({ origin: {
    sessionId: 's1',
    promptSummary: 'UNIQUE-SUMMARY-7c1e',
    fullPrompt: 'UNIQUE-FULL-PROMPT-7c1e',
    prompts: [{ index: 0, text: 'UNIQUE-PROMPT-TEXT-7c1e' }],
  } });
  const tip = (repo: string): string | null => {
    try { return git(repo, 'rev-parse', '--verify', 'refs/notes/origin'); } catch { return null; }
  };

  /** local has `origin` (own) and `upstream` (remote); upstream already holds an unrelated notes tip. */
  function withOriginAndSeededUpstream(): { own: string; upstreamTip: string } {
    const own = path.join(base, 'own.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', own], { stdio: 'pipe' });
    git(local, 'remote', 'add', 'origin', own);
    git(other, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"upstream-own"}}', c1);
    git(other, 'push', '-q', 'upstream', 'refs/notes/origin');
    return { own, upstreamTip: tip(remote)! };
  }

  it('pre-push (git push upstream): origin gets the prompt-bearing notes, upstream is untouched', async () => {
    const { own, upstreamTip } = withOriginAndSeededUpstream();
    git(local, 'notes', '--ref=origin', 'add', '-m', PROMPT_NOTE, c2);
    process.chdir(local);
    // Git runs the hook for `git push upstream`; the hook publishes by policy, not by the push's remote.
    await handlePrePush();

    expect(git(own, 'notes', '--ref=origin', 'show', c2)).toContain('UNIQUE-FULL-PROMPT-7c1e');
    expect(tip(remote)).toBe(upstreamTip);
    expect(() => git(remote, 'notes', '--ref=origin', 'show', c2)).toThrow();
  });

  it('older prompt-bearing notes stay off upstream after notesIncludePrompts: false', async () => {
    const { own, upstreamTip } = withOriginAndSeededUpstream();
    git(local, 'notes', '--ref=origin', 'add', '-m', PROMPT_NOTE, c2);          // written under the default
    fs.writeFileSync(path.join(local, '.origin.json'), JSON.stringify({ notesIncludePrompts: false }));
    process.chdir(local);
    await handlePrePush();

    expect(tip(remote)).toBe(upstreamTip);
    expect(git(own, 'notes', '--ref=origin', 'show', c2)).toContain('s1');
    // The deliberate way still works.
    expect(runPushMetadata(local, 'upstream').exitCode).toBe(0);
    expect(git(remote, 'notes', '--ref=origin', 'show', c2)).toContain('UNIQUE-SUMMARY-7c1e');
  });

  it('a repo whose only remote is upstream: pre-push publishes nowhere and completes', async () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', PROMPT_NOTE, c1);
    process.chdir(local);
    await expect(handlePrePush()).resolves.toBeUndefined();
    expect(tip(remote)).toBeNull();
  });

  it('`origin push-metadata upstream` publishes there, deliberately', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', PROMPT_NOTE, c1);
    const out = runPushMetadata(local, 'upstream');
    expect(out.exitCode).toBe(0);
    expect(git(remote, 'notes', '--ref=origin', 'show', c1)).toContain('UNIQUE-PROMPT-TEXT-7c1e');
  });

  it('`origin push-metadata` with no argument publishes to origin even when the branch tracks upstream', () => {
    const { own, upstreamTip } = withOriginAndSeededUpstream();
    git(local, 'config', 'branch.main.remote', 'upstream');
    git(local, 'notes', '--ref=origin', 'add', '-m', PROMPT_NOTE, c2);
    const out = runPushMetadata(local);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join('\n')).toContain('to origin');
    expect(git(own, 'notes', '--ref=origin', 'show', c2)).toContain('s1');
    expect(tip(remote)).toBe(upstreamTip);
  });

  it('`origin push-metadata` with no argument and no origin: exit 1, nothing published, name it explicitly', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', PROMPT_NOTE, c1);
    const out = runPushMetadata(local);
    expect(out.exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain('origin push-metadata <remote>');
    expect(tip(remote)).toBeNull();
  });

  it('a metadata publish failure does not fail the push', async () => {
    git(local, 'remote', 'add', 'origin', path.join(base, 'does-not-exist.git'));
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    process.chdir(local);
    // Resolves (no process.exit): only the governance block exits non-zero,
    // and that is pinned in pre-push-exit-code.test.ts.
    await expect(handlePrePush()).resolves.toBeUndefined();
  });
});

describe('normalizeMaxAttempts', () => {
  it.each([
    [undefined, NOTES_PUSH_MAX_ATTEMPTS],
    [1, 1],
    [2, 2],
    [0, 1],
    [-5, 1],
    [1.9, 1],
    [Number.NaN, NOTES_PUSH_MAX_ATTEMPTS],
    [Number.POSITIVE_INFINITY, NOTES_PUSH_MAX_ATTEMPTS],
    [Number.NEGATIVE_INFINITY, NOTES_PUSH_MAX_ATTEMPTS],
    [NOTES_PUSH_MAX_ATTEMPTS + 10, NOTES_PUSH_MAX_ATTEMPTS],
  ])('%s → %s', (input, expected) => {
    expect(normalizeMaxAttempts(input as number | undefined)).toBe(expected);
  });

  it('NaN still publishes (it no longer means zero attempts)', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    expect(publishAttributionNotes(local, 'upstream', { maxAttempts: Number.NaN }).status).toBe('pushed');
  });
});

// OR-9 review P2: one wall-clock budget for the whole publish, not per command.
// A fake clock and a recording runner around real git: nothing actually waits.
describe('publish deadline', () => {
  /** Real git, but every push "takes" `pushMs` on a fake clock; records what ran. */
  function timed(pushMs: number) {
    let t = 1_000_000;
    const ran: string[][] = [];
    const timeouts: number[] = [];
    const exec = ((cmd: string, args: string[], o: any) => {
      ran.push(args);
      timeouts.push(o.timeout);
      try {
        return execFileSync(cmd, args, o);
      } finally {
        if (args[0] === 'push') t += pushMs;
      }
    }) as unknown as typeof execFileSync;
    return { now: () => t, exec, ran, timeouts };
  }

  function diverge() {
    git(other, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-other"}}', c1);
    git(other, 'push', '-q', 'upstream', 'refs/notes/origin');
    git(local, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-local"}}', c2);
  }

  it('a spent budget starts no fetch, merge or retry after the rejected push', () => {
    diverge();
    const clock = timed(9_500);
    const result = publishAttributionNotes(local, 'upstream', { budgetMs: 10_000, now: clock.now, exec: clock.exec });
    expect(result).toMatchObject({ status: 'failed', attempts: 1 });
    if (result.status === 'failed') expect(result.reason).toMatch(/^deadline exceeded/);
    const verbs = clock.ran.map((a) => a[0]);
    expect(verbs.filter((v) => v === 'push')).toHaveLength(1);
    expect(verbs).not.toContain('fetch');
    expect(verbs).not.toContain('notes');
  });

  it('every command gets only the time that is left', () => {
    diverge();
    const clock = timed(4_000);
    const result = publishAttributionNotes(local, 'upstream', { budgetMs: 10_000, now: clock.now, exec: clock.exec });
    // push (4s) → fetch → merge → push (4s) → 2s left: the retry push had to fit in what remained.
    expect(result).toMatchObject({ status: 'pushed', attempts: 2, merged: true });
    const pushTimeouts = clock.ran.map((a, i) => [a[0], clock.timeouts[i]] as const).filter(([v]) => v === 'push').map(([, t]) => t);
    expect(pushTimeouts[0]).toBeLessThanOrEqual(10_000);
    expect(pushTimeouts[1]).toBeLessThanOrEqual(6_000);
  });

  it('the fast-forward happy path is unchanged', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s1"}}', c1);
    const clock = timed(100);
    expect(publishAttributionNotes(local, 'upstream', { now: clock.now, exec: clock.exec }))
      .toEqual({ status: 'pushed', remote: 'upstream', attempts: 1, merged: false });
    expect(clock.ran.filter((a) => a[0] === 'push')).toHaveLength(1);
  });

  it('no budget at all: nothing starts, the result is a structured failure', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    const clock = timed(0);
    const result = publishAttributionNotes(local, 'upstream', { budgetMs: 0, now: clock.now, exec: clock.exec });
    expect(result).toMatchObject({ status: 'failed', attempts: 0 });
    expect(clock.ran).toEqual([]);
  });

  it('the interactive command exits non-zero on a deadline', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    const out = runPushMetadata(local, 'upstream', { budgetMs: 0 });
    expect(out.exitCode).toBe(1);
    expect(out.lines.join('\n')).toMatch(/deadline exceeded/);
    expect(remoteNote(c1)).toBeNull();
  });

  it('budgets: hooks short, the interactive command longer, both finite', () => {
    expect(HOOK_PUBLISH_BUDGET_MS).toBeLessThanOrEqual(30_000);
    expect(INTERACTIVE_PUBLISH_BUDGET_MS).toBeGreaterThan(HOOK_PUBLISH_BUDGET_MS);
    expect(Number.isFinite(INTERACTIVE_PUBLISH_BUDGET_MS)).toBe(true);
  });

  it('pre-push: a publish that runs out of budget is logged and the push goes on', async () => {
    const origCwd = process.cwd();
    vi.resetModules();
    vi.doMock('../git-notes.js', async () => {
      const actual = await vi.importActual<typeof import('../git-notes.js')>('../git-notes.js');
      return { ...actual, publishAttributionNotes: (r: string, rem: string) => actual.publishAttributionNotes(r, rem, { budgetMs: 0 }) };
    });
    try {
      const { handlePrePush: prePush } = await import('../commands/hooks.js');
      git(local, 'remote', 'rename', 'upstream', 'origin');
      git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
      const logPath = path.join(os.homedir(), '.origin', 'hooks.log');
      const before = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').length : 0;
      process.chdir(local);
      await expect(prePush()).resolves.toBeUndefined();
      expect(fs.readFileSync(logPath, 'utf-8').slice(before)).toMatch(/deadline exceeded/);
      expect(remoteNote(c1)).toBeNull();
    } finally {
      process.chdir(origCwd);
      vi.doUnmock('../git-notes.js');
      vi.resetModules();
    }
  });
});

// OR-9 review 2: every child process of a publish — the committer-identity
// probe included — runs through the budgeted runner, and a deadline is never
// reported as an ordinary git answer.
describe('publish runner: outcomes and the identity probe', () => {
  type Rule = (args: string[]) => 'timeout' | 'fail' | undefined;
  /**
   * Real git behind a recording runner. `rule` can make a command time out
   * (ETIMEDOUT, as execFileSync reports it) or fail; `cost` advances a fake
   * clock after a command, so budgets can run out exactly where a test wants.
   */
  function runner(rule: Rule = () => undefined, cost: (args: string[]) => number = () => 0) {
    let t = 5_000_000;
    const ran: string[][] = [];
    const timeouts = new Map<string, number>();
    const exec = ((cmd: string, args: string[], o: any) => {
      ran.push(args);
      timeouts.set(args.slice(0, 2).join(' '), o.timeout);
      try {
        const r = rule(args);
        if (r === 'timeout') throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
        if (r === 'fail') throw Object.assign(new Error('Command failed'), { status: 1, stderr: 'fatal: scripted failure' });
        return execFileSync(cmd, args, o);
      } finally {
        t += cost(args);
      }
    }) as unknown as typeof execFileSync;
    const verbs = () => ran.map((a) => a.slice(0, 2).join(' '));
    return { now: () => t, exec, ran, verbs, timeouts };
  }
  const is = (...prefix: string[]) => (args: string[]) => prefix.every((p, i) => args[i] === p);

  function diverge() {
    git(other, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-other"}}', c1);
    git(other, 'push', '-q', 'upstream', 'refs/notes/origin');
    git(local, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"s-local"}}', c2);
  }
  beforeEach(() => __resetGitIdentityProbe());

  // ── error classification ──
  it('1. rejected push, then a timed-out fetch → the deadline, not the old rejection', () => {
    diverge();
    const r = runner((a) => (a[0] === 'fetch' ? 'timeout' : undefined));
    const result = publishAttributionNotes(local, 'upstream', { now: r.now, exec: r.exec });
    expect(result).toMatchObject({ status: 'failed', attempts: 1 });
    if (result.status !== 'failed') return;
    expect(result.reason).toMatch(/^deadline exceeded: .*while fetching the remote notes/);
    expect(result.reason).not.toMatch(/rejected|non-fast-forward/);
  });

  it('2. a timed-out local notes probe → failed, not no-notes', () => {
    const r = runner((a) => (is('rev-parse', '--verify', '--quiet', 'refs/notes/origin')(a) ? 'timeout' : undefined));
    const result = publishAttributionNotes(local, 'upstream', { now: r.now, exec: r.exec });
    expect(result).toMatchObject({ status: 'failed' });
    if (result.status === 'failed') expect(result.reason).toMatch(/^deadline exceeded/);
  });

  it('3. a timed-out remote probe → failed, not no-remote', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    const r = runner((a) => (is('remote', 'get-url')(a) ? 'timeout' : undefined));
    const result = publishAttributionNotes(local, 'nope', { now: r.now, exec: r.exec });
    expect(result).toMatchObject({ status: 'failed' });
    if (result.status === 'failed') expect(result.reason).toMatch(/^deadline exceeded: .*resolving the remote/);
  });

  it('4. an ordinary missing notes ref is still no-notes', () => {
    const r = runner();
    expect(publishAttributionNotes(local, 'upstream', { now: r.now, exec: r.exec })).toEqual({ status: 'no-notes' });
  });

  it('5. an ordinary unknown remote is still no-remote', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    const r = runner();
    expect(publishAttributionNotes(local, 'nope', { now: r.now, exec: r.exec })).toEqual({ status: 'no-remote', remote: 'nope' });
  });

  it('6. an ordinary "not an ancestor" from merge-base goes on to merge and retry', () => {
    diverge();
    const r = runner();
    expect(publishAttributionNotes(local, 'upstream', { now: r.now, exec: r.exec }))
      .toMatchObject({ status: 'pushed', attempts: 2, merged: true });
    const v = r.verbs();
    expect(v.indexOf('merge-base --is-ancestor')).toBeGreaterThan(-1);
    expect(v.indexOf('notes --ref=refs/notes/origin')).toBeGreaterThan(v.indexOf('merge-base --is-ancestor'));
    expect(remoteNote(c1)).toContain('s-other');
    expect(remoteNote(c2)).toContain('s-local');
  });

  // ── identity probe ──
  it('a merge on a cold identity cache probes through the injected runner, before the merge', () => {
    diverge();
    const r = runner();
    expect(publishAttributionNotes(local, 'upstream', { now: r.now, exec: r.exec }).status).toBe('pushed');
    const v = r.verbs();
    expect(v).toContain('var GIT_COMMITTER_IDENT');
    expect(v.indexOf('var GIT_COMMITTER_IDENT')).toBeLessThan(v.indexOf('notes --ref=refs/notes/origin'));
  });

  it('a budget spent before the probe starts neither the probe nor the merge', () => {
    diverge();
    // merge-base "takes" the rest of a 20s budget.
    const r = runner(undefined, (a) => (a[0] === 'merge-base' ? 19_900 : 0));
    const result = publishAttributionNotes(local, 'upstream', { budgetMs: 20_000, now: r.now, exec: r.exec });
    expect(result).toMatchObject({ status: 'failed', attempts: 1 });
    if (result.status === 'failed') expect(result.reason).toMatch(/^deadline exceeded: .*before checking the git identity/);
    expect(r.verbs()).not.toContain('var GIT_COMMITTER_IDENT');
    expect(r.verbs()).not.toContain('notes --ref=refs/notes/origin');
  });

  it('a probe given only the remaining budget that times out is a deadline failure', () => {
    diverge();
    const r = runner((a) => (a[0] === 'var' ? 'timeout' : undefined), (a) => (a[0] === 'merge-base' ? 17_000 : 0));
    const result = publishAttributionNotes(local, 'upstream', { budgetMs: 20_000, now: r.now, exec: r.exec });
    expect(r.timeouts.get('var GIT_COMMITTER_IDENT')).toBeLessThanOrEqual(3_000);
    expect(result).toMatchObject({ status: 'failed' });
    if (result.status === 'failed') expect(result.reason).toMatch(/^deadline exceeded: .*while checking the git identity/);
    expect(r.verbs()).not.toContain('notes --ref=refs/notes/origin');
  });

  it('a fast-forward publish needs no identity and runs no probe', () => {
    git(local, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    const r = runner();
    expect(publishAttributionNotes(local, 'upstream', { now: r.now, exec: r.exec }).status).toBe('pushed');
    expect(r.verbs()).not.toContain('var GIT_COMMITTER_IDENT');
    expect(r.ran).toHaveLength(3); // rev-parse, remote get-url, push
  });
});
