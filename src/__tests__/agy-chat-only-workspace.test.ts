/**
 * A chat-only Antigravity turn must still register a session.
 *
 * Found live. Conversation e433489f answered "generate some fucking code" with
 * a question about which language, ran zero tools, and never appeared in
 * Origin at all — not an empty session, no session. `~/.origin/hooks.log`:
 *
 *   [transcript-watch] skipped: no cwd for session
 *     {"agent":"antigravity","sessionId":"e433489f-…",
 *      "hint":"transcript records no cwd and no absolute file paths to recover one from"}
 *
 * agy's transcript names no cwd, so the repo is recovered from the absolute
 * paths in its tool calls. A turn that edits nothing leaks no path, so the
 * recovery had nothing to work with — and a clarifying question, a refusal or
 * an unapproved plan is an ordinary turn, not a broken one.
 *
 * The workspace was knowable the whole time: agy runs each conversation in its
 * own worktree at <root>/worktrees/<project>/<branch> and names that path in
 * <root>/conversations/<conversationId>.db.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { __resetLoggedSkips } from '../debug-log.js';
import { reconcileSession, loadSessionState, saveSessionState, type WatchDeps, type SessionWatchState } from '../transcript-watch.js';
import {
  antigravityWorkspaceForConversation,
  type TranscriptAdapter,
  type ScannedTranscript,
  type ParsedSession,
} from '../transcript-adapters.js';

describe('antigravityWorkspaceForConversation', () => {
  let root = '';

  beforeEach(() => {
    root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-')), 'antigravity');
    fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(path.dirname(root), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const worktree = (project: string, branch: string): string => {
    const p = path.join(root, 'worktrees', project, branch);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  // The store is SQLite; what matters here is only that the path appears
  // somewhere in the bytes, surrounded by binary noise.
  const writeDb = (id: string, ...mentions: string[]): void => {
    const noise = Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0x03, 0xff, 0xfe]);
    fs.writeFileSync(
      path.join(root, 'conversations', `${id}.db`),
      Buffer.concat([noise, Buffer.from(mentions.join('\u0000'), 'latin1'), noise]),
    );
  };

  it('finds the worktree the conversation store names', () => {
    const wt = worktree('kotleta', 'spontaneous_code_generation_task');
    writeDb('conv-1', wt);
    expect(antigravityWorkspaceForConversation('conv-1', [root])).toBe(wt);
  });

  it('matches the JSON-escaped and file:// spellings of the same path', () => {
    // The blob carries the same path three ways; any one of them is the answer.
    const wt = worktree('kotleta', 'refine_personal_coding_style');
    writeDb('escaped', wt.replace(/\\/g, '\\\\'));
    writeDb('fileurl', `file:///${wt.replace(/\\/g, '/')}`);
    expect(antigravityWorkspaceForConversation('escaped', [root])).toBe(wt);
    expect(antigravityWorkspaceForConversation('fileurl', [root])).toBe(wt);
  });

  it('prefers the most specific worktree when one path prefixes another', () => {
    const shorter = worktree('kotleta', 'fix');
    const longer = worktree('kotleta', 'fix_the_parser');
    writeDb('conv-2', longer);
    // `…/fix` is a substring of `…/fix_the_parser`, so both match the blob.
    expect(shorter.length).toBeLessThan(longer.length);
    expect(antigravityWorkspaceForConversation('conv-2', [root])).toBe(longer);
  });

  it('returns null when the workspace is not one of agy\'s worktrees', () => {
    // A plain folder opened in the IDE keeps today's behaviour rather than
    // guessing at some unrelated worktree.
    worktree('kotleta', 'unrelated_branch');
    writeDb('conv-3', 'C:\\soft\\some-other-project');
    expect(antigravityWorkspaceForConversation('conv-3', [root])).toBeNull();
  });

  it('returns null when the conversation has no store at all', () => {
    worktree('kotleta', 'a_branch');
    expect(antigravityWorkspaceForConversation('missing', [root])).toBeNull();
  });

  it('ignores a worktree whose directory no longer exists', () => {
    // A stale path in an old store must not resurrect a deleted worktree.
    const wt = path.join(root, 'worktrees', 'kotleta', 'deleted_branch');
    worktree('kotleta', 'still_here');
    writeDb('conv-4', wt);
    expect(antigravityWorkspaceForConversation('conv-4', [root])).toBeNull();
  });
});

describe('reconcileSession consults the adapter fallback last', () => {
  let tmp = '';
  let stateDir = '';

  beforeEach(() => {
    __resetLoggedSkips();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fallback-'));
    stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function adapter(over: Partial<TranscriptAdapter> = {}, filePaths: string[] = []): TranscriptAdapter {
    const parsed: ParsedSession = {
      userPrompts: ['generate some fucking code'], promptTimestamps: [1000], transcript: 't', model: 'm',
      tokensUsed: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      filePaths, filesChanged: [], promptDiffs: [],
    };
    return {
      slug: 'antigravity', agentSlugForServer: 'antigravity',
      listActive: () => [], parse: () => parsed,
      ...over,
    };
  }

  function deps(over: Partial<WatchDeps> = {}): WatchDeps {
    return {
      now: () => Date.now(), idleMs: 20 * 60_000, machineId: 'm', hostname: 'h', stateDir,
      api: { startSession: vi.fn(), updateSession: vi.fn() } as any,
      resolveRepo: () => null,
      createShadow: () => null, getHead: () => null,
      captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
      captureGit: () => ({ headBefore: '', headAfter: '', commitShas: [], commitDetails: [], diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0 }),
      loadState: (a: string, s: string) => loadSessionState(a, s, stateDir),
      saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
      ...over,
    };
  }

  const scanned = (): ScannedTranscript =>
    ({ sessionId: 'e433489f', transcriptPath: '/x', cwd: null, mtimeMs: Date.now() });

  it('a chat-only turn reaches repo resolution instead of being skipped', async () => {
    const fallbackCwd = vi.fn(() => '/agy/worktrees/kotleta/spontaneous_code_generation_task');
    const resolveRepo = vi.fn(() => null);

    await reconcileSession(scanned(), adapter({ fallbackCwd }), deps({ resolveRepo }));

    expect(fallbackCwd).toHaveBeenCalled();
    // The old code returned before this call — that was the whole defect.
    expect(resolveRepo).toHaveBeenCalledWith('/agy/worktrees/kotleta/spontaneous_code_generation_task');
  });

  it('does not consult the fallback when the touched files already name a repo', async () => {
    // agy's own idea of its workspace is the least reliable source; evidence of
    // where the work landed must win.
    const repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    const touched = path.join(repo, 'app.py');
    fs.writeFileSync(touched, 'x');
    const fallbackCwd = vi.fn(() => '/agy/worktrees/kotleta/somewhere_else');
    const resolveRepo = vi.fn((_cwd: string) => null);

    await reconcileSession(scanned(), adapter({ fallbackCwd }, [touched]), deps({ resolveRepo }));

    expect(fallbackCwd).not.toHaveBeenCalled();
    expect(resolveRepo).toHaveBeenCalledTimes(1);
    // git's toplevel may differ from the temp path by symlink resolution, so
    // match on the directory name rather than the literal string.
    expect(String(resolveRepo.mock.calls[0][0])).toContain(path.basename(repo));
  });

  it('still skips, and says so, when the fallback resolves nothing either', async () => {
    const lines: string[] = [];
    vi.spyOn(fs, 'appendFileSync').mockImplementation(((_p: any, data: any) => { lines.push(String(data)); }) as any);

    await reconcileSession(scanned(), adapter({ fallbackCwd: () => null }), deps());

    expect(lines.join('')).toContain('skipped: no cwd for session');
  });
});
