/**
 * The search for a session from another repository has three answers, not two.
 *
 * `sessionsWorkingInForeignTree` returned `[]` both when no session reached the
 * committing checkout and when several did and were deliberately not guessed
 * between. post-commit could not tell those apart, so after the refusal it ran
 * its no-session process detection anyway: a host with exactly one standalone
 * agent running (a real Codex, here) turned "two sessions — not guessing" into
 * a `detected-codex-*` note on the commit. `findSessionWorkingInForeignTree`
 * keeps `none`, `unique` and `ambiguous` apart, and the git-hook lookup carries
 * the outcome to post-commit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findSessionWorkingInForeignTree } from '../foreign-trees.js';
import { listSessionsForGitHookUnscoped, lookupSessionsForGitHook } from '../commands/hooks/post-commit.js';
import { getGitCommonDir } from '../session-state.js';

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function makeRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  return fs.realpathSync.native(dir);
}

describe('foreign session lookup outcome', () => {
  let tmp: string;
  let repoB: string;
  let mirrorDir: string;
  const written: string[] = [];

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-foreign-outcome-')));
    repoB = makeRepo(tmp, 'repo-b');
    mirrorDir = path.join(os.homedir(), '.origin', 'sessions');
    fs.mkdirSync(mirrorDir, { recursive: true });
  });

  afterEach(() => {
    for (const f of written.splice(0)) fs.rmSync(f, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A live session homed in its own repository that reached `tree` in its running turn. */
  function mirrorSession(sessionId: string, tree: string, opts: { turnClosed?: boolean } = {}): void {
    const home = makeRepo(tmp, `home-${sessionId}`);
    const state: Record<string, unknown> = {
      sessionId,
      repoPath: home,
      startedAt: new Date().toISOString(),
      prompts: ['look at the other repository'],
      foreignTrees: [{ path: tree, commonDir: getGitCommonDir(repoB), at: new Date().toISOString(), turn: 0 }],
    };
    if (opts.turnClosed) state.lastClosedTurnIndex = 0;
    else state.activeTurn = { index: 0 };
    const file = path.join(mirrorDir, `${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(state));
    written.push(file);
  }

  it('none: no session reached the checkout', () => {
    expect(findSessionWorkingInForeignTree(repoB)).toEqual({ outcome: 'none' });
    expect(lookupSessionsForGitHook(repoB)).toMatchObject({ sessions: [], foreign: { outcome: 'none' } });
  });

  it('none: the only session that reached it has closed that turn', () => {
    mirrorSession('foreign-closed-0001', repoB, { turnClosed: true });

    expect(findSessionWorkingInForeignTree(repoB)).toEqual({ outcome: 'none' });
  });

  it('unique: one live session reached the checkout in its running turn', () => {
    mirrorSession('foreign-unique-0001', repoB);

    const found = findSessionWorkingInForeignTree(repoB);
    expect(found.outcome).toBe('unique');
    expect(found.outcome === 'unique' && found.session.sessionId).toBe('foreign-unique-0001');

    const lookup = lookupSessionsForGitHook(repoB);
    expect(lookup.foreign?.outcome).toBe('unique');
    expect(lookup.sessions.map((s) => s.sessionId)).toEqual(['foreign-unique-0001']);
  });

  it('unique: the session that recorded THIS tree wins over one that recorded only a sibling', () => {
    mirrorSession('foreign-exact-0001', repoB);
    mirrorSession('foreign-sibling-0002', path.join(tmp, 'repo-b-sibling-worktree'));

    const found = findSessionWorkingInForeignTree(repoB);
    expect(found.outcome === 'unique' && found.session.sessionId).toBe('foreign-exact-0001');
  });

  it('ambiguous: two live sessions reached the checkout and nothing tells them apart', () => {
    mirrorSession('foreign-first-0001', repoB);
    mirrorSession('foreign-second-0002', repoB);

    const found = findSessionWorkingInForeignTree(repoB);
    expect(found.outcome).toBe('ambiguous');
    expect(found.outcome === 'ambiguous' && [...found.sessionIds].sort())
      .toEqual(['foreign-first-0001', 'foreign-second-0002']);

    // The session list is empty exactly as for `none` — only the outcome
    // tells post-commit that process detection must not run.
    const lookup = lookupSessionsForGitHook(repoB);
    expect(lookup.sessions).toEqual([]);
    expect(lookup.foreign?.outcome).toBe('ambiguous');
    expect(listSessionsForGitHookUnscoped(repoB)).toEqual([]);
  });
});
