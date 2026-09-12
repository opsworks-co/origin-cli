// One live session in a repo is not evidence that a commit is its.
//
// Session b3b45536 (lumen-interiors, 2026-09-09): one prompt, "check what's
// in here" — a read-only turn, already closed, empty file list — and a README
// commit made in the main checkout by someone else landed on it. Both commit
// hooks trusted the lone candidate: prepare-commit-msg wrote its trailer,
// post-commit recorded the sha, the header read +41/-8 while its turn carried
// +0/-0. `origin verify-capture` flagged the header twice.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pickActiveSessionForCommit } from '../commands/hooks/git-hooks.js';
import { loneSessionMayOwnCommit, runningTurnTouchedCommit } from '../commands/hooks/post-commit.js';

let repo = '';
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const writeState = (tag: string, state: Record<string, unknown>) =>
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify(state), { mode: 0o600 });

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-lone-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  // Someone else's README edit, staged for commit.
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n\n## Deploying\n');
  git('add', '-A');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

const base = () => ({
  sessionId: 'lone-session-0001', sessionTag: 'lone', agentSlug: 'claude-code',
  repoPath: repo, lastCwd: repo, status: 'RUNNING', startedAt: new Date(Date.now() - 60_000).toISOString(),
  headShaAtStart: git('rev-parse', 'HEAD'), prompts: ["check what's in here"],
});

describe('prepare-commit-msg with a single live session', () => {
  it('refuses a session whose only turn is closed and touched nothing', () => {
    writeState('lone', { ...base(), completedPromptMappings: [{ promptIndex: 0, filesChanged: [] }], lastClosedTurnIndex: 0 });
    expect(pickActiveSessionForCommit(repo)).toBeNull();
  });
  it('credits a session with a turn open', () => {
    writeState('lone', { ...base(), completedPromptMappings: [{ promptIndex: 0, filesChanged: [] }],
      activeTurn: { index: 0, turnId: 't0', promptText: "check what's in here", openedAt: new Date().toISOString() } });
    expect(pickActiveSessionForCommit(repo)?.sessionId).toBe('lone-session-0001');
  });
  it('credits a session whose recorded turn touched the staged file', () => {
    writeState('lone', { ...base(), completedPromptMappings: [{ promptIndex: 0, filesChanged: ['README.md'] }], lastClosedTurnIndex: 0 });
    expect(pickActiveSessionForCommit(repo)?.sessionId).toBe('lone-session-0001');
  });
  it('still credits a session with no recorded turns at all (nothing to contradict it)', () => {
    writeState('lone', { ...base() });
    expect(pickActiveSessionForCommit(repo)?.sessionId).toBe('lone-session-0001');
  });
});

describe('loneSessionMayOwnCommit', () => {
  it('an empty file list is not evidence against', () => {
    expect(loneSessionMayOwnCommit({ completedPromptMappings: [{ promptIndex: 0, filesChanged: [] }] } as any, []).ok).toBe(true);
  });
  it('an open turn is enough on its own — the agent is mid-work', () => {
    const s = { activeTurn: { index: 1, turnId: 't1', promptText: 'x', openedAt: '' }, completedPromptMappings: [{ promptIndex: 0, filesChanged: [] }] } as any;
    expect(loneSessionMayOwnCommit(s, ['README.md'])).toEqual({ ok: true, why: 'turn open' });
  });
  it('a closed read-only turn beside a stranger\'s file is refused, with the reason', () => {
    const s = { activeTurn: null, completedPromptMappings: [{ promptIndex: 0, filesChanged: [] }] } as any;
    expect(loneSessionMayOwnCommit(s, ['README.md']).ok).toBe(false);
  });
});

describe('runningTurnTouchedCommit', () => {
  // Cursor c1e361a4: prompt 10 running, after-file-edit mapped its edits by
  // index without opening the turn, the commit landed with "(no active turn)".
  const st = { completedPromptMappings: [{ promptIndex: 9, filesChanged: ['old.ts'] }, { promptIndex: 10, filesChanged: ['apps/api/src/utils/commit-attribution.ts'] }] };
  it('is true when the running prompt\'s own mapping holds a committed file', () => {
    expect(runningTurnTouchedCommit(st, 10, ['apps/api/src/utils/commit-attribution.ts', 'apps/api/src/routes/sessions.ts'])).toBe(true);
  });
  it('is false when only an earlier, closed turn touched them', () => {
    expect(runningTurnTouchedCommit(st, 10, ['old.ts'])).toBe(false);
  });
  it('is false with nothing recorded for the running prompt', () => {
    expect(runningTurnTouchedCommit({ completedPromptMappings: [] }, 3, ['x.ts'])).toBe(false);
  });
});
