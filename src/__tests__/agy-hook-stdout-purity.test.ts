// A hook's stdout is a PROTOCOL, not a console.
//
// Antigravity parses a PreToolUse hook's stdout as ONE JSON object and reads
// `decision` from it to decide whether the tool may run. Two ways to break that,
// both of which fail the same way — agy cannot unmarshal the reply, so every
// tool call in the session errors out BEFORE executing and the agent breaks
// outright rather than merely going uncaptured:
//
//   1. Appending to stdout. Origin's global `postAction` version check printed
//      "Update available: …" after the decision JSON. It only reproduces while
//      an update happens to be available, and Claude Code tolerates the extra
//      bytes, so it stayed hidden.
//   2. Returning early without writing a decision at all — e.g. bailing out when
//      no repo identity resolves. Skipping optional work must never skip the
//      reply.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/index.js');

/**
 * A throwaway git repo for the hook to resolve, inside the caller's isolated
 * home. A real repo identity is part of what these tests exercise — the point
 * is that stdout stays clean while the hook does its full job, not that it
 * bails early — so this keeps that and takes the developer's tree out of it.
 */
function repoFor(home?: string): string | undefined {
  if (!home) return undefined;
  const repo = path.join(home, 'repo');
  if (!fs.existsSync(repo)) {
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] });
  }
  return repo;
}

function runPreToolUse(opts: { home?: string; cwd?: string; filePath?: string } = {}): string {
  const payload = JSON.stringify({
    conversationId: `stdout-purity-${Math.random().toString(36).slice(2)}`,
    // Empty, exactly as agy sends it on a session's first steps.
    workspacePaths: [],
    toolCall: { name: 'view_file', args: { AbsolutePath: opts.filePath ?? '/nonexistent/file.txt' } },
    stepIdx: 1,
    transcriptPath: '/nonexistent/transcript.jsonl',
  });
  return execFileSync(process.execPath, [distPath, 'hooks', 'antigravity', 'pre-tool-use'], {
    input: payload,
    encoding: 'utf-8',
    // Discard stderr: this asserts on stdout, and a warning there is not a failure.
    stdio: ['pipe', 'pipe', 'ignore'],
    // NEVER the real cwd. This runs the built hook for real, and a hook that
    // resolves a repo spawns a DETACHED journal watcher on it — so defaulting
    // to process.cwd() pointed a recursive watch at the developer's own
    // worktree, wrote its journal into the temp home below, and then outlived
    // the test: a watcher refreshes its idle clock every time its journal
    // grows, and a worktree someone is actively editing never goes quiet.
    // Measured before this changed: 87 leaked home trees and a 57-minute-old
    // watcher, against a 30-minute idle window it could never reach.
    cwd: opts.cwd ?? repoFor(opts.home),
    // os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows. Set both,
    // or the isolation silently no-ops on the Windows runner and these tests
    // pass without exercising anything.
    env: { ...process.env, ...(opts.home ? { HOME: opts.home, USERPROFILE: opts.home } : {}) },
  });
}

// Asserts what agy itself does with the bytes.
function expectValidDecision(out: string): void {
  const parsed = JSON.parse(out);
  expect(['allow', 'deny', 'ask', 'force_ask']).toContain(parsed.decision);
}

describe('antigravity pre-tool-use stdout purity', () => {
  if (!fs.existsSync(distPath)) {
    it.skip('requires a built CLI (pnpm run build)', () => { /* skipped */ });
    return;
  }

  it('emits ONLY a decision object when an update is available', () => {
    // Seed an isolated HOME whose update-check cache reports a much newer
    // version. That drives the real code path with no network and no test-only
    // switch in production code — checkForUpdate returns from cache.
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hook-home-')));
    try {
      fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.origin', 'last-update-check.json'),
        JSON.stringify({ latest: '99.99999999.9999', checkedAt: new Date().toISOString() }),
      );
      const out = runPreToolUse({ home });
      expect(out).not.toContain('Update available');
      expect(out).not.toContain('origin upgrade');
      expectValidDecision(out);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('still writes a decision when no repo identity resolves', () => {
    // cwd is the agent's own config dir and workspacePaths is empty, so nothing
    // resolves to a repo. The baseline snapshot is rightly skipped — the reply
    // is not.
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hook-home-')));
    try {
      const cfgDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(cfgDir, { recursive: true });
      expectValidDecision(runPreToolUse({ home, cwd: cfgDir }));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
