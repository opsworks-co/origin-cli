import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handlePrepareCommitMsg } from '../commands/hooks.js';
import { pickEndedSessionByContent } from '../ended-session-commit-owner.js';

/**
 * A person commits by hand what a session left uncommitted when it ENDED.
 * Prod 9be790796 (#2175): session 771d17ae rewrote a line of DOCS.md, ended at
 * 17:06, and the line was committed by hand at 17:25 — with no trailer, because
 * every commit-time rule looked only at sessions still running. The commit now
 * gets the ended session's trailer, but only when its own recorded lines are in
 * the staged patch: file names, recency and being the only candidate are not
 * evidence, because an ended session is exactly what the liveness filter keeps
 * away from commits.
 */
const ENDED = 'e1d17ae0-0000-4000-8000-000000000001';
const OTHER = 'e2d17ae0-0000-4000-8000-000000000002';
const LINE = '- On the hosting server, old note versions can stay readable by a party that has repository/object access.';
const OLD = '- On the hosting server, old note versions can stay readable by anyone who knows their object ID.';
let repo: string;
const origCwd = process.cwd();

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const patchOf = (file: string, minus: string[], plus: string[]) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${minus.length} +1,${plus.length} @@\n`
  + [...minus.map((l) => '-' + l), ...plus.map((l) => '+' + l)].join('\n') + '\n';

function writeEndedSession(sessionId: string, opts: {
  tree?: string; endedAgoMs?: number; mappings?: Array<{ promptIndex: number; uncommittedDiff?: string; filesChanged?: string[] }>;
} = {}) {
  const endedAt = new Date(Date.now() - (opts.endedAgoMs ?? 19 * 60_000)).toISOString();
  const state = {
    sessionId, sessionTag: sessionId.slice(0, 8), agentSlug: 'claude-code', model: 'claude-opus-5',
    repoPath: opts.tree ?? repo, lastCwd: opts.tree ?? repo,
    startedAt: new Date(Date.now() - 60 * 60_000).toISOString(), status: 'ENDED', endedAt,
    prompts: ['read the review', 'make the one wording fix'],
    completedPromptMappings: (opts.mappings ?? [
      { promptIndex: 0, filesChanged: [] },
      { promptIndex: 1, filesChanged: ['DOCS.md'], uncommittedDiff: patchOf('DOCS.md', [OLD], [LINE]) },
    ]).map((m) => ({ promptText: '', diff: '', filesChanged: [], ...m })),
  };
  const dir = path.join(os.homedir(), '.origin', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId.slice(0, 12)}.json`);
  fs.writeFileSync(file, JSON.stringify(state));
  if (opts.endedAgoMs) { const t = new Date(endedAt); fs.utimesSync(file, t, t); }
}

async function commitMessageAfterHook(): Promise<string> {
  const msgFile = path.join(repo, '.git', 'COMMIT_EDITMSG');
  fs.writeFileSync(msgFile, 'docs: wording\n');
  await handlePrepareCommitMsg(msgFile, 'message');
  return fs.readFileSync(msgFile, 'utf-8');
}

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.origin', 'sessions'), { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.origin', 'manual-session-ends'), { recursive: true, force: true });
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ended-work-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'DOCS.md'), OLD + '\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  process.chdir(repo);
});
afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('a hand commit of an ended session\'s uncommitted work', () => {
  it('carries the ended session\'s trailer, naming the turn whose lines are committed', async () => {
    writeEndedSession(ENDED);
    fs.writeFileSync(path.join(repo, 'DOCS.md'), LINE + '\n');
    git('add', 'DOCS.md');
    expect(await commitMessageAfterHook()).toContain(`Origin-Session: ${ENDED.slice(0, 12)} | Claude Code | 2 prompts | turn 2`);
  });

  it('gets no trailer when the session only touched the same file', async () => {
    writeEndedSession(ENDED);
    fs.writeFileSync(path.join(repo, 'DOCS.md'), '- Something the person wrote themselves about note retention.\n');
    git('add', 'DOCS.md');
    expect(await commitMessageAfterHook()).not.toContain('Origin-Session');
  });

  it('gets no trailer when two ended sessions recorded the same lines', async () => {
    writeEndedSession(ENDED);
    writeEndedSession(OTHER);
    fs.writeFileSync(path.join(repo, 'DOCS.md'), LINE + '\n');
    git('add', 'DOCS.md');
    expect(await commitMessageAfterHook()).not.toContain('Origin-Session');
  });

  it('ignores a session that ended outside the 14-day lookback', async () => {
    writeEndedSession(ENDED, { endedAgoMs: 15 * 24 * 60 * 60_000 });
    fs.writeFileSync(path.join(repo, 'DOCS.md'), LINE + '\n');
    git('add', 'DOCS.md');
    expect(await commitMessageAfterHook()).not.toContain('Origin-Session');
  });

  it('ignores a session that worked in another tree', async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ended-work-other-')));
    try {
      writeEndedSession(ENDED, { tree: elsewhere });
      fs.writeFileSync(path.join(repo, 'DOCS.md'), LINE + '\n');
      git('add', 'DOCS.md');
      expect(await commitMessageAfterHook()).not.toContain('Origin-Session');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('leaves the commit to a live session that touched a staged file', async () => {
    writeEndedSession(ENDED);
    const live = {
      sessionId: 'f00d0000-0000-4000-8000-000000000003', sessionTag: 'live', agentSlug: 'codex', model: 'gpt-5',
      repoPath: repo, lastCwd: repo, startedAt: new Date().toISOString(), prompts: ['p'],
      completedPromptMappings: [{ promptIndex: 0, promptText: 'p', filesChanged: ['DOCS.md'], diff: '' }],
    };
    fs.writeFileSync(path.join(repo, '.git', 'origin-session-live.json'), JSON.stringify(live));
    fs.writeFileSync(path.join(repo, 'DOCS.md'), LINE + '\n');
    git('add', 'DOCS.md');
    expect(await commitMessageAfterHook()).not.toContain(`Origin-Session: ${ENDED.slice(0, 12)}`);
  });
});

describe('pickEndedSessionByContent', () => {
  const session = (id: string, plus: string[]) => ({
    sessionId: id, startedAt: '', prompts: [],
    completedPromptMappings: [{ promptIndex: 0, promptText: '', filesChanged: ['a.ts'], diff: '', uncommittedDiff: patchOf('a.ts', [], plus) }],
  }) as any;

  it('does not count a line the patch both adds and removes — it existed before', () => {
    const moved = 'export function scrubNoteBody(body: string): string {';
    expect(pickEndedSessionByContent([session(ENDED, [moved])], patchOf('a.ts', [moved], [moved]))).toBeNull();
  });

  it('does not count structure shared by every file', () => {
    expect(pickEndedSessionByContent([session(ENDED, ['});', '```bash'])], patchOf('a.ts', [], ['});', '```bash']))).toBeNull();
  });

  it('the session holding more of the patch wins', () => {
    const a = 'const alphaValue = computeAlpha(input);';
    const b = 'const betaValue = computeBeta(input);';
    const owner = pickEndedSessionByContent(
      [session(ENDED, [a, b]), session(OTHER, [a])],
      patchOf('a.ts', [], [a, b]),
    );
    expect(owner?.state.sessionId).toBe(ENDED);
    expect(owner?.matchedLines).toBe(2);
  });
});
