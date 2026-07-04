// Commit-and-go PARTIAL-diff regression.
//
// Symptom (dashboard): a Cursor/Codex "make changes and commit" turn showed
// fewer files/lines than the commit it produced — e.g. turn "+20 / 3 files" vs
// the real commit "+33 / 4 files". Cause: the stop hook's live `git diff HEAD`
// races the commit and can capture a PARTIAL working tree (some files already
// staged/committed). #466 only rebuilt the per-prompt diff from the commit when
// the live capture was fully EMPTY, so a partial capture slipped through.
//
// Fix: when exactly ONE prompt maps to a commit, the commit is that prompt's
// authoritative committed work — rebuild the diff from it even when the live
// capture is non-empty-but-partial. Many prompts sharing a commit keep the live
// per-prompt diff (empty-only fill), since a commit's lines can't be split
// across prompts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildSessionWriteData } from '../commands/hooks';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();

function baseOpts(dir: string, headAfter: string) {
  return {
    state: { repoPath: dir, startedAt: new Date().toISOString(), prompts: [], model: 'cursor', branch: 'main' } as any,
    parsed: { prompts: ['make some changes and commit'], model: 'cursor', filesChanged: [] } as any,
    gitCapture: { headBefore: '', headAfter, commitShas: [headAfter], linesAdded: 0, linesRemoved: 0 },
    status: 'running' as const,
    apiUrl: 'http://localhost',
  };
}

describe('buildSessionWriteData — commit-and-go partial diff', () => {
  let dir: string;
  let commitSha: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cag-')));
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
    // The commit-and-go commit: 4 files touched (3 new + 1 modified).
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\na2\na3\n');    // +3
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b1\nb2\n');        // +2
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c1\n');            // +1
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed2\n');      // +1 / -1
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'work']);
    commitSha = gitIn(dir, ['rev-parse', 'HEAD']).trim();
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rebuilds a SOLE prompt\'s diff from the commit when the live capture is partial', () => {
    // Live capture only saw a.txt (raced the commit) → undercounts the commit.
    const partialDiff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,3 @@\n+a1\n+a2\n+a3\n';
    const opts = {
      ...baseOpts(dir, commitSha),
      promptMappings: [
        { promptIndex: 0, promptText: 'make some changes and commit', filesChanged: ['a.txt'], diff: partialDiff, commitSha } as any,
      ],
    };

    const out = buildSessionWriteData(opts);
    const change = out.changes[0];

    // Now reflects the FULL commit: 4 files, +7 / -1 (a:3 b:2 c:1 seed:+1/-1).
    expect(change.filesChanged.sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'seed.txt']);
    expect(change.linesAdded).toBe(7);
    expect(change.linesRemoved).toBe(1);
    expect(change.diff).toContain('b/b.txt');
    expect(change.diff).toContain('b/c.txt');
  }, 30_000);

  it('does NOT rebuild when several prompts share the commit (keeps the live per-prompt diff)', () => {
    const partialA = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,3 @@\n+a1\n+a2\n+a3\n';
    const partialB = 'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -0,0 +1,2 @@\n+b1\n+b2\n';
    const opts = {
      ...baseOpts(dir, commitSha),
      promptMappings: [
        { promptIndex: 0, promptText: 'p1', filesChanged: ['a.txt'], diff: partialA, commitSha } as any,
        { promptIndex: 1, promptText: 'p2', filesChanged: ['b.txt'], diff: partialB, commitSha } as any,
      ],
    };

    const out = buildSessionWriteData(opts);
    // Each prompt keeps its own captured slice — NOT the whole 4-file commit.
    expect(out.changes[0].filesChanged).toEqual(['a.txt']);
    expect(out.changes[0].linesAdded).toBe(3);
    expect(out.changes[1].filesChanged).toEqual(['b.txt']);
    expect(out.changes[1].linesAdded).toBe(2);
  }, 30_000);

  it('still rebuilds a SOLE prompt with a fully EMPTY live diff (the #466 case)', () => {
    const opts = {
      ...baseOpts(dir, commitSha),
      promptMappings: [
        { promptIndex: 0, promptText: 'p', filesChanged: [], diff: '', commitSha } as any,
      ],
    };
    const out = buildSessionWriteData(opts);
    expect(out.changes[0].linesAdded).toBe(7);
    expect(out.changes[0].filesChanged.sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'seed.txt']);
  }, 30_000);
});
