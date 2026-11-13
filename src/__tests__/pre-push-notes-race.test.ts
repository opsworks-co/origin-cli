/**
 * A lost race for refs/notes/origin is retried, not remembered as a remote that
 * refuses notes; and a successful notes publish forgets such a refusal.
 *
 * Found on RhodeCode (OR-38): `git commit && git push` runs the post-commit
 * auto-push and the pre-push publish of refs/notes/origin at the same time.
 * The push that loses the ref lock gets
 *
 *   remote: error: cannot lock ref 'refs/notes/origin': is at X but expected Y
 *   !  refs/notes/origin:refs/notes/origin  [remote rejected] (failed to update ref)
 *
 * and the pre-push publisher took that `[remote rejected]` for a remote that
 * declines refs/notes/*: no notes reached the server for a day.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  NOTES_REFUSED_TTL_MS,
  classifyPushLine,
  publishAttributionNotes,
  publishPrePushRefs,
  remoteRefusesNotes,
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

function countingExec() {
  const calls: string[][] = [];
  const exec = ((file: string, args: string[], opts: object) => {
    calls.push(args);
    return execFileSync(file, args, opts as never);
  }) as unknown as typeof execFileSync;
  return { exec, count: (sub: string) => calls.filter((a) => a[0] === sub).length };
}

describe('classifyPushLine', () => {
  const rejected = (reason: string) => classifyPushLine({ flag: '!', summary: `[remote rejected] (${reason})` });

  it('a ref that moved under the push is a retryable rejection', () => {
    expect(rejected('failed to update ref')).toBe('rejected');
    expect(rejected('failed to lock')).toBe('rejected');
    expect(rejected("cannot lock ref 'refs/notes/origin': is at 0a4f but expected e4fa")).toBe('rejected');
    expect(rejected('incorrect old value provided')).toBe('rejected');
  });

  it('any other remote rejection is still a refusal', () => {
    expect(rejected('prohibited by Gerrit')).toBe('refused');
    expect(rejected('hook declined')).toBe('refused');
    expect(rejected('pre-receive hook declined')).toBe('refused');
  });

  it('the other outcomes are unchanged', () => {
    expect(classifyPushLine({ flag: '!', summary: '[rejected] (non-fast-forward)' })).toBe('rejected');
    expect(classifyPushLine({ flag: '!', summary: '[rejected] (fetch first)' })).toBe('rejected');
    expect(classifyPushLine({ flag: '=', summary: '[up to date]' })).toBe('up-to-date');
    expect(classifyPushLine({ flag: '*', summary: '[new reference]' })).toBe('pushed');
    expect(classifyPushLine(undefined)).toBe('failed');
  });
});

describe('notes publish against a racing and a refusing remote', () => {
  let baseDir: string;
  let remote: string;
  let repoA: string;
  let repoB: string;
  let c1: string;

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-notes-race-')));
    remote = path.join(baseDir, 'remote.git');
    fs.mkdirSync(remote);
    git(remote, 'init', '-q', '--bare', '-b', 'main');
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

  const hook = (name: string, body: string) => {
    const file = path.join(remote, 'hooks', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };

  /**
   * Both clones start from the same notes on the remote. repoB's own note is
   * parked on the remote as refs/notes/winner; the first push that reaches the
   * remote afterwards finds refs/notes/origin moved to it between the
   * advertisement and the ref update — exactly what a concurrent push does.
   */
  function armRace(): { c2: string } {
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"base"}}', c1);
    git(repoA, 'push', '-q', 'origin', 'refs/notes/origin');
    fs.writeFileSync(path.join(repoB, 'b.txt'), 'b\n');
    git(repoB, 'add', '.');
    git(repoB, 'commit', '-q', '-m', 'C2');
    const c2 = git(repoB, 'rev-parse', 'HEAD');
    git(repoB, 'push', '-q', 'origin', 'main');
    git(repoB, 'fetch', '-q', 'origin', '+refs/notes/origin:refs/notes/origin');
    git(repoB, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"winner"}}', c2);
    git(repoB, 'push', '-q', 'origin', 'refs/notes/origin:refs/notes/winner');
    hook('pre-receive', [
      'cat >/dev/null',
      'if [ ! -f raced ]; then',
      '  touch raced',
      '  env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \\',
      '    git update-ref refs/notes/origin "$(git rev-parse refs/notes/winner)"',
      'fi',
      'exit 0',
    ].join('\n'));
    // repoA's new note on C1, based on the old remote tip.
    git(repoA, 'notes', '--ref=origin', 'add', '-f', '-m', '{"origin":{"sessionId":"loser"}}', c1);
    return { c2 };
  }

  // A ref moved before receive-pack's transaction gives "(incorrect old value provided)"; moved during it
  // (two pushes at once, as on the RhodeCode stand) "(failed to update ref)". Both are the same lost race.
  it('the race really gives git\'s "[remote rejected]" for a moved ref', () => {
    armRace();
    let out = '';
    try {
      git(repoA, 'push', '--porcelain', '--no-verify', 'origin', 'refs/notes/origin:refs/notes/origin');
    } catch (err) {
      out = String((err as { stdout?: string }).stdout ?? '');
    }
    expect(out).toMatch(
      /^!\trefs\/notes\/origin:refs\/notes\/origin\t\[remote rejected\] \((?:failed to update ref|incorrect old value provided)\)$/m,
    );
  });

  it('pre-push: a lost race is fetched, merged and pushed again, and not remembered', () => {
    const { c2 } = armRace();
    const { exec, count } = countingExec();

    const result = publishPrePushRefs(repoA, 'origin', { includeMemory: false, exec });

    expect(fs.existsSync(path.join(remote, 'raced'))).toBe(true);
    expect(count('push')).toBe(2);
    expect(count('fetch')).toBe(1);
    expect(result.outcomes['refs/notes/origin']).toBe('pushed');
    expect(result.notesRefusedRecorded).toBe(false);
    expect(remoteRefusesNotes(repoA, 'origin')).toBe(false);
    // Both sides' notes are on the remote: the winner's on C2, ours on C1.
    git(repoA, 'fetch', '-q', 'origin', '+refs/notes/origin:refs/notes/check');
    expect(git(repoA, 'notes', '--ref=check', 'show', c1)).toContain('"loser"');
    expect(git(repoA, 'notes', '--ref=check', 'show', c2)).toContain('"winner"');
  });

  it('auto-push / push-metadata: a lost race is retried after a merge', () => {
    armRace();
    const result = publishAttributionNotes(repoA, 'origin');
    expect(result).toMatchObject({ status: 'pushed', attempts: 2, merged: true });
    expect(remoteRefusesNotes(repoA, 'origin')).toBe(false);
  });

  it('a successful publishAttributionNotes forgets the refusal, and the next pre-push publishes notes again', () => {
    hook('update', 'case "$1" in refs/notes/*) echo "prohibited" >&2; exit 1;; esac\nexit 0');
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    const t0 = Date.now();
    const refused = publishPrePushRefs(repoA, 'origin', { includeMemory: false, now: () => t0 });
    expect(refused.outcomes['refs/notes/origin']).toBe('refused');
    expect(refused.notesRefusedRecorded).toBe(true);
    expect(remoteRefusesNotes(repoA, 'origin', t0 + 1000)).toBe(true);

    // The administrator grants refs/notes/*; the developer runs `origin push-metadata` once.
    fs.rmSync(path.join(remote, 'hooks', 'update'));
    expect(publishAttributionNotes(repoA, 'origin')).toMatchObject({ status: 'pushed' });
    expect(remoteRefusesNotes(repoA, 'origin', t0 + 2000)).toBe(false);
    expect(fs.existsSync(path.join(repoA, '.git', 'origin-notes-push-refused.json'))).toBe(false);

    fs.writeFileSync(path.join(repoA, 'c.txt'), 'c\n');
    git(repoA, 'add', '.');
    git(repoA, 'commit', '-q', '-m', 'C3');
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{"origin":{}}', 'HEAD');
    const { exec, count } = countingExec();
    const next = publishPrePushRefs(repoA, 'origin', { includeMemory: false, now: () => t0 + 3000, exec });
    expect(next.notesSkipped).toBe(false);
    expect(count('push')).toBe(1);
    expect(next.outcomes['refs/notes/origin']).toBe('pushed');
  });

  it('a pre-push that lands the notes forgets an expired refusal', () => {
    hook('update', 'case "$1" in refs/notes/*) echo "prohibited" >&2; exit 1;; esac\nexit 0');
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    const t0 = Date.now();
    expect(publishPrePushRefs(repoA, 'origin', { includeMemory: false, now: () => t0 }).notesRefusedRecorded).toBe(true);
    const file = path.join(repoA, '.git', 'origin-notes-push-refused.json');
    expect(fs.existsSync(file)).toBe(true);

    fs.rmSync(path.join(remote, 'hooks', 'update'));
    const later = t0 + NOTES_REFUSED_TTL_MS + 1;
    const result = publishPrePushRefs(repoA, 'origin', { includeMemory: false, now: () => later });
    expect(result.outcomes['refs/notes/origin']).toBe('pushed');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a refusal stays remembered while the remote keeps refusing', () => {
    hook('update', 'case "$1" in refs/notes/*) echo "prohibited" >&2; exit 1;; esac\nexit 0');
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{}', c1);
    const t0 = Date.now();
    publishPrePushRefs(repoA, 'origin', { includeMemory: false, now: () => t0 });
    expect(publishAttributionNotes(repoA, 'origin')).toMatchObject({ status: 'failed' });
    expect(remoteRefusesNotes(repoA, 'origin', t0 + 1000)).toBe(true);
  });
});
