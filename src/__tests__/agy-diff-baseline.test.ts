// Regression test for the recurring "the diff is wrong" report on Antigravity
// (agy) sessions: the per-turn diff swept in pre-existing dirt — unrelated
// tracked edits and stray untracked files that were in the working tree BEFORE
// agy ran (e.g. a leftover `test.txt`) — and counted them as the agent's work.
//
// Fix: captureAgyDiff diffs against a per-conversation baseline shadow snapped
// at the first pre-tool-use, so only what agy changed since then is reported.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit, captureAgyDiff } from '../git-capture.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('captureAgyDiff (per-conversation baseline excludes pre-existing dirt)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@origin.dev');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), 'line1\nline2\nline3\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'seed');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('excludes a pre-existing untracked file and only reports agy edits', () => {
    // Pre-existing dirt BEFORE the agy session: a stray untracked file and an
    // unrelated tracked edit.
    fs.writeFileSync(path.join(dir, 'test.txt'), 'leftover scratch\n');
    fs.appendFileSync(path.join(dir, 'README.md'), 'pre-existing edit\n');

    // agy session starts → baseline snapshots the dirty tree.
    const baseline = createShadowCommit(dir, 'agy-start');
    expect(baseline).toBeTruthy();

    // agy does its work: edits README further + creates a genuinely new file.
    fs.appendFileSync(path.join(dir, 'README.md'), 'agy edit\n');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'agy created this\n');

    const cap = captureAgyDiff(dir, baseline);

    // The stray untracked file from before the session must NOT appear.
    expect(cap.filesChanged).not.toContain('test.txt');
    expect(cap.diff).not.toContain('leftover scratch');
    // agy's genuine work IS captured.
    expect(cap.filesChanged.sort()).toEqual(['README.md', 'feature.txt']);
    expect(cap.diff).toContain('agy edit');
    expect(cap.diff).toContain('agy created this');
    // The pre-existing README line is baked into the baseline → it may appear
    // as unchanged context (full-context diff) but must NOT be counted as an
    // addition, and only agy's 2 new lines are counted.
    expect(cap.diff).not.toContain('+pre-existing edit');
    expect(cap.linesAdded).toBe(2); // 'agy edit' + 'agy created this'
  });

  it('returns EMPTY with no baseline — never dumps git-diff-HEAD (pre-existing dirt)', () => {
    // Pre-existing dirt with no recorded baseline must NOT be reported: without
    // a baseline we cannot tell the agent's work from what was already there, so
    // a read-only turn must show nothing rather than the whole dirty tree.
    fs.appendFileSync(path.join(dir, 'README.md'), 'pre-existing dirt\n');
    const cap = captureAgyDiff(dir, null);
    expect(cap.filesChanged).toEqual([]);
    expect(cap.diff).toBe('');
    expect(cap.linesAdded).toBe(0);
  });

  it('diffs against an explicit baseline sha (clean-start records HEAD as its baseline)', () => {
    const head = git(dir, 'rev-parse', 'HEAD'); // clean tree → baseline IS head
    fs.appendFileSync(path.join(dir, 'README.md'), 'agy edit\n');
    const cap = captureAgyDiff(dir, head);
    expect(cap.filesChanged).toContain('README.md');
    expect(cap.diff).toContain('agy edit');
  });

  // Per-PROMPT baselines: each prompt diffs against where the previous one left
  // off, so a read-only prompt reports NO changes instead of inheriting the
  // cumulative session diff (the "prompt #3 shows 5 files it didn't touch" bug).
  it('a read-only prompt between two editing prompts captures an empty diff', () => {
    const sessionBaseline = git(dir, 'rev-parse', 'HEAD');

    // Prompt 1 edits README, then we snapshot its end state (next baseline).
    fs.appendFileSync(path.join(dir, 'README.md'), 'prompt1 work\n');
    const p1 = captureAgyDiff(dir, sessionBaseline);
    expect(p1.filesChanged).toEqual(['README.md']);
    const afterP1 = createShadowCommit(dir, 'agy-sync-0')!;

    // Prompt 2 is read-only (no edits) → diff vs prompt 1's end is EMPTY.
    const p2 = captureAgyDiff(dir, afterP1);
    expect(p2.filesChanged).toEqual([]);
    expect(p2.diff).toBe('');
    const afterP2 = createShadowCommit(dir, 'agy-sync-1') || afterP1; // unchanged tree

    // Prompt 3 edits a different file → only ITS file, not prompt 1's.
    fs.writeFileSync(path.join(dir, 'new.txt'), 'prompt3 work\n');
    const p3 = captureAgyDiff(dir, afterP2);
    expect(p3.filesChanged).toEqual(['new.txt']);
    expect(p3.diff).not.toContain('prompt1 work');
  });
});
