// Regression: prod session 03a338b8. Four turns all edited the SAME file and the
// session made TWO commits. attributeCommitsToPrompts claimed commits by file
// overlap ALONE, so every turn claimed BOTH commits; the downstream
// "highest-index claimant wins" rule then collapsed both onto the last turn, and
// the turn that actually ran `git commit` ("add 10 rows into it and commit")
// rendered "uncommitted". Driven against a REAL git repo — the partition is
// arithmetic on git truth, so mocking it would prove nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { attributeCommitsToPrompts } from '../prompt-capture/index.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const rows = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `row${from + i}`).join('\n') + '\n';

describe('attributeCommitsToPrompts — commit boundary partition', () => {
  let dir: string;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8', env: ENV }).trim();
  const commit = (m: string) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', m], { cwd: dir, encoding: 'utf-8', env: ENV });

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-part-')));
    g('init', '-q', '-b', 'main');
    g('config', 'commit.gpgsign', 'false');
    g('config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const turn = (i: number, text: string, newContent: string, op = 'edit') => ({
    promptIndex: i, promptText: text, agent: 'claude' as const, commits: [] as string[],
    edits: [{ file: 'ninetendo', op, source: 'tool_call', newContent } as any],
  });

  it('splits the two commits across their real producers (the reported bug)', () => {
    fs.writeFileSync(path.join(dir, 'ninetendo'), rows(18));
    g('add', '.'); commit('Add ninetendo fixture with 18 rows');
    const A = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'ninetendo'), rows(30));
    g('add', '.'); commit('Add 12 more rows to ninetendo');
    const B = g('rev-parse', 'HEAD');

    const turns = [
      turn(0, 'create a file ninetendo with 8 rows', rows(8), 'write'),
      turn(1, 'add 10 rows into it and commit', rows(10, 9)),
      turn(2, 'add 3 more rows', rows(3, 19)),
      turn(3, 'add 9 more and commit now', rows(9, 22)),
    ];
    attributeCommitsToPrompts(turns as any, { repoPath: dir, sessionCommitShas: [A, B] } as any);

    // Commit A belongs to turns 0+1 (8+10=18); commit B to turns 2+3 (3+9=12).
    expect(turns[0].commits).toEqual([A]);
    expect(turns[1].commits).toEqual([A]);
    expect(turns[2].commits).toEqual([B]);
    expect(turns[3].commits).toEqual([B]);
    // The precise failure that was reported: turn 1 must own a commit.
    expect(turns[1].commits).not.toHaveLength(0);
    // And no turn may claim BOTH commits any more.
    for (const t of turns) expect(t.commits.length).toBeLessThanOrEqual(1);
  });

  it('single-commit sessions still attribute every contributing turn', () => {
    fs.writeFileSync(path.join(dir, 'ninetendo'), rows(12));
    g('add', '.'); commit('one commit');
    const A = g('rev-parse', 'HEAD');
    const turns = [turn(0, 'make it', rows(8), 'write'), turn(1, 'more and commit', rows(4, 9))];
    attributeCommitsToPrompts(turns as any, { repoPath: dir, sessionCommitShas: [A] } as any);
    expect(turns[0].commits).toEqual([A]);
    expect(turns[1].commits).toEqual([A]);
  });

  it('leaves trailing uncommitted turns with no commit', () => {
    fs.writeFileSync(path.join(dir, 'ninetendo'), rows(8));
    g('add', '.'); commit('first');
    const A = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'ninetendo'), rows(20));
    g('add', '.'); commit('second');
    const B = g('rev-parse', 'HEAD');
    const turns = [
      turn(0, 'create 8', rows(8), 'write'),
      turn(1, 'add 12 and commit', rows(12, 9)),
      turn(2, 'add 5 more (never committed)', rows(5, 21)),
    ];
    attributeCommitsToPrompts(turns as any, { repoPath: dir, sessionCommitShas: [A, B] } as any);
    expect(turns[0].commits).toEqual([A]);
    expect(turns[1].commits).toEqual([B]);
    expect(turns[2].commits).toEqual([]); // still uncommitted — correct
  });
});
