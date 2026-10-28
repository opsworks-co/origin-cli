/**
 * An Antigravity run started by `origin issue start` links its session to the
 * issue run.
 *
 * Every other agent's SessionStart hook claims the pending link that
 * `issue start` leaves in the checkout's git dir (issue-link.ts). agy fires no
 * SessionStart, so nothing claimed it: prod run cmve96io9 (issue 2c762dea,
 * 2026-10-18) did its work and opened a PR, its link file was still on disk
 * two days later, and the run showed no session. Drive the real handler in a
 * real linked worktree, as `issue start --background` makes one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const startSession = vi.fn();
const linkIssueSession = vi.fn();

vi.mock('../api.js', () => ({
  api: {
    startSession: (...a: any[]) => startSession(...a),
    linkIssueSession: (...a: any[]) => linkIssueSession(...a),
    updateSession: vi.fn(async () => ({})),
    endSession: vi.fn(async () => ({})),
    ingestCommits: vi.fn(async () => ({ ingested: 1 })),
    importGitNote: vi.fn(async () => ({})),
  },
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, isConnectedMode: () => true, loadAgentConfig: () => ({ machineId: 'test-machine' }) };
});

const { handleAntigravity } = await import('../commands/hooks.js');
const { writePendingIssueLink, pendingIssueLinkPath } = await import('../issue-link.js');

const CID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef';
let home: string;
let repo: string;
let work: string;
let transcriptPath: string;
let realHome: string | undefined;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

function writeTranscript(file: string) {
  const steps = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-18T20:04:00.000Z', content: '<USER_REQUEST>\nWork on issue 2c762dea\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'TOOL_CALL', status: 'DONE', created_at: '2026-10-18T20:05:00.000Z', content: 'working', tool_calls: [{ name: 'write_file', args: { file_path: file } }] },
  ];
  fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n'));
}

const fire = (event: string, extra: Record<string, unknown> = {}) =>
  handleAntigravity(event, { conversationId: CID, workspacePaths: [work], transcriptPath, cwd: work, ...extra });

beforeEach(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-issue-link-')));
  home = path.join(root, 'home');
  repo = path.join(root, 'repo');
  work = path.join(root, 'repo-worktrees', 'issue-2c762dea');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  realHome = process.env.HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ORIGIN_AGY_IS_WATCHER;

  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(repo, 'config', 'user.email', 'a@test.dev');
  git(repo, 'config', 'user.name', 'A');
  git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  // The issue's own worktree, as `origin issue start --background` makes it.
  git(repo, 'worktree', 'add', '-q', '-b', 'issue/2c762dea-x', work);

  transcriptPath = path.join(root, 'transcript.jsonl');
  const lock = path.join(home, '.origin', 'agy-watch', `${CID}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(Date.now()));

  startSession.mockReset().mockResolvedValue({ sessionId: 'sess-agy-1' });
  linkIssueSession.mockReset().mockResolvedValue({ ok: true });
  writePendingIssueLink(work, { shortId: '2c762dea', repoId: 'repo-1', branch: 'issue/2c762dea-x', agent: 'antigravity', runId: 'run-1' });
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

describe('antigravity: a run started by `origin issue start`', () => {
  it('links its session to the issue run, once, from the worktree the link was left in', async () => {
    const linkFile = pendingIssueLinkPath(work)!;
    expect(linkFile).toContain(path.join('.git', 'worktrees'));
    expect(fs.existsSync(linkFile)).toBe(true);

    await fire('pre-tool-use', { toolCall: { name: 'write_file', args: { file_path: path.join(work, 'a.ts') } } });
    fs.writeFileSync(path.join(work, 'a.ts'), 'export const a = 1;\n');
    writeTranscript(path.join(work, 'a.ts'));
    await fire('post-tool-use');

    expect(linkIssueSession).toHaveBeenCalledTimes(1);
    expect(linkIssueSession).toHaveBeenCalledWith('repo-1', '2c762dea', 'sess-agy-1', 5000, 'run-1');
    expect(fs.existsSync(linkFile)).toBe(false);

    // Later fires find nothing to claim.
    await fire('post-tool-use');
    await fire('stop');
    expect(linkIssueSession).toHaveBeenCalledTimes(1);
  });

  it('the watcher process leaves the link for a real hook', async () => {
    fs.writeFileSync(path.join(work, 'a.ts'), 'export const a = 1;\n');
    writeTranscript(path.join(work, 'a.ts'));
    process.env.ORIGIN_AGY_IS_WATCHER = '1';
    try {
      await fire('post-tool-use');
    } finally {
      delete process.env.ORIGIN_AGY_IS_WATCHER;
    }
    expect(linkIssueSession).not.toHaveBeenCalled();
    expect(fs.existsSync(pendingIssueLinkPath(work)!)).toBe(true);
  });
});
