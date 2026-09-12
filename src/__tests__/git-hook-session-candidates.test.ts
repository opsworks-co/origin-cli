// listSessionsForGitHook must not delete a live session just because it never
// recorded a `lastCwd`.
//
// Real failure (repo `popok`, 2026-07-23): a Codex session's heartbeat daemon
// never exited, so its state stayed `status: RUNNING` and `isSessionAlive` kept
// returning true for hours. Hours later a Cursor session committed
// `eight_rows.txt`. Cursor writes no `lastCwd`; the stale Codex state had one
// pointing at the same repo. The old narrowing returned ONLY the lastCwd
// matches, so the live Cursor session was dropped and
// pickActiveSessionForCommit saw a single candidate — returning it before the
// staged-file-overlap check (the strongest signal, and the one that would have
// picked Cursor, which alone touched eight_rows.txt) ever ran. The commit was
// trailered `Origin-Session: 88c6190f | Codex`, so the Cursor session owned no
// commit: every turn rendered "uncommitted" and the session diff read +0/-0.
//
// Both candidates must survive so the overlap check can decide on evidence.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSessionsForGitHook } from '../commands/hooks.js';

let repo: string;

const writeState = (tag: string, state: Record<string, unknown>) => {
  fs.writeFileSync(
    path.join(repo, '.git', `origin-session-${tag}.json`),
    JSON.stringify(state),
    { mode: 0o600 },
  );
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hook-cand-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('listSessionsForGitHook — candidate narrowing', () => {
  it('keeps a live session that records no lastCwd alongside a lastCwd match', () => {
    // Stale-but-still-"alive" Codex session that DOES carry a lastCwd.
    writeState('stalecodex', {
      sessionId: 'stale-codex-0001',
      sessionTag: 'stalecodex',
      agentSlug: 'codex',
      repoPath: repo,
      lastCwd: repo,
      status: 'RUNNING',
      startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      completedPromptMappings: [{ filesChanged: ['ten_rows.txt'] }],
    });
    // Live Cursor session — Cursor never writes lastCwd.
    writeState('livecursor', {
      sessionId: 'live-cursor-0002',
      sessionTag: 'livecursor',
      agentSlug: 'cursor',
      repoPath: repo,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      completedPromptMappings: [{ filesChanged: ['eight_rows.txt'] }],
    });

    const ids = listSessionsForGitHook(repo).map((s) => s.sessionId);

    // The regression: the live Cursor session used to be filtered out here,
    // handing the commit to the stale Codex session by default.
    expect(ids).toContain('live-cursor-0002');
    expect(ids).toContain('stale-codex-0001');
  });

  it('still drops a session demonstrably working in another directory', () => {
    writeState('elsewhere', {
      sessionId: 'elsewhere-0003',
      sessionTag: 'elsewhere',
      agentSlug: 'codex',
      repoPath: repo,
      lastCwd: path.join(os.tmpdir(), 'some-other-repo'),
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    writeState('here', {
      sessionId: 'here-0004',
      sessionTag: 'here',
      agentSlug: 'codex',
      repoPath: repo,
      lastCwd: repo,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    const ids = listSessionsForGitHook(repo).map((s) => s.sessionId);
    expect(ids).toContain('here-0004');
    expect(ids).not.toContain('elsewhere-0003');
  });
});

// A commit made inside a LINKED WORKTREE used to be credited to nobody.
//
// Real failure (repo `origin`, 2026-08-22): an agent working from the main
// checkout created a worktree under its own session scratchpad, edited there
// and committed there. The hook ran with cwd = the worktree; every session's
// lastCwd was the main checkout. So `exact` was empty, and since those
// sessions all HAD a lastCwd the unknown-cwd net was empty too — the function
// returned []. post-commit logged "no active sessions, skipped API update" and
// prepare-commit-msg logged "skip — no unambiguous active session", so the
// commit reached neither the API nor a trailer while its session sat RUNNING.
//
// Only bites with 2+ live sessions: a lone session never reaches the narrowing,
// which is why worktree commits attribute correctly some of the time.
//
// The worktree path names its owning session, so this is resolvable without
// guessing. Where it ISN'T — parallel sessions each in their own worktree —
// worktree-session-linking.test.ts pins the deliberate "return nothing" rule.
describe('listSessionsForGitHook — commits inside a session-owned worktree', () => {
  const AGENT_SESSION_ID = '33510e52-2c58-454e-a487-8e29cb3f6ca5';
  let wtRepo: string;
  let wt: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

  const writeWtState = (tag: string, state: Record<string, unknown>) => {
    fs.writeFileSync(
      path.join(wtRepo, '.git', `origin-session-${tag}.json`),
      JSON.stringify(state),
      { mode: 0o600 },
    );
  };

  beforeEach(() => {
    wtRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hook-wt-')));
    git(wtRepo, 'init', '-q', '-b', 'main');
    git(wtRepo, 'config', 'user.email', 't@t.dev');
    git(wtRepo, 'config', 'user.name', 'T');
    git(wtRepo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(wtRepo, 'README.md'), 'seed\n');
    git(wtRepo, 'add', '.');
    git(wtRepo, 'commit', '-qm', 'seed');
    // Mirrors the real layout: <scratchpad-root>/<agentSessionId>/scratchpad/<name>
    wt = path.join(wtRepo, 'scratch', AGENT_SESSION_ID, 'scratchpad', 'wt-a');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(wtRepo, 'worktree', 'add', '-q', '-b', 'feature-x', wt);
  });

  afterEach(() => {
    try { fs.rmSync(wtRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const twoLiveSessions = () => {
    writeWtState('owner', {
      sessionId: 'wt-owner-00001',
      sessionTag: 'owner',
      agentSessionId: AGENT_SESSION_ID,
      agentSlug: 'claude-code',
      repoPath: wtRepo,
      canonicalRepoPath: wtRepo,
      lastCwd: wtRepo, // the agent runs from the MAIN checkout
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    writeWtState('sibling', {
      sessionId: 'wt-sibling-0002',
      sessionTag: 'sibling',
      agentSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      agentSlug: 'codex',
      repoPath: wtRepo,
      canonicalRepoPath: wtRepo,
      lastCwd: wtRepo,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
  };

  it('credits the session the worktree path names', () => {
    twoLiveSessions();
    const ids = listSessionsForGitHook(wt).map((s) => s.sessionId);
    // The regression: this returned [] and the commit was credited to nobody.
    expect(ids).toEqual(['wt-owner-00001']);
  });

  it('does not guess when the path names no session', () => {
    twoLiveSessions();
    const plain = path.join(wtRepo, 'plain-wt');
    git(wtRepo, 'worktree', 'add', '-q', '-b', 'feature-y', plain);
    // Neither session owns this path — the deliberate "don't guess" rule holds.
    expect(listSessionsForGitHook(plain)).toEqual([]);
  });

  it('does not guess when two sessions both match the path', () => {
    twoLiveSessions();
    // A second session claiming the same id segment makes ownership ambiguous.
    writeWtState('twin', {
      sessionId: 'wt-twin-00003',
      sessionTag: 'twin',
      agentSessionId: AGENT_SESSION_ID,
      agentSlug: 'cursor',
      repoPath: wtRepo,
      canonicalRepoPath: wtRepo,
      lastCwd: wtRepo,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    expect(listSessionsForGitHook(wt)).toEqual([]);
  });

  it('leaves the main-checkout path unchanged — an exact lastCwd match still wins', () => {
    twoLiveSessions();
    writeWtState('elsewhere', {
      sessionId: 'wt-elsewhere-04',
      sessionTag: 'elsewhere',
      agentSessionId: 'ffffffff-0000-1111-2222-333333333333',
      agentSlug: 'codex',
      repoPath: wtRepo,
      canonicalRepoPath: wtRepo,
      lastCwd: path.join(os.tmpdir(), 'origin-nowhere'),
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    const ids = listSessionsForGitHook(wtRepo).map((s) => s.sessionId);
    expect(ids).toContain('wt-owner-00001');
    expect(ids).toContain('wt-sibling-0002');
    expect(ids).not.toContain('wt-elsewhere-04');
  });
});

// A commit made while the agent's shell sat in a SUBDIRECTORY was credited to
// nobody.
//
// Real failure (repo `origin`, prod session d0cec15e, 2026-08-25): two commits
// one turn apart in the same session. Git runs its hooks from the working tree
// ROOT, but `lastCwd` records wherever the last lifecycle hook fired — and the
// agent had run `cd apps/web && …`. `sameDir` is strict equality, so
// `…/origin/apps/web` never matched hookCwd `…/origin`; every candidate had a
// lastCwd, so the unknown-cwd net was empty too, and the narrowing returned [].
// post-commit logged "no active sessions, skipped API update" and
// prepare-commit-msg wrote no trailer — so no Commit ROW was ever created. The
// commit was not merely unattributed, it was ABSENT: the session read +262/-28
// while its own PR read +287/-28.
//
// The first commit attributed fine purely because lastCwd happened to be the
// repo root at that moment. Same session, same repo, opposite outcomes.
describe('listSessionsForGitHook — agent cwd is a subdirectory', () => {
  const twoSessionsWorkingInSubdirs = () => {
    fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'apps', 'api'), { recursive: true });
    writeState('webby', {
      sessionId: 'sub-web-000001',
      sessionTag: 'webby',
      agentSlug: 'claude-code',
      repoPath: repo,
      lastCwd: path.join(repo, 'apps', 'web'),
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    writeState('apiy', {
      sessionId: 'sub-api-000002',
      sessionTag: 'apiy',
      agentSlug: 'claude-code',
      repoPath: repo,
      lastCwd: path.join(repo, 'apps', 'api'),
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
  };

  it('does not return nothing just because both agents cd-ed into subdirectories', () => {
    twoSessionsWorkingInSubdirs();
    const ids = listSessionsForGitHook(repo).map((s) => s.sessionId);
    // The regression: this was [], so the commit reached neither the API nor a
    // trailer. Both are in this tree; pickActiveSessionForCommit weighs their
    // staged-file overlap from here, which is the evidence that can decide.
    expect(ids).toContain('sub-web-000001');
    expect(ids).toContain('sub-api-000002');
  });

  it('still drops a session whose lastCwd is a different repo', () => {
    twoSessionsWorkingInSubdirs();
    writeState('faraway', {
      sessionId: 'sub-far-000003',
      sessionTag: 'faraway',
      agentSlug: 'codex',
      repoPath: repo,
      lastCwd: path.join(os.tmpdir(), 'origin-hook-cand-somewhere-else'),
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    const ids = listSessionsForGitHook(repo).map((s) => s.sessionId);
    expect(ids).not.toContain('sub-far-000003');
  });

  it('an exact lastCwd match comes first, and the same-tree siblings stay for the picker', () => {
    // This used to return the root session ALONE. Session e1095412 lost both
    // of its commits that way: it had cd-ed into packages/cli, an idle
    // sibling chat sat at the worktree root, and `ofActive: 1` meant the
    // picker never weighed the open turn that had staged every file. The
    // exact match is now the tie-break (pickSessionForCommit 'cwd',
    // breakTie), not the gate.
    twoSessionsWorkingInSubdirs();
    writeState('atroot', {
      sessionId: 'sub-root-00004',
      sessionTag: 'atroot',
      agentSlug: 'claude-code',
      repoPath: repo,
      lastCwd: repo,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    const ids = listSessionsForGitHook(repo).map((s) => s.sessionId);
    expect(ids[0]).toBe('sub-root-00004');
    expect([...ids].sort()).toEqual(['sub-api-000002', 'sub-root-00004', 'sub-web-000001']);
  });
});

// A session that records no lastCwd but DOES record a different worktree must
// not ride along on a sibling worktree's commit.
//
// Real failure (prod, 2026-08-25). Copilot Desktop runs every chat in its own
// linked worktree and never writes a lastCwd, so both live chats fell into the
// "unknown cwd" net that exists for agents like Cursor. That net is unconditional
// — no lastCwd meant "keep" — so a commit made in worktree `dolobanko-urban-journey`
// kept the chat living in `dolobanko-jubilant-meme` as a candidate, and
// post-commit's `for (const s of activeSessions)` loop then stamped the
// committing worktree's branch, filesChanged, linesAdded and commitCount onto
// it. Session 2f31a7fe, whose own branch was `dolobanko-experimental-code`, was
// restamped `dolobanko-polished-ui-feature` by a commit it had no part in.
//
// "No lastCwd" means we don't know where it is working. It does not license
// ignoring a repoPath that says, unambiguously, somewhere else.
describe('listSessionsForGitHook — sibling worktrees with no lastCwd', () => {
  let sibRepo: string;
  let wtA: string;
  let wtB: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

  const writeSibState = (tag: string, state: Record<string, unknown>) => {
    fs.writeFileSync(
      path.join(sibRepo, '.git', `origin-session-${tag}.json`),
      JSON.stringify(state),
      { mode: 0o600 },
    );
  };

  beforeEach(() => {
    sibRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hook-sib-')));
    git(sibRepo, 'init', '-q', '-b', 'main');
    git(sibRepo, 'config', 'user.email', 't@t.dev');
    git(sibRepo, 'config', 'user.name', 'T');
    git(sibRepo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(sibRepo, 'README.md'), 'seed\n');
    git(sibRepo, 'add', '.');
    git(sibRepo, 'commit', '-qm', 'seed');
    // Copilot's layout: one worktree per chat, side by side.
    wtA = path.join(sibRepo, 'wt', 'urban-journey');
    wtB = path.join(sibRepo, 'wt', 'jubilant-meme');
    fs.mkdirSync(path.join(sibRepo, 'wt'), { recursive: true });
    git(sibRepo, 'worktree', 'add', '-q', '-b', 'urban-journey', wtA);
    git(sibRepo, 'worktree', 'add', '-q', '-b', 'jubilant-meme', wtB);
  });

  afterEach(() => {
    try { fs.rmSync(sibRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const twoCopilotChats = () => {
    // Copilot writes repoPath = its worktree and never a lastCwd.
    writeSibState('chat-a', {
      sessionId: 'copilot-chat-a1',
      sessionTag: 'chat-a',
      agentSlug: 'copilot',
      repoPath: wtA,
      canonicalRepoPath: sibRepo,
      branch: 'urban-journey',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    writeSibState('chat-b', {
      sessionId: 'copilot-chat-b2',
      sessionTag: 'chat-b',
      agentSlug: 'copilot',
      repoPath: wtB,
      canonicalRepoPath: sibRepo,
      branch: 'jubilant-meme',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
  };

  it('keeps only the chat whose worktree is being committed in', () => {
    twoCopilotChats();
    // The regression: this returned both, so post-commit restamped chat B's
    // branch and added chat A's files and line counts to it.
    expect(listSessionsForGitHook(wtA).map((s) => s.sessionId)).toEqual(['copilot-chat-a1']);
    expect(listSessionsForGitHook(wtB).map((s) => s.sessionId)).toEqual(['copilot-chat-b2']);
  });

  it('still keeps a lastCwd-less session that records no tree at all', () => {
    twoCopilotChats();
    writeSibState('notree', {
      sessionId: 'no-tree-000003',
      sessionTag: 'notree',
      agentSlug: 'cursor',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    // Genuinely unknown — it stays a candidate for the evidence checks to weigh.
    expect(listSessionsForGitHook(wtA).map((s) => s.sessionId)).toContain('no-tree-000003');
  });
});
