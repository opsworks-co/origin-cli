// The session whose shell is running `git commit` is the one committing.
//
// Session 6b770703 (2026-09-20) edited two files with a `python3 - <<EOF`
// heredoc and committed them in the SAME Bash call, so prepare-commit-msg ran
// before that call's post-tool-use had put either file in the turn's ledger.
// No open turn held a staged file, the overlap rule went looking through
// finished turns, and found `git-capture.ts` in ff9131bd's — the previous
// conversation in the same worktree, idle since the day before:
//   [prepare-commit-msg] attributed by staged-file overlap {"session":"ff9131bd-5e9","overlap":1,"staged":2}
// Its trailer went on the commit, post-commit followed the trailer, and the
// dashboard hung 6b770703's commit under a session that had not run in a day.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pickActiveSessionForCommit } from '../commands/hooks/git-hooks.js';
import { COMMIT_COMMAND_TTL_MS, commandMakesCommit, sessionIsRunningCommitHere, sessionRunningTheCommit, workTreeTop } from '../commit-command-in-flight.js';
import { getStatePath, saveSessionState, setCommitCommandInFlight } from '../session-state.js';

let repo = '';
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const writeState = (tag: string, state: Record<string, unknown>) =>
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify(state), { mode: 0o600 });

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-committing-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'git-capture.ts'), 'a\n');
  fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'o\n');
  git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

// Yesterday's conversation in this checkout: never ended, no turn open, and
// the staged file is in one of its FINISHED turns.
const dormant = () => writeState('dormant', {
  sessionId: 'dormant-yesterday-0001', sessionTag: 'dormant', agentSlug: 'claude-code',
  repoPath: repo, lastCwd: repo, status: 'RUNNING',
  startedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
  prompts: ['scope the in-flight row'],
  completedPromptMappings: [{ promptIndex: 0, filesChanged: ['src/git-capture.ts'] }],
});
// Today's: mid-turn, its ledger holds an EARLIER edit of this turn, not the
// files the running command wrote a moment ago.
const committing = (claim: Record<string, unknown> | null) => writeState('live', {
  sessionId: 'committing-now-0002', sessionTag: 'live', agentSlug: 'claude-code',
  repoPath: repo, lastCwd: repo, status: 'RUNNING',
  startedAt: new Date(Date.now() - 1200_000).toISOString(),
  prompts: ['review and merge'],
  activeTurn: { index: 0, turnId: 't0', promptText: 'review and merge', openedAt: new Date().toISOString() },
  liveEdits: [{ promptIndex: 0, edits: [{ file: 'src/other.ts' }] }],
  ...(claim ? { commitCommandInFlight: claim } : {}),
});
const stageTheHeredocEdit = () => {
  fs.writeFileSync(path.join(repo, 'src', 'git-capture.ts'), 'a\nb\n');
  git('add', 'src/git-capture.ts');
};

describe('prepare-commit-msg names the session that is running the commit', () => {
  it('control — with no claim the file rules run alone, and they find only the dormant session', () => {
    dormant(); committing(null); stageTheHeredocEdit();
    expect(pickActiveSessionForCommit(repo)?.sessionId).toBe('dormant-yesterday-0001');
  });

  it('the session whose pre-tool-use announced the commit keeps it, though no ledger holds the staged file yet', () => {
    dormant(); committing({ at: new Date().toISOString(), toolCallId: 'toolu_1', cwd: repo, turn: 0 }); stageTheHeredocEdit();
    expect(pickActiveSessionForCommit(repo)?.sessionId).toBe('committing-now-0002');
  });

  it('a shell parked in a subdirectory of the tree still counts as this tree', () => {
    dormant(); committing({ at: new Date().toISOString(), cwd: path.join(repo, 'src'), turn: 0 }); stageTheHeredocEdit();
    expect(pickActiveSessionForCommit(repo)?.sessionId).toBe('committing-now-0002');
  });
});

