// A commit of nothing but pre-session dirt gives the session header nothing.
//
// Session 7585fda6 (2026-11-02) resumed an issue whose 12 files an earlier
// launch had written and left uncommitted, and committed them unchanged.
// Post-commit recorded the commit. The owned render dropped all 12 files as
// pre-session dirt and came out empty, and sessionAuthoredSnapshot read that
// empty answer as "post-commit missed": its trailer walk rendered the same
// commit whole, with no dirt rule. The header read +402/-18 over a turn of
// +0/-0, and the release gate flagged header_exceeds_turns.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { captureSessionStartBaseline } from '../commands/hooks/session-start.js';
import { sessionAuthoredSnapshot } from '../commands/hooks/post-commit.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } } });

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

const SESSION_ID = '7585fda6-cbd4-4861-ab80-1cbfecedc720';
const TRAILER = `Origin-Session: ${SESSION_ID.slice(0, 12)} | Claude Code | 1 prompt | turn 1`;

/**
 * A repo whose `left.ts` and `right.ts` were already edited, uncommitted, when
 * the session started. `extra` runs after the session-start baseline, before
 * the session commits both files with its trailer.
 */
function sessionCommittingStartDirt(prefix: string, extra?: (repo: string) => void) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.t'); git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'left.ts'), 'export const LEFT = 0;\n');
  fs.writeFileSync(path.join(repo, 'right.ts'), 'export const RIGHT = 0;\n');
  git(repo, 'add', '-A');
  execFileSync('git', ['commit', '-qm', 'base'], {
    cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 3600_000).toISOString() },
  });
  // The earlier launch's work, left uncommitted.
  fs.writeFileSync(path.join(repo, 'left.ts'), Array.from({ length: 20 }, (_, i) => `export const LEFT_${i} = ${i};`).join('\n') + '\n');
  fs.writeFileSync(path.join(repo, 'right.ts'), Array.from({ length: 10 }, (_, i) => `export const RIGHT_${i} = ${i};`).join('\n') + '\n');
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  const baseline = captureSessionStartBaseline(repo, prefix);
  expect(baseline.sessionStartDirtyFiles).toEqual(['left.ts', 'right.ts']);
  extra?.(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'commit the issue work', '-m', TRAILER);
  const sha = git(repo, 'rev-parse', 'HEAD');
  const state = (recorded: string[]) => ({
    sessionId: SESSION_ID, sessionTag: prefix, repoPath: repo, startedAt,
    ...baseline,
    sessionCommitShas: recorded,
    promptTurnIds: ['t_turn1'],
    promptIndexBase: 0,
  }) as any;
  return { repo, sha, state };
}

describe('a commit of pre-session dirt, committed unchanged', () => {
  it('post-commit recorded it: the header is empty, not the trailer walk of the same commit', () => {
    const { repo, sha, state } = sessionCommittingStartDirt('origin-startdirt-recorded-');
    const header = sessionAuthoredSnapshot(repo, state([sha]));
    expect(header.filesChanged).toEqual([]);
    expect(header.linesAdded).toBe(0);
    expect(header.linesRemoved).toBe(0);
    expect(header.source).toBe('none');
  });

  it('post-commit missed it: the trailer walk drops the same pre-session dirt', () => {
    const { repo, state } = sessionCommittingStartDirt('origin-startdirt-missed-');
    const header = sessionAuthoredSnapshot(repo, state([]));
    expect(header.filesChanged).toEqual([]);
    expect(header.linesAdded).toBe(0);
  });
});

describe('a commit that carries work of the session beside the dirt', () => {
  it('keeps the file the session changed after it started, by either route', () => {
    const { repo, sha, state } = sessionCommittingStartDirt('origin-startdirt-edited-', (r) => {
      fs.appendFileSync(path.join(r, 'right.ts'), 'export const RIGHT_OURS = 1;\n');
    });
    for (const recorded of [[sha], []]) {
      const header = sessionAuthoredSnapshot(repo, state(recorded));
      expect(header.filesChanged).toEqual(['right.ts']);
      expect(header.diff).not.toContain('LEFT_');
    }
  });
});
