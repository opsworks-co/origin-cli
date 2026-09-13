/**
 * A pull inside a turn is not the turn's work — and the shadow window must not
 * put it back after the ledger took it out.
 *
 * Session 9f8501f7 turn 2 wrote 4 files (+200/-10) and, mid-turn, ran
 * `git merge --ff-only origin/main`, fast-forwarding #1593 (24 files,
 * +404/-80, committed by GitHub, trailered to other sessions). Stop's log:
 *
 *   [ledger] turn capture taken from the write journal {inherited:24, files:4, netZero:22}
 *   [stop] shadow window replaced reconstructed diff with git {files:26, linesAdded:602, linesRemoved:88}
 *
 * The ledger had the right answer; `preferShadowRangeForTurns` replaced it
 * with the raw `shadow → worktree` delta, which holds every byte the
 * fast-forward wrote. The session header (+200/-10) stayed right, so the page
 * showed a turn three times bigger than the session it belongs to.
 *
 * Driven against REAL git: the rule turns on which commits sit between the
 * two shadows and whose they are.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit } from '../git-capture.js';
import { preferShadowRangeForTurns } from '../prefer-shadow-range.js';
import type { ShadowRangeMapping } from '../prefer-shadow-range.js';
import { windowInheritsCommitsForTurn } from '../commands/hooks.js';

const TURN = 't_e556ba166d4d479e';
const SESSION_STARTED_AT = '2026-09-13T01:10:12.000Z';
const UPSTREAM_AT = '2026-09-13T01:50:00 +0000';
const OWN_FILE = 'apps/api/src/utils/commit-attribution.ts';

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';

/**
 * A turn boundary the way the hooks record one: a shadow commit over a dirty
 * tree, or HEAD itself — marked complete — when the tree is clean (no shadow
 * is cut for a tree identical to HEAD).
 */
function boundary(promptIndex: number, tag: string) {
  const shadow = createShadowCommit(repo, tag);
  return shadow
    ? { promptIndex, shadowSha: shadow }
    : { promptIndex, shadowSha: git('rev-parse', 'HEAD'), completeBaseline: true };
}

/** A squash-merge landed on GitHub by someone else's session. */
function landUpstream(): string {
  git('checkout', '-q', '-b', 'upstream');
  write('apps/api/src/routes/mcp.ts', lines(40, 'mcp'));
  write('packages/cli/src/prefer-shadow-range.ts', lines(30, 'window'));
  git('add', '.');
  execFileSync('git', ['commit', '-q', '-m', 'fix(capture): preserve complete turn windows (#1593)\n\nOrigin-Session: 081e0a26-dbb | Claude Code | 29 prompts'], {
    cwd: repo, stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Artem Dolobanko', GIT_AUTHOR_EMAIL: 'dolobanko@gmail.com', GIT_AUTHOR_DATE: UPSTREAM_AT,
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_DATE: UPSTREAM_AT,
    },
  });
  const sha = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return sha;
}

const writeOwnEdit = () => write(OWN_FILE, lines(3, 'attr') + 'export const detached = true;\n');

const OWN_DIFF = [
  `diff --git a/${OWN_FILE} b/${OWN_FILE}`,
  `--- a/${OWN_FILE}`,
  `+++ b/${OWN_FILE}`,
  '@@ -3,0 +4,1 @@',
  '+export const detached = true;',
  '',
].join('\n');

/** What the ledger rendered: the turn's own file, nothing the pull wrote. */
function ledgerRow(): ShadowRangeMapping {
  return {
    promptIndex: 0,
    filesChanged: [OWN_FILE],
    diff: OWN_DIFF,
    linesAdded: 1,
    linesRemoved: 0,
    diffSource: 'ledger',
  };
}

function stateFor(shadows: Array<{ promptIndex: number; shadowSha: string; completeBaseline?: boolean }>, extra: Record<string, unknown> = {}) {
  return {
    sessionId: '9f8501f7-e316-4c67-ae31-58c076423b37',
    sessionTag: 'dd31660b-77e', repoPath: repo, lastCwd: repo,
    startedAt: SESSION_STARTED_AT,
    prompts: ['update origin memory from github and decide on a task'],
    promptTurnIds: [TURN],
    promptShadows: shadows,
    sessionCommitShas: [],
    commitTurns: [],
    ...extra,
  } as any;
}

