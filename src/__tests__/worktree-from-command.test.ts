// The gap the harness-based fix left open: an agent that runs
// `cd /path/to/worktree && …` inside ONE Bash call never moves `lastCwd`, so
// its writes were invisible. Session 81d65cb5 lost +249/-16 across six files
// this way — while the fix for the harness case was already shipped.
//
// The command text is the remaining signal. It works because agents write the
// literal path in an assignment (`W=/abs/path`) even when they later use `$W`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { candidateDirsFromCommand, worktreesAmongCandidates, samePath } from '../session-worktree.js';
import { getWorkingGitRoot, getGitCommonDir } from '../session-state.js';

const deps = { gitRoot: getWorkingGitRoot, gitCommonDir: getGitCommonDir };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

describe('candidateDirsFromCommand', () => {
  it('finds the path from an assignment, which is how agents really write it', () => {
    const c = 'W=/private/tmp/x/wt3\ncd $W/packages/cli && npx vitest run';
    expect(candidateDirsFromCommand(c)).toContain('/private/tmp/x/wt3');
  });

  it('finds explicit cd and git -C targets', () => {
    expect(candidateDirsFromCommand('cd /a/b && ls')).toContain('/a/b');
    expect(candidateDirsFromCommand('git -C /c/d status')).toContain('/c/d');
  });

  it('ignores a path it cannot resolve', () => {
    // Unexpanded variables and globs are not directories we can check.
    const got = candidateDirsFromCommand('cd $HOME/x && cat /tmp/$Y/z && ls /a/*/b');
    expect(got.every((p) => !p.includes('$') && !p.includes('*'))).toBe(true);
  });

  it('strips trailing shell punctuation', () => {
    expect(candidateDirsFromCommand('cd /a/b; ls')).toContain('/a/b');
    expect(candidateDirsFromCommand('(cd /a/c) && ls')).toContain('/a/c');
  });

  it('finds WINDOWS absolute paths too', () => {
    // The extraction was POSIX-only, so on a Windows agent every candidate was
    // `C:\\Users\\…` and the whole feature silently did nothing. Caught by CI,
    // not by me — these run on the native Windows runner.
    expect(candidateDirsFromCommand('cd C:\\Users\\me\\wt && ls'))
      .toContain('C:\\Users\\me\\wt');
    expect(candidateDirsFromCommand('W=C:/Users/me/wt\ncd $W'))
      .toContain('C:/Users/me/wt');
    expect(candidateDirsFromCommand('git -C D:\\repo\\wt status'))
      .toContain('D:\\repo\\wt');
  });

  it('strips a trailing separator in either family', () => {
    expect(candidateDirsFromCommand('cd /a/b/ && ls')).toContain('/a/b');
    expect(candidateDirsFromCommand('cd C:\\a\\b\\ && ls')).toContain('C:\\a\\b');
  });

  it('caps how many it returns — each costs a git call', () => {
    const cmd = Array.from({ length: 40 }, (_, i) => `/p/dir${i}`).join(' ');
    expect(candidateDirsFromCommand(cmd).length).toBeLessThanOrEqual(8);
  });
});

describe('worktreesAmongCandidates', () => {
  let repo: string; let wt: string; let other: string;

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cmdwt-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@origin.dev'); git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'x\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seed');
    wt = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cmdwt-linked-')));
    fs.rmSync(wt, { recursive: true, force: true });
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
    other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cmdwt-other-')));
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'config', 'user.email', 't@origin.dev'); git(other, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(other, 's.txt'), 'x\n');
    git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'seed');
  });

  afterEach(() => {
    try { git(repo, 'worktree', 'remove', '--force', wt); } catch { /* ignore */ }
    for (const d of [wt, other, repo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('recovers the worktree from a realistic command', () => {
    // Shaped like the commands that lost their work.
    const cmd = `W=${wt}\ncd $W/packages/cli && npx vitest run`;
    const found = worktreesAmongCandidates(repo, candidateDirsFromCommand(cmd), deps);
    expect(found.length).toBe(1);
    expect(samePath(found[0], wt)).toBe(true);
  });

  it('recovers it from a write target inside the worktree', () => {
    const cmd = `cat > ${path.join(wt, 'src', 'a.ts')} <<'EOF'\nx\nEOF`;
    const found = worktreesAmongCandidates(repo, candidateDirsFromCommand(cmd), deps);
    expect(found.some((f) => samePath(f, wt))).toBe(true);
  });

  it('REFUSES an unrelated repository', () => {
    const found = worktreesAmongCandidates(repo, candidateDirsFromCommand(`cd ${other} && ls`), deps);
    expect(found).toEqual([]);
  });

  it('returns nothing for the main checkout or a non-repo path', () => {
    expect(worktreesAmongCandidates(repo, candidateDirsFromCommand(`cd ${repo} && ls`), deps)).toEqual([]);
    expect(worktreesAmongCandidates(repo, candidateDirsFromCommand('cd /nonexistent/nowhere && ls'), deps)).toEqual([]);
  });
});
