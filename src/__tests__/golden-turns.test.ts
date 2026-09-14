import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { toGoldenTurns, expectGoldenTurns, goldenPath } from './helpers/golden-turns.js';

function repoWithCommit(): { repo: string; sha: string } {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'golden-turns-')));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'T']);
  git(['config', 'user.email', 't@example.com']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'first commit']);
  return { repo, sha: git(['rev-parse', 'HEAD']) };
}

describe('golden turn rows', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const p of made.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    delete process.env.ORIGIN_UPDATE_GOLDEN;
  });

  it('keeps content fields and strips what varies run to run', () => {
    const { repo, sha } = repoWithCommit();
    made.push(repo);
    const rows = [
      {
        promptIndex: 1,
        turnId: 't_abc',
        capturedAt: 123,
        tokensUsed: 900,
        diffSource: 'ledger',
        filesChanged: ['b.txt', 'a.txt', 'a.txt'],
        linesAdded: 1,
        linesRemoved: 0,
        diff: `diff --git a/a.txt b/a.txt\r\nindex 7898192..6178079 100644\r\n--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1 +1,2 @@\r\n a\r\n+${repo}/x\r\n`,
        editsJson: JSON.stringify({ edits: [{ file: 'a.txt' }, { file: 'b.txt' }, { file: 'a.txt' }] }),
        commitSha: sha.slice(0, 12),
      },
      { promptIndex: 0, chatOnly: true, filesChanged: [] },
    ];
    expect(toGoldenTurns(rows, { repo })).toEqual([
      {
        promptIndex: 0, diffSource: null, chatOnly: true, filesChanged: [], linesAdded: 0, linesRemoved: 0,
        diff: '', uncommittedDiff: '', editedFiles: [], contentUnavailableFiles: [], commits: [],
      },
      {
        promptIndex: 1, diffSource: 'ledger', chatOnly: false, filesChanged: ['a.txt', 'b.txt'], linesAdded: 1, linesRemoved: 0,
        diff: 'diff --git a/a.txt b/a.txt\nindex <blob>\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n a\n+<root>/x\n',
        uncommittedDiff: '', editedFiles: ['a.txt', 'b.txt'], contentUnavailableFiles: [], commits: ['commit: first commit'],
      },
    ]);
  });

  it('labels a sha the repo does not have instead of dropping it', () => {
    const { repo } = repoWithCommit();
    made.push(repo);
    const [t] = toGoldenTurns([{ promptIndex: 0, commitSha: 'f'.repeat(40) }], { repo });
    expect(t.commits).toEqual(['commit: <not in repo>']);
  });

  it('collects every sha any sent row stamped on a turn, not only the final row\'s', () => {
    const { repo, sha } = repoWithCommit();
    made.push(repo);
    const final = [{ promptIndex: 2, filesChanged: ['a.txt'] }];
    const sent = [
      { promptIndex: 2, commitSha: 'f'.repeat(40) },
      { promptIndex: 2, commitSha: sha },
      { promptIndex: 2, commitSha: sha.slice(0, 7) },
      { promptIndex: 1, commitSha: sha },
      final[0],
    ];
    const [t] = toGoldenTurns(final, { repo, sent });
    expect(t.commits).toEqual(['commit: <not in repo>', 'commit: first commit']);
  });

  it('freezes an oversized diff as its size and hash', () => {
    const { repo } = repoWithCommit();
    made.push(repo);
    const big = '+x\n'.repeat(10_000);
    const [a] = toGoldenTurns([{ promptIndex: 0, diff: big }], { repo });
    const [b] = toGoldenTurns([{ promptIndex: 0, diff: `${big}+y\n` }], { repo });
    expect(a.diff).toMatch(/^<30000 chars, sha256 [0-9a-f]{16}>$/);
    expect(b.diff).not.toBe(a.diff);
  });

  it('normalizes a merge index line', () => {
    const { repo } = repoWithCommit();
    made.push(repo);
    const [t] = toGoldenTurns([{ promptIndex: 0, diff: 'diff --cc R.md\nindex 1a2b,3c4d..5e6f\n' }], { repo });
    expect(t.diff).toBe('diff --cc R.md\nindex <blob>\n');
  });

  it('records with ORIGIN_UPDATE_GOLDEN=1, then fails on a changed answer', () => {
    const { repo } = repoWithCommit();
    made.push(repo);
    const name = `__selftest-${process.pid}-${Date.now()}`;
    made.push(goldenPath(name));
    const rows = [{ promptIndex: 0, filesChanged: ['a.txt'], linesAdded: 1, diff: '+a\n' }];

    process.env.ORIGIN_UPDATE_GOLDEN = '1';
    expectGoldenTurns(name, rows, { repo });
    delete process.env.ORIGIN_UPDATE_GOLDEN;
    expect(fs.existsSync(goldenPath(name))).toBe(true);

    expectGoldenTurns(name, rows, { repo });
    expect(() => expectGoldenTurns(name, [{ ...rows[0], linesAdded: 2 }], { repo })).toThrow(/differ from the recorded golden/);
  });

  it('refuses to record from a run whose earlier tests failed', () => {
    const { repo } = repoWithCommit();
    made.push(repo);
    const name = `__refuse-${process.pid}-${Date.now()}`;
    made.push(goldenPath(name));
    process.env.ORIGIN_UPDATE_GOLDEN = '1';
    expect(() => expectGoldenTurns(name, [{ promptIndex: 0 }], { repo, failedBefore: 2 })).toThrow(/refusing to record/);
    expect(fs.existsSync(goldenPath(name))).toBe(false);
  });

  it('fails when a scenario has no golden recorded', () => {
    const { repo } = repoWithCommit();
    made.push(repo);
    expect(() => expectGoldenTurns(`__missing-${process.pid}`, [], { repo })).toThrow(/no golden/);
  });
});
