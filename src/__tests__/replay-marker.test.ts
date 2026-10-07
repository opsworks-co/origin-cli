/**
 * prepare-commit-msg records "this commit is a replay" while git's own markers
 * exist, so the backgrounded post-commit can still tell after the replay has
 * finished and the reflog cannot be read — see replay-marker.ts. Real git.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitReplayKind } from '../commit-replay.js';
import { rememberReplayInProgress, takeReplayMarker } from '../replay-marker.js';

const DIST_MARKER = path.resolve(__dirname, '../../dist/replay-marker.js');
const haveDist = fs.existsSync(DIST_MARKER);

let repo: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true' };
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe', env }).trim();
const tryGit = (...args: string[]) => { try { git(...args); } catch { /* a conflict stops it — expected */ } };
const head = () => git('rev-parse', 'HEAD');
const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);
const commit = (message: string) => { git('add', '-A'); git('commit', '-q', '-m', message); return head(); };
const markerDir = () => path.join(repo, '.git', 'origin-replays');

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-marker-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@test.dev');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  write('a.ts', 'a\n');
  commit('base');
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

/** A branch whose one commit conflicts with main, rebased onto it and stopped. */
function stoppedRebase(): void {
  git('checkout', '-q', '-b', 'feature');
  write('a.ts', 'theirs\n'); commit('feature');
  git('checkout', '-q', 'main');
  write('a.ts', 'ours\n'); commit('main');
  git('checkout', '-q', 'feature');
  tryGit('rebase', 'main');
}

describe('replay marker', () => {
  // The gap it closes: the installed post-commit runs in the background, the
  // rebase has finished by the time it looks, and the reflog read failed.
  describe.skipIf(process.platform === 'win32')('when the reflog cannot be read after the replay finished', () => {
    const savedPath = process.env.PATH;
    let shim = '';
    beforeEach(() => {
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
      shim = fs.mkdtempSync(path.join(os.tmpdir(), 'reflog-fails-'));
      fs.writeFileSync(path.join(shim, 'git'),
        `#!/bin/sh\ncase "$1" in reflog) exit 128 ;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    });
    afterEach(() => {
      process.env.PATH = savedPath;
      fs.rmSync(shim, { recursive: true, force: true });
    });

    it('post-commit still learns the commit was a rebase pick, from what prepare-commit-msg recorded', () => {
      stoppedRebase();
      write('a.ts', 'resolved\n');
      git('add', 'a.ts');
      // prepare-commit-msg, in the foreground, while rebase-merge/ exists.
      expect(rememberReplayInProgress(repo)).toBe('rebase');
      git('-c', 'core.hooksPath=/dev/null', 'rebase', '--continue');
      const pick = head();

      process.env.PATH = `${shim}${path.delimiter}${savedPath}`;
      expect(commitReplayKind(repo, pick), 'reflog unreadable, replay finished').toBe('unknown');
      expect(takeReplayMarker(repo, pick)).toBe('rebase');
      // Consumed, and the directory with it.
      expect(fs.existsSync(markerDir())).toBe(false);
      expect(takeReplayMarker(repo, pick)).toBeNull();
    });
  });

  describe.skipIf(!haveDist || process.platform === 'win32')('with git running the hook', () => {
    let hooks = '';
    beforeEach(() => {
      hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-marker-hooks-'));
      fs.writeFileSync(path.join(hooks, 'prepare-commit-msg'),
        `#!/bin/sh\n"${process.execPath}" --input-type=module -e 'import(${JSON.stringify(DIST_MARKER)}).then((m) => m.rememberReplayInProgress(process.cwd()))'\n`,
        { mode: 0o755 });
      git('config', 'core.hooksPath', hooks);
    });
    afterEach(() => { fs.rmSync(hooks, { recursive: true, force: true }); });

    it('records each pick of a clean multi-commit rebase under its own parent', () => {
      git('checkout', '-q', '-b', 'side');
      write('s.ts', '1\n'); commit('side 1');
      write('s.ts', '1\n2\n'); commit('side 2');
      git('checkout', '-q', 'main');
      write('a.ts', 'a\nmain\n'); commit('main moves');
      git('checkout', '-q', 'side');
      git('rebase', '-q', 'main');
      const tip = head();
      const first = git('rev-parse', 'HEAD~1');
      // Taken late, in either order, as backgrounded post-commits may run.
      expect(takeReplayMarker(repo, tip)).toBe('rebase');
      expect(takeReplayMarker(repo, first)).toBe('rebase');
      expect(fs.existsSync(markerDir())).toBe(false);
    });

    it('an ordinary commit writes nothing and keeps the fast path', () => {
      write('a.ts', 'a\nb\n');
      const plain = commit('plain');
      expect(fs.existsSync(markerDir())).toBe(false);
      expect(takeReplayMarker(repo, plain)).toBeNull();
    });

    it('a stale marker is cleared by the next ordinary commit prepared on the same parent', () => {
      // A replay's post-commit never ran: its marker is left on HEAD.
      const parent = head();
      fs.mkdirSync(markerDir(), { recursive: true });
      fs.writeFileSync(path.join(markerDir(), parent), JSON.stringify({ kind: 'rebase', at: new Date().toISOString() }));
      write('a.ts', 'a\nauthored\n');
      const authored = commit('authored on the same parent');
      expect(takeReplayMarker(repo, authored)).toBeNull();
      expect(fs.existsSync(markerDir())).toBe(false);
    });
  });
});
