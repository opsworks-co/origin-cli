// Regression test for the "pre-existing dirt leaks onto exploration prompts"
// bug (AI Blame By-Prompt showed read-only prompts like "check what was done"
// as having changed files).
//
// Root cause: the heartbeat's smart-strip decided "did the session touch this
// file?" by diffing the working tree against headShaAtStart — a CLEAN commit.
// For a file that was ALREADY dirty when the session started, that diff always
// reports a change, so the file was treated as session work and its
// pre-existing hunk was attributed to whatever prompt was current (including
// pure read-only prompts).
//
// Fix: diff against the session-start DIRTY shadow (createShadowCommit snapshots
// the full working tree — tracked mods + untracked — at session start). Files
// that were dirty before the session don't differ from that shadow, so they are
// no longer counted as touched; genuinely new/edited files still are.
//
// This test validates the baseline semantics the fix relies on, using the real
// createShadowCommit + git, so it fails on the old (clean-HEAD) baseline and
// passes on the new (dirty-shadow) one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit } from '../git-capture.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function namesChangedSince(cwd: string, baseline: string): Set<string> {
  const out = git(cwd, 'diff', baseline, '--name-only');
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

describe('session-start dirty shadow as the "touched" baseline', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shadow-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@origin.dev');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
    fs.writeFileSync(path.join(dir, 'README.md'), 'line1\nblyat problema\nline3\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'seed');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('excludes a file that was already dirty at session start', () => {
    const cleanHead = git(dir, 'rev-parse', 'HEAD');

    // Pre-existing dirt: README edited BEFORE the session begins (the user's
    // "+ uncommitted change" line in the bug report).
    fs.appendFileSync(path.join(dir, 'README.md'), 'uncommitted change\n');

    // Session starts here → snapshot the dirty tree.
    const shadow = createShadowCommit(dir, 'start-test');
    expect(shadow).toBeTruthy();

    // A read-only prompt makes no edits; the working tree still only carries
    // the pre-existing dirt.
    const touchedOld = namesChangedSince(dir, cleanHead);  // old baseline
    const touchedNew = namesChangedSince(dir, shadow!);    // new baseline

    // Old (clean-HEAD) baseline wrongly flags README → the bug.
    expect(touchedOld.has('README.md')).toBe(true);
    // New (dirty-shadow) baseline correctly sees no session change.
    expect(touchedNew.has('README.md')).toBe(false);
    expect(touchedNew.size).toBe(0);
  });

  it('still detects a genuine session edit to a pre-dirty tracked file', () => {
    // README is dirty at session start...
    fs.appendFileSync(path.join(dir, 'README.md'), 'uncommitted change\n');
    const shadow = createShadowCommit(dir, 'start-test');
    expect(shadow).toBeTruthy();

    // ...and the session edits it FURTHER. The dirty-shadow baseline still
    // sees the new edit (the shadow froze the pre-existing state), so the fix
    // doesn't over-strip files the session genuinely works on.
    fs.appendFileSync(path.join(dir, 'README.md'), 'session edit\n');

    const touched = namesChangedSince(dir, shadow!);
    expect(touched.has('README.md')).toBe(true);
  });

  it('a NEW file created during the session is not a pre-existing-dirt strip candidate', () => {
    // session-notes.txt did not exist at session start, so it can never be in
    // sessionStartDirty — the strip set only ever holds files dirty BEFORE the
    // session. New files therefore survive into the per-prompt diff via the
    // heartbeat's untracked-file append (#320), independent of this baseline.
    const startDirty = new Set(
      git(dir, 'status', '--porcelain')
        .split('\n').map((l) => l.slice(3).trim()).filter(Boolean),
    );
    expect(startDirty.has('session-notes.txt')).toBe(false);

    fs.writeFileSync(path.join(dir, 'session-notes.txt'), 'notes\n');
    const nowUntracked = git(dir, 'ls-files', '--others', '--exclude-standard');
    expect(nowUntracked.split('\n')).toContain('session-notes.txt');
  });
});
