// Commit attribution: pick the session that ACTUALLY produced the staged files,
// and never credit a zombie (never-ended, idle) session. Regression for the
// "Antigravity commit shown as Cursor" bug — a stale Cursor session was being
// stamped onto a commit made by a different, live agent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pickActiveSessionForCommit, buildOriginTrailers, agyDetectSessionCommit } from '../commands/hooks.js';
import { createShadowCommit } from '../git-capture.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('commit attribution by staged-file overlap + staleness', () => {
  let dir: string;

  function writeSession(tag: string, state: Record<string, any>) {
    const f = path.join(dir, '.git', `origin-session-${tag}.json`);
    fs.writeFileSync(f, JSON.stringify({ sessionTag: tag, status: 'RUNNING', ...state }));
    return f;
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-attr-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@o.dev');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'seed');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('attributes the commit to the session whose changes match the staged files', () => {
    const base = git(dir, 'rev-parse', 'HEAD');
    // Session AGY edited a.txt; session CURSOR edited b.txt — both live.
    fs.appendFileSync(path.join(dir, 'a.txt'), 'agy edit\n');
    fs.appendFileSync(path.join(dir, 'b.txt'), 'cursor edit\n');
    // Each session records the files IT touched (as the real captures do).
    writeSession('agy-conv1', { sessionId: 'agy-1111', agentSlug: 'antigravity', model: 'gemini-3.5-flash', repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-23T10:00:00Z', completedPromptMappings: [{ promptIndex: 0, promptText: 'p', filesChanged: ['a.txt'] }] });
    writeSession('cur-conv2', { sessionId: 'cur-2222', agentSlug: 'cursor', model: 'composer-2.5-fast', repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-23T10:05:00Z', completedPromptMappings: [{ promptIndex: 0, promptText: 'p', filesChanged: ['b.txt'] }] });

    // Stage ONLY a.txt (the agy-made file).
    git(dir, 'add', 'a.txt');
    const picked = pickActiveSessionForCommit(dir);
    expect(picked?.sessionId).toBe('agy-1111'); // matched by file overlap, not recency
  });

  it('ignores a never-ended zombie session (stale state file)', () => {
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'edit\n');
    const zombie = writeSession('zombie', { sessionId: 'zzz-0000', agentSlug: 'cursor', model: 'composer-2.5-fast', repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-18T00:00:00Z' });
    // Age the zombie's state file well past the 3h staleness cutoff.
    const old = (Date.now() - 5 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(zombie, old, old);

    git(dir, 'add', 'a.txt');
    // Only candidate is stale → no unambiguous live session → null (no wrong
    // attribution) rather than crediting the zombie.
    expect(pickActiveSessionForCommit(dir)).toBeNull();
    // ...and the zombie is auto-closed on disk (marked ENDED), not just ignored.
    const after = JSON.parse(fs.readFileSync(zombie, 'utf-8'));
    expect(after.status).toBe('ENDED');
    expect(after.endedAt).toBeTruthy();
  });

  it('labels an Antigravity session "Antigravity", not "Gemini CLI"', () => {
    const trailers = buildOriginTrailers('abc123def456', 'gemini-3.5-flash', 2, null, 'antigravity');
    expect(trailers[0]).toBe('Origin-Session: abc123def456 | Antigravity | 2 prompts');
  });

  it('detects a commit the agy session made since its baseline (committed turn)', () => {
    // Pre-existing dirt at session start, captured by the baseline shadow.
    fs.appendFileSync(path.join(dir, 'a.txt'), 'pre-existing\n');
    const baseline = createShadowCommit(dir, 'agy-start');
    expect(baseline).toBeTruthy();

    // Before any commit: no session commit detected.
    expect(agyDetectSessionCommit(dir, baseline!).commitSha).toBeUndefined();

    // The agent edits + commits everything → working tree clean.
    fs.appendFileSync(path.join(dir, 'a.txt'), 'agy work\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'agy commit');
    const head = git(dir, 'rev-parse', 'HEAD');

    const res = agyDetectSessionCommit(dir, baseline!);
    expect(res.commitSha).toBe(head);
    expect(res.treeClean).toBe(true); // everything committed → turn shows "committed"
  });
});

// Prod vodka, commit 2c82b8a: the live Claude session was mid-turn with the
// committed files in its ledger; a re-opened Claude conversation with no
// prompt claimed the same files through the working-tree fallback; the two
// tied, the tie went to process detection over the WHOLE pool, and a Codex
// zombie from seven hours earlier — half the overlap, but a Codex process was
// running — got the trailer. The commit then rendered as somebody else's and
// the real session's turn as "uncommitted".
describe('commit attribution — the turn that is running wins', () => {
  let dir: string;
  function writeSession(tag: string, state: Record<string, any>) {
    const f = path.join(dir, '.git', `origin-session-${tag}.json`);
    fs.writeFileSync(f, JSON.stringify({ sessionTag: tag, status: 'RUNNING', ...state }));
    return f;
  }
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-attr2-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@o.dev');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'seed');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('a session mid-turn with the staged files in its ledger beats every completed mapping', () => {
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'live edit\n');
    fs.appendFileSync(path.join(dir, 'b.txt'), 'live edit\n');
    // The zombie touched both files a day ago, in completed turns.
    writeSession('zombie', { sessionId: 'codex-0000', agentSlug: 'codex', model: 'gpt-5', repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-22T10:00:00Z', prompts: ['x', 'y'], completedPromptMappings: [{ promptIndex: 0, filesChanged: ['a.txt', 'b.txt'] }] });
    // The live session is in turn 2, whose ledger holds the two writes; its
    // completed mapping names only a.txt.
    writeSession('live', { sessionId: 'claude-1111', agentSlug: 'claude-code', model: 'claude', repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-23T10:05:00Z', prompts: ['p1', 'p2'], completedPromptMappings: [{ promptIndex: 0, filesChanged: ['a.txt'] }], activeTurn: { index: 1, turnId: 't_live', promptText: 'p2', openedAt: '2026-06-23T10:06:00Z' }, liveEdits: [{ promptIndex: 1, toolName: '__shell_probe__', edits: [{ file: 'a.txt' }, { file: 'b.txt' }] }] });
    git(dir, 'add', 'a.txt', 'b.txt');
    expect(pickActiveSessionForCommit(dir)?.sessionId).toBe('claude-1111');
  });

  it('a re-opened conversation with no prompt claims no files', () => {
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'edit\n');
    const shadow = createShadowCommit(dir, 'ghost-start');
    writeSession('ghost', { sessionId: 'claude-ghost', agentSlug: 'claude-code', model: 'claude', repoPath: dir, lastCwd: dir, headShaAtStart: base, sessionStartShadowSha: shadow, startedAt: '2026-06-23T10:05:09Z', prompts: [] });
    writeSession('real', { sessionId: 'claude-real', agentSlug: 'claude-code', model: 'claude', repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-23T10:05:00Z', prompts: ['p1'], completedPromptMappings: [{ promptIndex: 0, filesChanged: ['a.txt'] }] });
    fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
    git(dir, 'add', 'a.txt');
    expect(pickActiveSessionForCommit(dir)?.sessionId).toBe('claude-real');
  });

  it('a tie is broken among the tied, never by a session with less overlap', () => {
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'edit\n');
    fs.appendFileSync(path.join(dir, 'b.txt'), 'edit\n');
    // Two sessions tie on both files; a third — whatever agent process may be
    // running on this machine — has only one. The third must never win.
    writeSession('one', { sessionId: 'tie-1', agentSlug: 'cursor', model: 'composer', repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-23T10:00:00Z', lastStopAt: '2026-06-23T10:01:00Z', prompts: ['p'], completedPromptMappings: [{ promptIndex: 0, filesChanged: ['a.txt', 'b.txt'] }] });
    writeSession('two', { sessionId: 'tie-2', agentSlug: 'cursor', model: 'composer', repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-23T10:00:00Z', lastStopAt: '2026-06-23T10:01:00Z', prompts: ['p'], completedPromptMappings: [{ promptIndex: 0, filesChanged: ['a.txt', 'b.txt'] }] });
    for (const slug of ['codex', 'claude-code', 'antigravity', 'gemini', 'devin', 'copilot']) {
      writeSession(`half-${slug}`, { sessionId: `half-${slug}`, agentSlug: slug, model: slug, repoPath: dir, lastCwd: dir, headShaAtStart: base, startedAt: '2026-06-23T10:00:00Z', prompts: ['p'], completedPromptMappings: [{ promptIndex: 0, filesChanged: ['a.txt'] }] });
    }
    git(dir, 'add', 'a.txt', 'b.txt');
    const picked = pickActiveSessionForCommit(dir);
    expect(picked === null || picked.sessionId.startsWith('tie-')).toBe(true);
  });
});
