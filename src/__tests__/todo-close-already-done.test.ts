/**
 * A TODO that was already done, closed by a session that changes nothing.
 *
 * A TODO closes when the work carrying its `[Origin: Closes]` claim reaches
 * the default branch. A session that finds the work already done — issue
 * e2069d70 (2026-10-12): the agent found PR #24 had fixed all three pages —
 * has no commit of its own, so its claim stayed pending forever. It now names
 * what did the work on the marker line, and the default branch still decides:
 * the claim closes once that commit, or that PR's merge, is on it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readTodoClosures } from '../memory.js';
import { closureEvidence, recordPendingClosures, sweepTodoClosures } from '../todo-sweep.js';

const TODO = 'three pages still make an unqualified no outbound connection claim';
const SID = 'a1b2c3d4-0000-1111-2222-333344445555';
let repo: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();
const commit = (msg: string) => { fs.writeFileSync(path.join(repo, `${Date.now()}-${Math.random()}.txt`), msg); git('add', '.'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
const open = [{ id: 'e2069d70', text: TODO }];
const state = () => readTodoClosures(repo).find((c) => c.id === 'e2069d70')?.state;

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-todo-done-')));
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@e.st'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(repo, '.git', 'no-hooks')]]) git('config', k, v);
  // Memory is written to the note only with the prompt opt-in (OR-48).
  fs.writeFileSync(path.join(repo, '.origin.json'), JSON.stringify({ notesIncludePrompts: true }));
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\n.origin.json\n');
  commit('init');
  // The session that left the TODO: a closure is kept only for a TODO the note records.
  const leftIt = {
    sessionId: 'f0f0f0f0-0000', agentSlug: 'claude-code', model: 'claude', startedAt: '2026-10-01T00:00:00.000Z',
    endedAt: '2026-10-01T01:00:00.000Z', branch: 'main', summary: 'left a TODO', filesChanged: ['a.ts'],
    promptCount: 1, linesAdded: 1, linesRemoved: 0, openTodos: [TODO],
  };
  git('notes', '--ref=origin-memory', 'add', '-f', '-m', JSON.stringify({ version: 2, sessions: [leftIt], commits: [] }), git('rev-list', '--max-parents=0', 'HEAD'));
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('closureEvidence', () => {
  it('reads the commit or PR a marker names, not the TODO\'s own id', () => {
    expect(closureEvidence('e2069d70 — already done in #24', 'e2069d70')).toEqual({ shas: [], prs: [24] });
    expect(closureEvidence('e2069d70 already fixed by 9fceb02d in PR 31', 'e2069d70')).toEqual({ shas: ['9fceb02d'], prs: [31] });
    expect(closureEvidence('e2069d70 see https://github.com/acme/app/pull/12', 'e2069d70')).toEqual({ shas: [], prs: [12] });
    expect(closureEvidence('e2069d70', 'e2069d70')).toEqual({ shas: [], prs: [] });
    // A number or a plain word is not a sha.
    expect(closureEvidence('e2069d70 done in 2026100 deadbeef', 'e2069d70').shas).toEqual([]);
  });
});

describe('a TODO already done', () => {
  it('closes at once when the PR the marker names is merged on the default branch', () => {
    commit('fix(site): qualify the air-gapped claims (#24)');
    expect(recordPendingClosures({ repoPath: repo, sessionId: SID, markers: ['e2069d70 — already done in #24'], openTodos: open })).toBe(1);
    expect(state()).toBe('pending');
    expect(sweepTodoClosures(repo)).toBe(1);
    expect(state()).toBe('closed');
  });

  it('closes when the commit the marker names is on the default branch', () => {
    const sha = commit('qualify the claims');
    recordPendingClosures({ repoPath: repo, sessionId: SID, markers: [`e2069d70 already fixed by ${sha.slice(0, 10)}`], openTodos: open });
    sweepTodoClosures(repo);
    expect(state()).toBe('closed');
  });

  it('stays pending when what it names is not on the default branch — or it names nothing', () => {
    git('checkout', '-q', '-b', 'side');
    const off = commit('qualify on a side branch (#40)');
    git('checkout', '-q', 'main');
    recordPendingClosures({ repoPath: repo, sessionId: SID, markers: [`e2069d70 already done in ${off.slice(0, 8)} and #40`], openTodos: open });
    sweepTodoClosures(repo);
    expect(state()).toBe('pending');
    // A PR number that is merged nowhere does not close it either.
    commit('unrelated work (#7)');
    sweepTodoClosures(repo);
    expect(state()).toBe('pending');
  });

  it('a later claim that names the evidence completes an earlier claim that named nothing', () => {
    commit('fix(site): qualify the air-gapped claims (#24)');
    recordPendingClosures({ repoPath: repo, sessionId: SID, markers: ['e2069d70'], openTodos: open });
    sweepTodoClosures(repo);
    expect(state()).toBe('pending');
    recordPendingClosures({ repoPath: repo, sessionId: 'b2c3d4e5-0000', markers: ['e2069d70 — already done in #24'], openTodos: open });
    expect(readTodoClosures(repo).find((c) => c.id === 'e2069d70')?.prs).toEqual([24]);
    sweepTodoClosures(repo);
    expect(state()).toBe('closed');
  });
});
