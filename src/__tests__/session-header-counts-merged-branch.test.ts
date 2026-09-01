// The SESSION HEADER counted the branch a merge absorbed.
//
// #1385 fixed the per-TURN row for prod f7881a6e: a turn that runs `git merge`
// is credited with what it RESOLVED, not with the PR it pulled in. The
// session-level aggregate was left on the old footing, and post-commit sends
// it with `snapshot: true` — the server REPLACES the stored sessionDiff with
// it, so it is the number on the page.
//
// It came from `captureGitState(headShaAtStart).committedDiff`, which is the
// raw `session-start..HEAD` range. That range contains every line the merge
// brought with it. A session whose own work is one line reads as +41.
//
// It is not only merges: the same raw range holds commits a CONCURRENT agent
// made in a shared checkout, which is the reason `sessionScopedCommittedDiff`
// was written in the first place. handleStop has used it for the session-level
// snapshot for a while; post-commit was the last caller on the raw range.
//
// Post-commit is the one that matters. A commit-and-go agent never reaches
// Stop, so nothing ever came along to correct the header.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sessionToDateCommittedSnapshot } from '../commands/hooks.js';
import { captureGitState } from '../git-capture.js';

let repo: string;
const git = (...a: string[]) =>
  execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();

let sessionStart = '';
let ourSha = '';
let mergeSha = '';

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-session-hdr-')));
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'T');

  fs.writeFileSync(path.join(repo, 'base.ts'), 'export const BASE = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  sessionStart = git('rev-parse', 'HEAD');

  // Their PR: 40 lines this session never wrote.
  git('checkout', '-q', '-b', 'theirs');
  fs.writeFileSync(
    path.join(repo, 'their-feature.ts'),
    Array.from({ length: 40 }, (_, i) => `export const THEIRS_${i} = ${i};`).join('\n') + '\n',
  );
  git('add', '-A'); git('commit', '-q', '-m', 'their PR');

  // Our session: one line of its own, then it merges their PR in. The merge is
  // CLEAN — nothing was resolved, so the session authored nothing in it.
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'ours.ts'), 'export const OURS = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'our work');
  ourSha = git('rev-parse', 'HEAD');
  git('merge', '-q', '--no-ff', '--no-edit', 'theirs');
  mergeSha = git('rev-parse', 'HEAD');
});
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

const sessionState = (shas: string[]) => ({
  sessionId: 'sess-hdr',
  sessionTag: 'hdr',
  repoPath: repo,
  headShaAtStart: sessionStart,
  startedAt: new Date().toISOString(),
  sessionCommitShas: [...shas],
}) as any;

describe('the session header counts what the session wrote, not what it merged', () => {
  it('reproduces the raw range the header used to be built from', () => {
    const snap = captureGitState(repo, sessionStart, { fullContext: true });
    // The absorbed PR is in it, in full.
    expect(snap.committedDiff).toContain('THEIRS_0');
    expect(snap.committedDiff).toContain('THEIRS_39');
    expect(snap.linesAdded).toBeGreaterThanOrEqual(41);
  });

  it('credits the session with its own commit and none of the absorbed branch', () => {
    const snap = captureGitState(repo, sessionStart, { fullContext: true });
    const owned = sessionToDateCommittedSnapshot(repo, sessionState([ourSha, mergeSha]), {
      diff: snap.committedDiff,
      linesAdded: snap.linesAdded,
      linesRemoved: snap.linesRemoved,
    });

    expect(owned.scoped).toBe(true);
    expect(owned.diff).toContain('export const OURS = 1;');
    expect(owned.diff).not.toContain('THEIRS_');
    // One added line — `ours.ts`. The clean merge resolved nothing, so it
    // contributes nothing, and their 40 lines are gone.
    expect(owned.linesAdded).toBe(1);
    expect(owned.linesRemoved).toBe(0);
  });

  it('falls back to the raw range rather than blanking a session with no recorded shas', () => {
    // Codex bypasses .git/hooks/post-commit on some installs, so a session that
    // really did commit can carry an empty sha list. An empty snapshot would
    // REPLACE the stored sessionDiff with nothing — worse than inflating it.
    const snap = captureGitState(repo, sessionStart, { fullContext: true });
    const owned = sessionToDateCommittedSnapshot(repo, sessionState([]), {
      diff: snap.committedDiff,
      linesAdded: snap.linesAdded,
      linesRemoved: snap.linesRemoved,
    });

    expect(owned.scoped).toBe(false);
    expect(owned.diff).toBe(snap.committedDiff);
    expect(owned.linesAdded).toBe(snap.linesAdded);
  });
});
