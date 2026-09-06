/**
 * A file that was already lying in the tree before the session — untracked or
 * modified — and that a `git add -A` swept into the session's commit
 * unchanged is not the session's work. Prod bc4a1438 (vodka): hello.py had
 * been untracked for weeks; the agent committed "everything" and the session
 * header credited its ten lines as authored (+1227 for a session that wrote
 * 1217). The per-turn rows were already right — their baseline shadow holds
 * the dirt — only the session-level render still read each commit against
 * its parent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit } from '../git-capture.js';
import { __testSessionScopedCommittedDiff, preSessionDirtCommittedUnchanged, dropDiffSectionsForFiles } from '../commands/hooks.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('pre-session dirt committed unchanged', () => {
  let dir = '';
  let shadow = '';
  let sha = '';
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-dirt-')));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'base.py'), 'print(1)\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    // Dirt from before the session: one untracked file, one modified file.
    fs.writeFileSync(path.join(dir, 'hello.py'), 'print("hello")\n');
    fs.writeFileSync(path.join(dir, 'base.py'), 'print(1)\nprint(2)\n');
    shadow = createShadowCommit(dir, 'session-start')!;
    expect(shadow).toMatch(/^[0-9a-f]{40}$/);
    // The session writes a new module, then commits EVERYTHING.
    fs.writeFileSync(path.join(dir, 'cellar.py'), 'def cellar():\n    return 1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'add cellar');
    sha = git(dir, 'rev-parse', 'HEAD');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const state = () => ({
    repoPath: dir, sessionCommitShas: [sha],
    sessionStartShadowSha: shadow, sessionStartDirtyFiles: ['hello.py', 'base.py'],
  });

  it('names the swept files, and only those', () => {
    const swept = preSessionDirtCommittedUnchanged(dir, state(), ['hello.py', 'base.py', 'cellar.py']);
    expect([...swept].sort()).toEqual(['base.py', 'hello.py']);
  });

  it('the session-level diff credits only what the session wrote', () => {
    const diff = __testSessionScopedCommittedDiff(dir, state());
    expect(diff).toContain('+def cellar():');
    expect(diff).not.toContain('print("hello")');
    expect(diff).not.toContain('+print(2)');
    expect(diff.match(/^diff --git /gm)).toHaveLength(1);
  });

  it('a swept file the session DID change stays credited', () => {
    // A later commit edits hello.py: HEAD no longer matches the shadow.
    fs.writeFileSync(path.join(dir, 'hello.py'), 'print("hello")\nprint("again")\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'touch hello');
    const s = { ...state(), sessionCommitShas: [sha, git(dir, 'rev-parse', 'HEAD')] };
    const diff = __testSessionScopedCommittedDiff(dir, s);
    expect(diff).toContain('+print("again")');
    expect(diff).toContain('+print("hello")'); // its creation is in the walk too — churn, not net
  });

  it('a turn-scoped render is untouched — its baseline already holds the dirt', () => {
    const diff = __testSessionScopedCommittedDiff(dir, state(), shadow);
    expect(diff).toContain('+def cellar():');
    expect(diff).not.toContain('print("hello")');
  });

  it('without a session-start shadow nothing is dropped', () => {
    const s = { ...state(), sessionStartShadowSha: null };
    expect(__testSessionScopedCommittedDiff(dir, s)).toContain('print("hello")');
    expect(preSessionDirtCommittedUnchanged(dir, s, ['hello.py']).size).toBe(0);
  });

  it('dropDiffSectionsForFiles removes whole sections by path', () => {
    const d = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+x\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -0,0 +1 @@\n+y';
    expect(dropDiffSectionsForFiles(d, new Set(['a']))).toBe('diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -0,0 +1 @@\n+y');
  });
});
