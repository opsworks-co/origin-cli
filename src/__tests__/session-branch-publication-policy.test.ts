/**
 * OR-48/A8: where the origin-sessions branch (raw per-prompt payloads) may be
 * pushed, through the real pre-push hook and the real publish-moment path on
 * real repositories. Both paths share one decision (sessionBranchPushTarget)
 * and one pusher (pushSessionBranchTo); these pin that they agree on
 * permission, strategy and destination:
 *
 *   - default: nowhere;
 *   - pushStrategy 'false': nowhere, opt-in or snapshotRepo notwithstanding;
 *   - snapshotRepo: that destination only — never also the repository `origin`;
 *   - pushStrategy 'prompt': not at a publish moment, at the user's push;
 *   - pushStrategy 'always': `origin`, without the prompt opt-in;
 *   - a broken .origin.json never inherits a machine-wide opt-in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const importGitNote = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../api.js', () => ({ api: { importGitNote } }));

const { handlePrePush } = await import('../commands/hooks.js');
const { pushSessionBranch } = await import('../local-entrypoint.js');
const { writeGitNotes } = await import('../git-notes.js');
const { clearConfigCache } = await import('../config.js');

const LEAK = 'OR48_DO_NOT_LEAK_prompt_7f3a';
const BRANCH = 'refs/heads/origin-sessions';

let base: string;
let origin: string;
let snapshot: string;
let repo: string;
const origCwd = process.cwd();
// The per-worker HOME the vitest setup isolates — never the real one.
const machineConfig = path.join(os.homedir(), '.origin', 'config.json');

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();

function has(remote: string, ref: string): boolean {
  return git(remote, 'for-each-ref', '--format=%(refname)').split('\n').includes(ref);
}

function machine(cfg: Record<string, unknown> | null) {
  if (cfg === null) fs.rmSync(machineConfig, { force: true });
  else {
    fs.mkdirSync(path.dirname(machineConfig), { recursive: true });
    fs.writeFileSync(machineConfig, JSON.stringify(cfg));
  }
  clearConfigCache();
}

function repoConfig(raw: string | null) {
  const p = path.join(repo, '.origin.json');
  fs.rmSync(p, { recursive: true, force: true });
  if (raw !== null) fs.writeFileSync(p, raw);
}

async function prePush() {
  process.chdir(repo);
  try { await handlePrePush(); } finally { process.chdir(origCwd); }
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sessions-policy-')));
  origin = path.join(base, 'origin.git');
  snapshot = path.join(base, 'snapshot.git');
  repo = path.join(base, 'repo');
  for (const bare of [origin, snapshot]) {
    fs.mkdirSync(bare);
    git(bare, 'init', '-q', '--bare', '-b', 'main');
  }
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@origin.dev');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.origin.json\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'a');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  // A built origin-sessions branch holding a prompt, as the hooks leave it.
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: `${LEAK} prompt\n`, encoding: 'utf-8' }).trim();
  const tree = execFileSync('git', ['mktree'], { cwd: repo, input: `100644 blob ${blob}\tprompts.md\n`, encoding: 'utf-8' }).trim();
  const commit = git(repo, 'commit-tree', tree, '-m', 'sessions');
  git(repo, 'update-ref', BRANCH, commit);
  machine(null);
});

afterEach(() => {
  process.chdir(origCwd);
  machine(null);
  fs.rmSync(base, { recursive: true, force: true });
});

describe('origin-sessions publication: one decision for pre-push and publish moments', () => {
  it('default: the branch stays off origin', async () => {
    pushSessionBranch(repo);
    await prePush();
    expect(has(origin, BRANCH)).toBe(false);
  });

  it('prompt opt-in (repo or machine) + pushStrategy false: the branch stays off every remote', async () => {
    for (const setup of [
      () => { repoConfig('{"notesIncludePrompts": true}'); machine({ pushStrategy: 'false', snapshotRepo: snapshot }); },
      () => { repoConfig(null); machine({ notesIncludePrompts: true, pushStrategy: 'false', snapshotRepo: snapshot }); },
      () => { repoConfig(null); machine({ notesIncludePrompts: true, pushStrategy: 'false' }); },
    ]) {
      setup();
      pushSessionBranch(repo);
      await prePush();
      expect(has(origin, BRANCH)).toBe(false);
      expect(has(snapshot, BRANCH)).toBe(false);
    }
  });

  it('snapshotRepo without the opt-in: the snapshot gets the branch, the repository origin never does', async () => {
    machine({ snapshotRepo: snapshot });
    pushSessionBranch(repo);
    expect(has(snapshot, BRANCH)).toBe(true);
    expect(has(origin, BRANCH)).toBe(false);
    await prePush();
    expect(has(origin, BRANCH)).toBe(false);
  });

  it('snapshotRepo with the opt-in still never sends the branch to origin', async () => {
    repoConfig('{"notesIncludePrompts": true}');
    machine({ snapshotRepo: snapshot });
    await prePush();
    expect(has(snapshot, BRANCH)).toBe(true);
    expect(has(origin, BRANCH)).toBe(false);
  });

  it('pushStrategy prompt + opt-in: a publish moment does not push, the user\'s push does — to origin', async () => {
    repoConfig('{"notesIncludePrompts": true}');
    machine({ pushStrategy: 'prompt' });
    pushSessionBranch(repo);
    expect(has(origin, BRANCH)).toBe(false);
    await prePush();
    expect(has(origin, BRANCH)).toBe(true);
    expect(has(snapshot, BRANCH)).toBe(false);
  });

  it('pushStrategy prompt + snapshotRepo: the user\'s push goes to the snapshot only', async () => {
    machine({ pushStrategy: 'prompt', snapshotRepo: snapshot });
    pushSessionBranch(repo);
    expect(has(snapshot, BRANCH)).toBe(false);
    await prePush();
    expect(has(snapshot, BRANCH)).toBe(true);
    expect(has(origin, BRANCH)).toBe(false);
  });

  it('pushStrategy always without the opt-in: the explicit choice publishes to origin', async () => {
    machine({ pushStrategy: 'always' });
    pushSessionBranch(repo);
    expect(has(origin, BRANCH)).toBe(true);
  });

  it('a broken .origin.json + machine opt-in: no prompt text in the note, no memory, no branch', async () => {
    for (const raw of ['{"notesIncludePrompts": "true"}', '{ not json', '[]', 'DIRECTORY']) {
      if (raw === 'DIRECTORY') { repoConfig(null); fs.mkdirSync(path.join(repo, '.origin.json')); }
      else repoConfig(raw);
      machine({ notesIncludePrompts: true });

      const sha = git(repo, 'rev-parse', 'HEAD');
      writeGitNotes(repo, [sha], {
        sessionId: 'sess-1', model: 'm', promptCount: 1,
        promptSummary: `${LEAK} summary`, fullPrompt: `${LEAK} full prompt`,
        markers: { decision: [`${LEAK} decision`] },
        originUrl: 'https://origin.example.com/sessions/sess-1', linesAdded: 1, linesRemoved: 0,
      });
      const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD');
      git(repo, 'notes', '--ref=origin-memory', 'add', '-f', '-m', JSON.stringify({ version: 2, sessions: [{ sessionId: 's', summary: LEAK }], commits: [] }), root);

      await prePush();

      expect(git(repo, 'notes', '--ref=origin', 'show', sha)).not.toContain(LEAK);
      expect(git(origin, 'notes', '--ref=origin', 'show', sha)).not.toContain(LEAK);
      expect(has(origin, 'refs/notes/origin-memory')).toBe(false);
      expect(has(origin, BRANCH)).toBe(false);
    }
  });
});
