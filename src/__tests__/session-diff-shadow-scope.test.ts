/**
 * scopeSessionDiffToStart — the durable fix for "a 1-line session reads +16".
 *
 * A session inherits whatever uncommitted edits were already in the working
 * tree (left by earlier sessions). `git diff <HEAD-at-start>` sweeps that dirt
 * into the session diff. The session-start SHADOW commit captured the dirty
 * tree, so diffing the working tree against the shadow yields ONLY this
 * session's edits — line-level, so a file that was already dirty AND edited
 * this session keeps just the new lines.
 *
 * This drives a real temp git repo so the git plumbing is exercised end-to-end.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { captureGitState, createShadowCommit } from '../git-capture.js';
import { scopeSessionDiffToStart } from '../commands/hooks.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

describe('scopeSessionDiffToStart', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shadow-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@test.dev']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
  });

  it('excludes pre-existing uncommitted dirt, keeping only this session-s edit', () => {
    // Committed baseline.
    const file = path.join(repo, 'notes.txt');
    fs.writeFileSync(file, 'line 1\nline 2\nline 3\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const headAtStart = git(repo, ['rev-parse', 'HEAD']);

    // Pre-existing dirt: earlier session left uncommitted edits in the tree.
    fs.writeFileSync(file, 'line 1\nline 2\nline 3\nDIRT from a prior session A\nDIRT from a prior session B\n');

    // Session start: snapshot the dirty tree into a shadow commit.
    const shadow = createShadowCommit(repo, 'start-test');
    expect(shadow).toBeTruthy();

    // This session's actual edit: one new line.
    fs.appendFileSync(file, 'THIS session added one line\n');

    // Raw capture against HEAD-at-start sweeps in the dirt as ADDED lines
    // (the bug — the session diff shows the inherited dirt as +).
    const cap = captureGitState(repo, headAtStart, { fullContext: true });
    expect(cap.diff).toMatch(/^\+DIRT from a prior session A/m);
    const addedBefore = cap.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    expect(addedBefore).toBe(3); // 2 dirt + 1 session line

    // After scoping to the session-start shadow, the dirt is no longer an
    // ADDED line — only this session's line is added. (Full-context diffs
    // still render the dirt as a context line, which is correct: it's real
    // file content this session didn't author.)
    scopeSessionDiffToStart(cap, repo, shadow);
    expect(cap.diff).toMatch(/^\+THIS session added one line/m);
    expect(cap.diff).not.toMatch(/^\+DIRT from a prior session A/m);
    expect(cap.diff).not.toMatch(/^\+DIRT from a prior session B/m);
    const added = cap.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    expect(added).toBe(1);
    expect(cap.linesAdded).toBe(1);
  });

  it('is a no-op when there is no session-start shadow (clean start)', () => {
    const file = path.join(repo, 'a.txt');
    fs.writeFileSync(file, 'x\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    fs.appendFileSync(file, 'y\n');
    const cap = captureGitState(repo, head, { fullContext: true });
    const before = cap.diff;
    scopeSessionDiffToStart(cap, repo, null);
    expect(cap.diff).toBe(before); // unchanged
  });
});