const depsFor = (state: any) => ({
  windowInheritsCommits: (from: string, to: string | null, local: number) =>
    windowInheritsCommitsForTurn(repo, state, from, to, local),
});

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pull-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pull-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'artem@opsworks.co');
  git('config', 'user.name', 'Artem Dolobanko');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  write(OWN_FILE, lines(3, 'attr'));
  write('apps/api/src/routes/mcp.ts', lines(10, 'mcp'));
  write('packages/cli/src/prefer-shadow-range.ts', lines(5, 'window'));
  git('add', '.'); git('commit', '-q', '-m', 'initial');
});

afterEach(() => {
  process.env.HOME = prevHome; process.env.USERPROFILE = prevUserProfile;
  for (const d of [repo, home]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('the shadow window keeps a pulled commit out of the turn', () => {
  it('keeps the ledger row when the turn fast-forwarded a commit it did not make', () => {
    const upstream = landUpstream();
    const start = boundary(0, 'prompt-0');
    // The turn's own edit, then the pull, with the edit still uncommitted.
    writeOwnEdit();
    git('merge', '-q', '--ff-only', upstream);

    const state = stateFor([start]);
    expect(windowInheritsCommitsForTurn(repo, state, start.shadowSha, null, 0)).toBe(true);

    const row = ledgerRow();
    const logs: string[] = [];
    const n = preferShadowRangeForTurns(state, [row], repo, {
      ...depsFor(state), log: (event) => logs.push(event),
    });
    expect(n).toBe(0);
    expect(row.filesChanged).toEqual([OWN_FILE]);
    expect([row.linesAdded, row.linesRemoved]).toEqual([1, 0]);
    expect(row.diff).toBe(OWN_DIFF);
    expect(logs).toContain('shadow window spans commits the turn did not make — kept the capture');
  });

  it('without the check the window bills the turn for the pull (the bug)', () => {
    const upstream = landUpstream();
    const start = boundary(0, 'prompt-0');
    writeOwnEdit();
    git('merge', '-q', '--ff-only', upstream);

    const row = ledgerRow();
    preferShadowRangeForTurns(stateFor([start]), [row], repo);
    expect([...(row.filesChanged as string[])].sort()).toEqual([
      'apps/api/src/routes/mcp.ts',
      OWN_FILE,
      'packages/cli/src/prefer-shadow-range.ts',
    ]);
  });

  it('a completed turn is judged by its own window, not by a pull that came after it', () => {
    const upstream = landUpstream();
    const start = boundary(0, 'prompt-0');
    writeOwnEdit();
    const end = boundary(1, 'prompt-1');
    expect(end.completeBaseline).toBeUndefined();
    // The NEXT turn pulls.
    git('merge', '-q', '--ff-only', upstream);

    const state = stateFor([start, end], { prompts: ['edit', 'pull'], promptTurnIds: [TURN, 't_next'] });
    expect(windowInheritsCommitsForTurn(repo, state, start.shadowSha, end.shadowSha, 0)).toBe(false);

    const row = { ...ledgerRow(), diff: 'journal fragment @@ -1,1' };
    const n = preferShadowRangeForTurns(state, [row], repo, depsFor(state));
    expect(n).toBe(1);
    expect(row.filesChanged).toEqual([OWN_FILE]);
    expect(row.diff).toContain('+export const detached = true;');
  });

  it('the turn\'s own commit in the window is not inherited', () => {
    const start = boundary(0, 'prompt-0');
    writeOwnEdit();
    git('add', '.'); git('commit', '-q', '-m', 'fix(api): mine');
    const own = git('rev-parse', 'HEAD');

    const state = stateFor([start], { sessionCommitShas: [own], commitTurns: [{ sha: own, turnId: TURN }] });
    expect(windowInheritsCommitsForTurn(repo, state, start.shadowSha, null, 0)).toBe(false);
  });

  it('a backward checkout out of the start\'s line counts as inherited', () => {
    const base = git('rev-parse', 'HEAD');
    write('packages/cli/src/prefer-shadow-range.ts', lines(8, 'window'));
    git('add', '.'); git('commit', '-q', '-m', 'ahead');
    const start = boundary(0, 'prompt-0');
    git('checkout', '-q', base);

    expect(windowInheritsCommitsForTurn(repo, stateFor([start]), start.shadowSha, null, 0)).toBe(true);
  });
});