// git runs a linked worktree's commit hooks with GIT_DIR set and no
// GIT_WORK_TREE; under that `rev-parse --show-toplevel` answers whatever
// directory it is asked from (review of #1740, git 2.50.1).
describe('workTreeTop under the environment git gives a hook', () => {
  it('a subdirectory of a LINKED worktree resolves to the worktree top, not to itself', () => {
    const wt = path.join(path.dirname(repo), path.basename(repo) + '-wt');
    git('worktree', 'add', '-q', '-b', 'side', wt);
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    try {
      process.env.GIT_DIR = path.join(repo, '.git', 'worktrees', path.basename(wt));
      process.env.GIT_INDEX_FILE = path.join(process.env.GIT_DIR, 'index');
      const top = fs.realpathSync(wt);
      expect(fs.realpathSync(workTreeTop(path.join(wt, 'src'))!)).toBe(top);
      const now = Date.now();
      const s = { commitCommandInFlight: { at: new Date(now).toISOString(), cwd: path.join(wt, 'src'), turn: 0 } };
      expect(sessionIsRunningCommitHere(s, wt, workTreeTop, now)).toBe(true);
      // …and the main checkout, whose directory CONTAINS nothing of it, is another tree.
      expect(sessionIsRunningCommitHere(s, repo, workTreeTop, now)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      try { git('worktree', 'remove', '--force', wt); } catch { /* ignore */ }
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('sessionRunningTheCommit — when the claims settle it, and when they do not', () => {
  const top = (d: string) => (d.startsWith('/repo') ? '/repo' : d.startsWith('/other') ? '/other' : null);
  const now = Date.parse('2026-09-20T14:48:48Z');
  const at = '2026-09-20T14:48:40Z';
  type S = { id: string; lastClosedTurnIndex?: number; commitCommandInFlight?: any; inFlight?: string[] };
  const files = (s: S) => s.inFlight || [];
  const staged = new Set(['src/git-capture.ts']);
  const pick = (sessions: S[]) => { const r = sessionRunningTheCommit(sessions, '/repo', staged, files, top, now); return [r.session?.id ?? null, r.why]; };
  const dormantS: S = { id: 'dormant', lastClosedTurnIndex: 27 };

  it('one claimant with its turn open: it is the committer', () => {
    expect(pick([dormantS, { id: 'live', lastClosedTurnIndex: 2, commitCommandInFlight: { at, cwd: '/repo/packages', turn: 3 } }]))
      .toEqual(['live', 'commit command in flight']);
  });
  it('no claim: not settled here', () => {
    expect(pick([dormantS, { id: 'live', lastClosedTurnIndex: 2 }])[0]).toBeNull();
  });
  it('a claim left by a call that never reported back: aged out, its turn closed by Stop, or carrying no turn at all', () => {
    const old = new Date(now - COMMIT_COMMAND_TTL_MS - 1000).toISOString();
    expect(pick([dormantS, { id: 'live', lastClosedTurnIndex: 2, commitCommandInFlight: { at: old, cwd: '/repo', turn: 3 } }])[0]).toBeNull();
    expect(pick([dormantS, { id: 'live', lastClosedTurnIndex: 3, commitCommandInFlight: { at, cwd: '/repo', turn: 3 } }])[0]).toBeNull();
    expect(pick([dormantS, { id: 'live', lastClosedTurnIndex: 2, commitCommandInFlight: { at, cwd: '/repo' } }])[0]).toBeNull();
    // A turn whose only tool call is the commit was never opened by a tool hook; it is committing all the same.
    expect(pick([dormantS, { id: 'live', commitCommandInFlight: { at, cwd: '/repo', turn: 0 } }])[0]).toBe('live');
  });
  it('a commit running in another working tree says nothing about this one', () => {
    expect(pick([dormantS, { id: 'live', lastClosedTurnIndex: 2, commitCommandInFlight: { at, cwd: '/other/x', turn: 3 } }])[0]).toBeNull();
  });
  it('several claimants prove nothing', () => {
    const a: S = { id: 'a', lastClosedTurnIndex: 0, commitCommandInFlight: { at, cwd: '/repo', turn: 1 } };
    const b: S = { id: 'b', lastClosedTurnIndex: 1, commitCommandInFlight: { at, cwd: '/repo', turn: 2 } };
    expect(pick([a, b])).toEqual([null, 'several sessions announced a commit here']);
  });
  it("a claimant with no staged file gives way to ANOTHER session whose open turn holds one — a stale claim must not outrank a ledger", () => {
    const stale: S = { id: 'stale', lastClosedTurnIndex: 0, commitCommandInFlight: { at, cwd: '/repo', turn: 1 } };
    const writer: S = { id: 'writer', inFlight: ['src/git-capture.ts'] };
    expect(pick([stale, writer])[0]).toBeNull();
    // Both hold one, or only the claimant does: the claim stands.
    expect(pick([{ ...stale, inFlight: ['src/git-capture.ts'] }, writer])[0]).toBe('stale');
    expect(pick([{ ...stale, inFlight: ['src/git-capture.ts'] }, dormantS])[0]).toBe('stale');
  });
});

// post-commit runs in the background: it loads every session's state while the
// committing call is still running and saves those objects seconds later.
describe('only the tool hooks write the claim; every other save takes it as it is on disk', () => {
  const seed = (extra: Record<string, unknown>) => {
    const state: any = { sessionId: 'claim-owner-0003', sessionTag: 'claimtag', agentSlug: 'claude-code', repoPath: repo, startedAt: new Date().toISOString(), prompts: ['p'], ...extra };
    fs.writeFileSync(getStatePath(repo, 'claimtag'), JSON.stringify(state));
    return state;
  };
  const onDisk = () => JSON.parse(fs.readFileSync(getStatePath(repo, 'claimtag'), 'utf-8'));
  const claim = { at: new Date().toISOString(), toolCallId: 'toolu_9', cwd: '/x', turn: 0 };

  it('a hook that read the state WITH the claim cannot write it back after post-tool-use cleared it', () => {
    seed({ commitCommandInFlight: claim });
    const postCommit = onDisk();                       // read mid-call
    const postToolUse = onDisk();
    setCommitCommandInFlight(postToolUse, null);
    saveSessionState(postToolUse, repo, 'claimtag');
    expect(onDisk().commitCommandInFlight ?? null).toBeNull();
    postCommit.sessionCommitShas = ['abc1234'];
    saveSessionState(postCommit, repo, 'claimtag');     // seconds later
    expect(onDisk().commitCommandInFlight ?? null).toBeNull();
    expect(onDisk().sessionCommitShas).toEqual(['abc1234']);
  });

  it('a hook that read the state BEFORE the claim cannot erase it ahead of prepare-commit-msg', () => {
    seed({});
    const other = onDisk();
    const preToolUse = onDisk();
    setCommitCommandInFlight(preToolUse, claim);
    saveSessionState(preToolUse, repo, 'claimtag');
    other.lastCwd = repo;
    saveSessionState(other, repo, 'claimtag');
    expect(onDisk().commitCommandInFlight).toEqual(claim);
    expect(onDisk().lastCwd).toBe(repo);
  });
});

describe('sessionIsRunningCommitHere', () => {
  const top = (d: string) => (d.startsWith('/repo/.claude/worktrees/wt') ? '/repo/.claude/worktrees/wt' : d.startsWith('/repo') ? '/repo' : null);
  const now = Date.parse('2026-09-20T14:48:48Z');
  const at = '2026-09-20T14:48:40Z';
  it('a linked worktree under the main checkout is a different tree', () => {
    expect(sessionIsRunningCommitHere({ commitCommandInFlight: { at, cwd: '/repo/.claude/worktrees/wt/packages/cli', turn: 0 } }, '/repo/.claude/worktrees/wt', top, now)).toBe(true);
    expect(sessionIsRunningCommitHere({ commitCommandInFlight: { at, cwd: '/repo/.claude/worktrees/wt', turn: 0 } }, '/repo', top, now)).toBe(false);
    expect(sessionIsRunningCommitHere({ commitCommandInFlight: { at, cwd: '/repo/packages', turn: 0 } }, '/repo/.claude/worktrees/wt', top, now)).toBe(false);
  });
  it('no claim, no cwd, a bad or future time: no evidence', () => {
    expect(sessionIsRunningCommitHere({}, '/repo', top, now)).toBe(false);
    expect(sessionIsRunningCommitHere({ commitCommandInFlight: null }, '/repo', top, now)).toBe(false);
    expect(sessionIsRunningCommitHere({ commitCommandInFlight: { at, turn: 0 } }, '/repo', top, now)).toBe(false);
    expect(sessionIsRunningCommitHere({ commitCommandInFlight: { at: 'x', cwd: '/repo', turn: 0 } }, '/repo', top, now)).toBe(false);
    expect(sessionIsRunningCommitHere({ commitCommandInFlight: { at: '2026-09-20T15:30:00Z', cwd: '/repo', turn: 0 } }, '/repo', top, now)).toBe(false);
    expect(sessionIsRunningCommitHere({ commitCommandInFlight: { at, cwd: '/nowhere', turn: 0 } }, '/repo', top, now)).toBe(false);
  });
});

describe('commandMakesCommit', () => {
  it.each([
    'git commit -m x',
    'git add -A && git commit -q -F -',
    "python3 - <<'EOF'\nopen('a','w').write('x')\nEOF\ngit add a; git commit -qm 'x'",
    'git -c user.name=x -c user.email=y commit -m z',
    'git -C packages/cli commit -m z',
    'git revert HEAD',
    'a&&git commit -m x',
    'env X=1 git commit -m x',
    'git --no-pager commit -m x',
    '(git commit -m x)',
  ])('yes: %s', (cmd) => expect(commandMakesCommit(cmd)).toBe(true));

  it.each([
    'git status',
    // The hook returns before the picker for these; a claim would decide nothing.
    'cd repo && git merge --no-ff origin/main',
    'git cherry-pick abc1234',
    'git rebase --continue',
    'git pull --no-rebase origin main',
    'git log --oneline -3',
    'git show HEAD:packages/cli/commit.ts',
    'git diff --stat origin/main',
    'gh pr merge 12 --squash',
    'echo "git commit"x',
    'grep -rn "commit" src',
    'git commit-tree abc',
    'git merge-tree --write-tree a b',
    'git merge-base a b',
    'git rev-parse commit',
    '',
  ])('no: %s', (cmd) => expect(commandMakesCommit(cmd)).toBe(false));
});
