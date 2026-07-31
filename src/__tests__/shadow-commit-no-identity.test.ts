// Regression: createShadowCommit failed on fresh Windows boxes because
// `git commit-tree` errors with "committer identity unknown" when no
// user.name/user.email is configured. The shadow then returned null, the
// session diff fell back to `git diff HEAD`, and every pre-existing dirty file
// was swept into the session's line count (the "Full Session Diff +91 should be
// +2" bug). createShadowCommit now supplies its own internal identity.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit } from '../git-capture.js';

const HEX = /^[0-9a-f]{40}$/;

describe('createShadowCommit with NO git identity configured', () => {
  let dir: string;
  let emptyCfg: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-noident-')));
    // Isolate from the developer/CI global gitconfig so NO user identity leaks
    // in — this reproduces the fresh-Windows "identity unknown" condition.
    emptyCfg = path.join(dir, 'empty.gitconfig');
    fs.writeFileSync(emptyCfg, '');
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
      saved[k] = process.env[k];
    }
    process.env.GIT_CONFIG_GLOBAL = emptyCfg;
    process.env.GIT_CONFIG_SYSTEM = emptyCfg;
    delete process.env.GIT_AUTHOR_NAME; delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME; delete process.env.GIT_COMMITTER_EMAIL;

    const env = { ...process.env };
    const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', env });
    g('init', '-q', '-b', 'main');
    g('config', 'commit.gpgsign', 'false');
    g('config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
    fs.writeFileSync(path.join(dir, 'README.md'), 'line1\n');
    g('add', '.');
    // The seed commit needs an identity too — provide it inline ONLY here, so
    // the repo's own config stays identity-less (as on a fresh box).
    execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'seed'], { cwd: dir, encoding: 'utf-8', env });
    // Now dirty the tree so there's something to shadow.
    fs.writeFileSync(path.join(dir, 'README.md'), 'line1\nline2\n');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');
  });

  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('produces a valid shadow commit whose tree differs from HEAD (no identity → still works)', () => {
    const sha = createShadowCommit(dir, 'noident-test');
    expect(sha).not.toBeNull();
    expect(sha && HEX.test(sha)).toBe(true);

    // The shadow tree must capture the dirty + untracked content (differs from HEAD).
    const env = { ...process.env };
    const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf-8', env }).trim();
    const shadowTree = execFileSync('git', ['rev-parse', `${sha}^{tree}`], { cwd: dir, encoding: 'utf-8', env }).trim();
    expect(shadowTree).not.toBe(headTree);

    // And it must contain the untracked file (proves working-tree snapshot).
    const names = execFileSync('git', ['diff', 'HEAD', sha as string, '--name-only'], { cwd: dir, encoding: 'utf-8', env }).trim();
    expect(names).toContain('untracked.txt');
  });
});
