// Antigravity fires no SessionStart — only PreToolUse, PostToolUse and Stop
// exist (verified against the binary; see antigravityHookGroup in enable.ts).
// So every chore the other agents get at launch never ran for an agy session:
// the remote-notes sync, and the refresh of the Origin block in AGENTS.md.
// That block was only ever rewritten as a SIDE EFFECT of some other agent's
// session-start in the same repo — which is why AGENTS.md in this very repo
// once sat 5 months stale, still advertising policies that no longer existed.
// A machine driven only by agy never wrote it at all.
//
// `origin hooks antigravity __refresh-context` is agy's stand-in, spawned
// detached from the once-per-conversation branch of pre-tool-use. Driven here
// through the real built binary because the two things most likely to break it
// are invisible to a unit test: the event must be dispatched BEFORE readStdin()
// (a detached process has no stdin, so falling through hangs forever), and it
// must actually reach the filesystem.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/index.js');

function makeRepo(): string {
  // realpath: on macOS os.tmpdir() is a symlink into /private, and git reports
  // the resolved path — an unresolved fixture path compares as a different repo.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-refresh-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

function runRefresh(repo: string, home: string): void {
  execFileSync(process.execPath, [distPath, 'hooks', 'antigravity', '__refresh-context'], {
    encoding: 'utf-8',
    // No stdin is piped ON PURPOSE: this mirrors the detached spawn. If the
    // handler ever falls through to readStdin() this call blocks until the
    // timeout instead of returning, and the test fails loudly rather than
    // shipping a hook that hangs on every agy conversation.
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: repo,
    timeout: 30_000,
    env: {
      ...process.env,
      ORIGIN_AGY_REFRESH_REPO: repo,
      // os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows — set
      // both, or the isolation silently no-ops on a Windows runner.
      HOME: home,
      USERPROFILE: home,
    },
  });
}

describe('antigravity __refresh-context', () => {
  if (!fs.existsSync(distPath)) {
    it.skip('requires a built CLI (pnpm run build)', () => { /* skipped */ });
    return;
  }

  it('writes the Origin block into AGENTS.md for a repo no other agent has opened', () => {
    const repo = makeRepo();
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-home-')));
    try {
      expect(fs.existsSync(path.join(repo, 'AGENTS.md'))).toBe(false);
      runRefresh(repo, home);
      const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8');
      expect(agents).toContain('<!-- origin-managed -->');
      expect(agents).toContain('Origin: Session tracking active');
      // The authoring framework is part of the durable half a rules file is for.
      expect(agents).toContain('[Origin: Decision]');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('replaces its own block instead of appending a second one', () => {
    // The refresh runs once per agy CONVERSATION, so a repo used daily gets it
    // repeatedly. Appending would grow AGENTS.md without bound and leave the
    // agent reading several contradictory copies of "recent work".
    const repo = makeRepo();
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-home-')));
    try {
      runRefresh(repo, home);
      runRefresh(repo, home);
      const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8');
      expect(agents.split('<!-- origin-managed -->').length - 1).toBe(2); // one open, one close
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves prose the user wrote outside the managed block', () => {
    const repo = makeRepo();
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-home-')));
    try {
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# House rules\n\nAlways run the linter.\n');
      runRefresh(repo, home);
      const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8');
      expect(agents).toContain('Always run the linter.');
      expect(agents).toContain('Origin: Session tracking active');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does nothing when no target repo is set, rather than guessing at cwd', () => {
    const repo = makeRepo();
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-home-')));
    try {
      execFileSync(process.execPath, [distPath, 'hooks', 'antigravity', '__refresh-context'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        cwd: repo,
        timeout: 30_000,
        env: { ...process.env, ORIGIN_AGY_REFRESH_REPO: '', HOME: home, USERPROFILE: home },
      });
      expect(fs.existsSync(path.join(repo, 'AGENTS.md'))).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
