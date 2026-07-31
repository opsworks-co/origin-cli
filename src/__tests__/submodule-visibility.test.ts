// A submodule pointer bump shows in git diffs by default, but a repo/user
// `diff.ignoreSubmodules=all` silently hides it — which would drop the change
// from Origin's capture. The git() wrapper forces `-c diff.ignoreSubmodules=none`
// on diff-family subcommands so the `Subproject commit` section always renders.
// This drives real git with a gitlink (160000) entry to prove it end to end.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { git } from '../utils/exec.js';

function raw(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const SHA1 = '1111111111111111111111111111111111111111';
const SHA2 = '2222222222222222222222222222222222222222';

describe('submodule visibility in capture diffs', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sub-')));
    raw(dir, 'init', '-q', '-b', 'main');
    raw(dir, 'config', 'user.email', 'test@origin.dev');
    raw(dir, 'config', 'user.name', 'Test');
    raw(dir, 'config', 'commit.gpgsign', 'false');
    // Base commit, then commit a gitlink (submodule pointer) at SHA1.
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    raw(dir, 'add', 'f.txt');
    raw(dir, 'commit', '-q', '-m', 'init');
    raw(dir, 'update-index', '--add', '--cacheinfo', `160000,${SHA1},mysub`);
    raw(dir, 'commit', '-q', '-m', 'add submodule');
    // Bump the submodule pointer in the index (staged change vs HEAD).
    raw(dir, 'update-index', '--cacheinfo', `160000,${SHA2},mysub`);
    // The exact config that would otherwise hide the change.
    raw(dir, 'config', 'diff.ignoreSubmodules', 'all');
  });

  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('the git() wrapper surfaces a submodule bump even under diff.ignoreSubmodules=all', () => {
    const names = git(['diff', '--cached', '--name-only', 'HEAD'], { cwd: dir }).trim();
    expect(names.split('\n')).toContain('mysub');
  });

  it('a raw diff (no override) is suppressed by the config — proving the wrapper is what fixes it', () => {
    const names = raw(dir, 'diff', '--cached', '--name-only', 'HEAD');
    expect(names.split('\n').filter(Boolean)).not.toContain('mysub');
  });
});
