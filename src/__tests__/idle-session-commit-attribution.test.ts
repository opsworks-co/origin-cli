// Regression: an IDLE session is not a DEAD session, and treating it as one
// left a real commit with no owner at capture time.
//
// Prod agy session 168c6ab6 (repo korop), proven from the live rows:
//   18:58:41  turn 2 writes surprise.md, leaves it uncommitted
//             (last agy hook of the turn → last touch of the state file)
//   00:35:49  the commit lands — 5h37m later, past the 3h staleness window.
//             Every candidate is filtered out, so prepare-commit-msg writes no
//             Origin-Session trailer and post-commit picks no updateTargets:
//             the row reaches the server with sessionId NULL.
//             (Commit.createdAt 00:35:51, aiDetectionMethod later overwritten
//             to 'author-time-window' by the repo-sync backlink at 01:08 —
//             32 minutes after the user had already seen the hole.)
//   00:38:37  turn 3's commit, 3 minutes on, attributes fine — its tool calls
//             had just re-touched the state file. Same session, same repo,
//             opposite outcomes, decided purely by mtime.
//
// Antigravity fires only Pre/PostToolUse plus a Stop at process exit, so a
// session that is merely thinking (or waiting on the human) goes "stale" while
// its agent is very much running — this session's server-side endedAt is 00:39,
// six hours after it started.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pickActiveSessionForCommit, pickIdleOwnerByFileEvidence } from '../commands/hooks.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const HOURS = 60 * 60 * 1000;

describe('idle-but-unended session still owns its own commit', () => {
  let dir: string;

  function writeSession(tag: string, state: Record<string, any>) {
    const f = path.join(dir, '.git', `origin-session-${tag}.json`);
    fs.writeFileSync(f, JSON.stringify({ sessionTag: tag, status: 'RUNNING', ...state }));
    return f;
  }

  // Push a state file past the 3h staleness cutoff, the way real wall-clock
  // idling does.
  function ageFile(f: string, hoursAgo: number) {
    const t = (Date.now() - hoursAgo * HOURS) / 1000;
    fs.utimesSync(f, t, t);
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-idle-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@o.dev');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'seed');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('attributes a commit made 5h37m after the last hook, on recorded-file evidence', () => {
    const base = git(dir, 'rev-parse', 'HEAD');
    // Turn 2's work, still sitting in the tree hours later.
    fs.writeFileSync(path.join(dir, 'surprise.md'), '# Surprise File\n');
    const f = writeSession('agy-conv1', {
      sessionId: '168c6ab6-bebe-442b-b1a0-23dd6b1e6c5f',
      agentSlug: 'antigravity', model: 'gemini-3.1-pro',
      repoPath: dir, lastCwd: dir, headShaAtStart: base,
      startedAt: '2026-08-23T18:06:17Z',
      completedPromptMappings: [{ promptIndex: 1, promptText: 'create some shit … and commit it', filesChanged: ['surprise.md'] }],
    });
    ageFile(f, 5.6);

    git(dir, 'add', 'surprise.md');
    const picked = pickActiveSessionForCommit(dir);
    expect(picked?.sessionId).toBe('168c6ab6-bebe-442b-b1a0-23dd6b1e6c5f');
  });

  it('does not bury the session it just credited', () => {
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'surprise.md'), '# Surprise File\n');
    const f = writeSession('agy-conv1', {
      sessionId: 'agy-live', agentSlug: 'antigravity', model: 'gemini-3.1-pro',
      repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-08-23T18:06:17Z',
      completedPromptMappings: [{ promptIndex: 1, promptText: 'p', filesChanged: ['surprise.md'] }],
    });
    ageFile(f, 5.6);

    git(dir, 'add', 'surprise.md');
    pickActiveSessionForCommit(dir);
    // The agent is still running — marking it ENDED on disk would break every
    // later hook in the same session (turn 3 committed 3 minutes after this).
    const after = JSON.parse(fs.readFileSync(f, 'utf-8'));
    expect(after.status).not.toBe('ENDED');
    expect(after.endedAt).toBeFalsy();
  });

  it('still refuses a stale session that never recorded these files', () => {
    // The bug this staleness filter exists for: a never-ended Cursor session
    // stamped onto another agent's commit. It recorded work on b.txt; the
    // commit is surprise.md, so there is no evidence and it stays dead.
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'surprise.md'), 'x\n');
    const f = writeSession('zombie', {
      sessionId: 'zzz-0000', agentSlug: 'cursor', model: 'composer-2.5-fast',
      repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-18T00:00:00Z',
      completedPromptMappings: [{ promptIndex: 0, promptText: 'p', filesChanged: ['b.txt'] }],
    });
    ageFile(f, 5);

    git(dir, 'add', 'surprise.md');
    expect(pickActiveSessionForCommit(dir)).toBeNull();
    const after = JSON.parse(fs.readFileSync(f, 'utf-8'));
    expect(after.status).toBe('ENDED'); // still auto-closed
  });

  it('never revives on the baseline-diff fallback alone', () => {
    // A stale session with NO recorded mappings: sessionTouchedFiles would
    // happily return surprise.md by diffing the tree against its baseline, but
    // "the tree changed since I started" is true for every bystander session in
    // the repo. Only the session's own per-prompt capture counts as evidence.
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'surprise.md'), 'x\n');
    const f = writeSession('bystander', {
      sessionId: 'bys-0000', agentSlug: 'cursor', model: 'composer-2.5-fast',
      repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-18T00:00:00Z',
    });
    ageFile(f, 5);

    git(dir, 'add', 'surprise.md');
    expect(pickActiveSessionForCommit(dir)).toBeNull();
  });
});

describe('pickIdleOwnerByFileEvidence gates', () => {
  const idle = (sessionId: string, files: string[], extra: Record<string, any> = {}) =>
    ({ sessionId, status: 'RUNNING', completedPromptMappings: [{ promptIndex: 0, filesChanged: files }], ...extra }) as any;

  it('returns null without commit files — no evidence, no revival', () => {
    expect(pickIdleOwnerByFileEvidence([idle('a', ['x.ts'])], undefined)).toBeNull();
    expect(pickIdleOwnerByFileEvidence([idle('a', ['x.ts'])], [])).toBeNull();
  });

  it('refuses a session that ended properly', () => {
    const ended = idle('a', ['x.ts'], { status: 'ENDED', endedAt: '2026-08-23T19:00:00Z' });
    expect(pickIdleOwnerByFileEvidence([ended], ['x.ts'])).toBeNull();
  });

  it('refuses a tie rather than flipping a coin', () => {
    const picked = pickIdleOwnerByFileEvidence(
      [idle('a', ['x.ts']), idle('b', ['x.ts'])],
      ['x.ts'],
    );
    expect(picked).toBeNull();
  });

  it('takes a clear winner on overlap count', () => {
    const picked = pickIdleOwnerByFileEvidence(
      [idle('a', ['x.ts']), idle('b', ['x.ts', 'y.ts'])],
      ['x.ts', 'y.ts'],
    );
    expect(picked?.sessionId).toBe('b');
  });
});
