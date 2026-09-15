/**
 * A write the turn only WATCHED does not exempt a file a foreign commit left
 * unchanged. Driven against real git.
 *
 * Session c5487aa9 turn 3 ran `git checkout --detach origin/main`, which wrote
 * #1642's 12 files. The re-Stop read the journal's `write_journal` edits on five
 * of them as the turn's own, exempted them from the foreign-commit drop, and
 * the safety net rebuilt the row from them: 5 files, +35/-4, authored by nobody.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { foreignCommitFilesForTurn } from '../commands/hooks/stop.js';
import { captureGitState, createShadowCommit } from '../git-capture.js';

let repo: string;
let upstream: string;
let baseline: string;
const git = (args: string[], env: Record<string, string> = {}) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-watched-checkout-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'me@example.com']);
  git(['config', 'user.name', 'Me']);
  git(['config', 'commit.gpgsign', 'false']);
  write('a.ts', 'a1\n'); write('b.ts', 'b1\n'); write('c.ts', 'c1\n');
  git(['add', '-A']); git(['commit', '-qm', 'base']);
  // Another session's PR, squash-merged on GitHub.
  git(['checkout', '-qb', 'upstream']);
  write('b.ts', 'b1\nb2 upstream\n'); write('c.ts', 'c1\nc2 upstream\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'fix(codex): another PR (#1642)\n\nOrigin-Session: f53bd03d-2fd | Codex | 31 prompts'], {
    GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
  });
  upstream = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', 'main']);
  baseline = createShadowCommit(repo, 'turn0') || git(['rev-parse', 'HEAD']);
  // The turn's only action: check that PR out.
  git(['checkout', '-q', '--detach', upstream]);
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

const stateWith = (edits: Array<{ file: string; evidence?: string }>) => ({
  sessionId: '11111111-2222-4333-8444-555555555555',
  repoPath: repo,
  prompts: ['go ahead'],
  promptTurnIds: ['t_0'],
  commitTurns: [],
  sessionCommitShas: [],
  liveEdits: edits.length === 0 ? [] : [{
    promptIndex: 0, toolName: 'origin:write-journal', capturedAt: new Date().toISOString(),
    edits: edits.map((e) => ({ ...e, op: 'write', source: 'uncommitted' })),
  }],
}) as any;

const excluded = (state: any, mappings: any[] = []) =>
  foreignCommitFilesForTurn(
    repo, state, captureGitState(repo, baseline, { fullContext: true }) as any, mappings, 0, 0, baseline,
  ).sort();

describe('a turn that only checked out another PR', () => {
  it('keeps every file out when its only claim is a watched write', () => {
    const state = stateWith([{ file: 'b.ts', evidence: 'write_journal' }, { file: 'c.ts', evidence: 'command_probe' }]);
    expect(excluded(state)).toEqual(['b.ts', 'c.ts']);
  });

  it('keeps every file out with no claim at all', () => {
    expect(excluded(stateWith([]))).toEqual(['b.ts', 'c.ts']);
  });
});

describe('a turn that really wrote a file the other PR also changed', () => {
  it('exempts a file a tool call wrote', () => {
    expect(excluded(stateWith([{ file: 'b.ts', evidence: 'tool_call' }]))).toEqual(['c.ts']);
  });

  it('exempts a file its transcript names', () => {
    expect(excluded(stateWith([]), [{ promptIndex: 0, filesChanged: ['b.ts'] }])).toEqual(['c.ts']);
  });

  it('exempts a watched file the turn edited on top of the checkout', () => {
    write('b.ts', 'b1\nb2 upstream\nb3 mine\n');
    expect(excluded(stateWith([{ file: 'b.ts', evidence: 'write_journal' }]))).toEqual(['c.ts']);
  });

  it('treats a ledger edit with no recorded evidence as authorship, as before', () => {
    expect(excluded(stateWith([{ file: 'b.ts' }]))).toEqual(['c.ts']);
  });
});
