// The durable mirror is the last-resort lookup, and the Cursor lookup falls
// through on an id mismatch. Together they let a mirror row for ANOTHER chat
// win the agent-filtered match. Prod 2026-09-09: the real chat's row
// (e24477e2, worktree, chat da82f522) was idle-reaped — ENDED, so invisible
// to the git scan. Its next file edits and Stop fell to the mirror, where the
// archived twin's leftover RUNNING mirror (5431ff0f, composer id f9213cfd,
// six copied prompts, main checkout) won on recency. The Stop then PATCHed
// the archived row back to life with the chat's turn on it.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { findStateForHook, mirrorRowAdoptableForChat } from '../commands/hooks.js';

const CHAT = 'da82f522-f0ad-4837-92ed-fb09dbf80390';
const COMPOSER = 'f9213cfd-3494-476f-9249-b18716835b7a';
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf-8' }).trim();

describe('mirrorRowAdoptableForChat', () => {
  const now = Date.parse('2026-09-09T05:41:53Z');
  it('a row that names this chat is adoptable, ended or not', () => {
    expect(mirrorRowAdoptableForChat({ agentSessionId: CHAT, prompts: ['a', 'b'] }, CHAT, now)).toBe(true);
    expect(mirrorRowAdoptableForChat({ claudeSessionId: CHAT }, CHAT, now)).toBe(true);
  });
  it('a row that names no chat is adoptable (older auto-create rows)', () => {
    expect(mirrorRowAdoptableForChat({ prompts: ['a'] }, CHAT, now)).toBe(true);
  });
  it('a row that names ANOTHER chat and has prompts is another conversation', () => {
    expect(mirrorRowAdoptableForChat({ agentSessionId: COMPOSER, prompts: ['a'], startedAt: new Date(now - 10_000).toISOString() }, CHAT, now)).toBe(false);
  });
  it('the empty, young main-checkout handshake (worktree bootstrap) is still adoptable', () => {
    expect(mirrorRowAdoptableForChat({ agentSessionId: COMPOSER, prompts: [], startedAt: new Date(now - 30_000).toISOString() }, CHAT, now)).toBe(true);
    // ...but not once it is old enough to be a stale handshake.
    expect(mirrorRowAdoptableForChat({ agentSessionId: COMPOSER, prompts: [], startedAt: new Date(now - 3 * 60_000).toISOString() }, CHAT, now)).toBe(false);
  });
  it('no incoming id means no opinion', () => {
    expect(mirrorRowAdoptableForChat({ agentSessionId: COMPOSER, prompts: ['a'] }, '', now)).toBe(true);
  });
});

describe('findStateForHook: the mirror never hands a Cursor hook another chat\'s row', () => {
  let main = '';
  let wt = '';
  const mirrorDir = () => path.join(os.homedir(), '.origin', 'sessions');

  function mirrorRow(id: string, over: Record<string, unknown>): void {
    fs.mkdirSync(mirrorDir(), { recursive: true });
    fs.writeFileSync(path.join(mirrorDir(), `${id.slice(0, 12)}.json`), JSON.stringify({
      sessionId: id, sessionTag: 'f9213cfd-349', claudeSessionId: '', model: 'cursor-grok-4.6-high', agentSlug: 'cursor',
      repoPath: main, canonicalRepoPath: main, lastCwd: main, branch: 'main',
      startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), prompts: [], status: 'RUNNING', ...over,
    }));
  }

  beforeEach(() => {
    fs.rmSync(mirrorDir(), { recursive: true, force: true });
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mirror-chat-')));
    main = path.join(root, 'main');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.email', 't@t.t'); git(main, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
    git(main, 'add', '-A'); git(main, 'commit', '-qm', 'base');
    wt = path.join(root, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'cursor/f9213cfd', wt);
  });

  it('skips the archived twin\'s RUNNING mirror (composer id, prompts) — no state, so the archive resume can run', () => {
    mirrorRow('5431ff0f-8785-49ed-b958-71d6be37ad23', { agentSessionId: COMPOSER, prompts: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] });
    // The real chat's row is ENDED (idle-reaped): not a live candidate anywhere.
    mirrorRow('e24477e2-693f-400c-9047-99c1ae901597', {
      agentSessionId: CHAT, repoPath: wt, lastCwd: wt, branch: 'cursor/f9213cfd', prompts: ['p0', 'p1'],
      status: 'ENDED', endedAt: new Date().toISOString(),
    });
    expect(findStateForHook(wt, CHAT, 'cursor')).toBeNull();
  });

  it('still adopts the empty main-checkout handshake from the mirror (the worktree bootstrap)', () => {
    mirrorRow('5431ff0f-8785-49ed-b958-71d6be37ad23', { agentSessionId: COMPOSER, prompts: [], startedAt: new Date(Date.now() - 20_000).toISOString() });
    expect(findStateForHook(wt, CHAT, 'cursor')?.state.sessionId).toBe('5431ff0f-8785-49ed-b958-71d6be37ad23');
  });

  it('still finds this chat\'s own live row in the mirror', () => {
    mirrorRow('e24477e2-693f-400c-9047-99c1ae901597', { agentSessionId: CHAT, repoPath: wt, lastCwd: wt, prompts: ['p0'] });
    expect(findStateForHook(wt, CHAT, 'cursor')?.state.sessionId).toBe('e24477e2-693f-400c-9047-99c1ae901597');
  });
});
