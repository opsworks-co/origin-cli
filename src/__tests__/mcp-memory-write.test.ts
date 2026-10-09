// The MCP write tools — add_todo, close_todo, record_decision — against a real
// git repo, read back through the same readers the marker path feeds:
// `origin todo list` (getOpenTodos), get_repo_memory and search_history.
//
// The property that matters for close_todo is the one `[Origin: Closes]` has:
// an agent's claim is PENDING until the work is on the default branch, and a
// reference that does not pin down one TODO closes nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSessionMemoryEntry, readTodoClosures, todoClosureKey, writeSessionMemory } from '../memory.js';
import { getOpenTodos } from '../todo.js';
import { getRepoMemory } from '../mcp/repo-memory.js';
import { searchHistory } from '../history-search.js';
import { addTodoTool, closeTodoTool, recordDecisionTool, resolveCaptureSession } from '../mcp/memory-write.js';

const SID = 'a1b2c3d4-0000-1111-2222-333344445555';
const NO_ENV = {} as NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

let repo: string;
let home: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

function commit(file: string, msg: string): string {
  fs.writeFileSync(path.join(repo, file), `${msg}\n`);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A live capture session for this repo, as the hooks leave one in .git. */
function liveSession(sessionId = SID, tag = 'claude-code-x', extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify({
    sessionId, sessionTag: tag, repoPath: repo, lastCwd: repo, agentSlug: 'claude-code', model: 'claude-opus',
    startedAt: new Date().toISOString(), prompts: ['make the memory tools writable'], claudeSessionId: `agent-${tag}`,
    ...extra,
  }));
}

beforeEach(() => {
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mcp-write-home-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mcp-write-')));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  // The developer's own globally-installed Origin hooks would annotate these
  // fixture commits mid-test.
  git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  commit('a.txt', 'init');
});

afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedProfile;
  for (const d of [repo, home]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('add_todo', () => {
  it('records a TODO that `origin todo list` and get_repo_memory readers see', () => {
    const r: any = addTodoTool({ text: '  re-measure the stop hook after the deploy  ', repo_path: repo });
    expect(r.error).toBeUndefined();
    expect(r.existing).toBe(false);
    expect(r.text).toBe('re-measure the stop hook after the deploy');
    const open = getOpenTodos(repo).filter((t) => t.text === r.text);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(r.id);
    expect(searchHistory(repo, 're-measure stop hook', { kinds: ['todo'] }).hits[0]?.todoId).toBe(r.id);
  });

  it('returns an existing open TODO with the same text instead of adding a duplicate', () => {
    const first: any = addTodoTool({ text: 'Verify the archive on prod', repo_path: repo });
    const again: any = addTodoTool({ text: 'verify   the archive on PROD', repo_path: repo });
    expect(again.existing).toBe(true);
    expect(again.id).toBe(first.id);
    expect(getOpenTodos(repo).filter((t) => todoClosureKey(t.text) === todoClosureKey(first.text))).toHaveLength(1);
  });

  it('dedupes against a session-mined TODO in the memory note too', () => {
    writeSessionMemory(repo, {
      sessionId: 'older-session-0001', agentSlug: 'codex', model: 'gpt', startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T01:00:00.000Z', branch: 'main', summary: 'work', filesChanged: ['a.txt'],
      promptCount: 1, linesAdded: 1, linesRemoved: 0, openTodos: ['the shadow refs are never deleted'],
    });
    const r: any = addTodoTool({ text: 'The shadow refs are never deleted', repo_path: repo });
    expect(r.existing).toBe(true);
    expect(r.text).toBe('the shadow refs are never deleted');
  });

  it('refuses empty, over-long, and non-repo input with an error, never a throw', () => {
    expect((addTodoTool({ text: '   ', repo_path: repo }) as any).error).toMatch(/required/);
    expect((addTodoTool({ text: 'x'.repeat(501), repo_path: repo }) as any).error).toMatch(/500/);
    const plain = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mcp-write-plain-')));
    try {
      expect((addTodoTool({ text: 'anything', repo_path: plain }) as any).error).toMatch(/not a git repository/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('close_todo', () => {
  const TODO = 'the GitHub App detect route still links an unclaimed installation';

  it('records a PENDING claim under the live capture session — nothing closes on the claim alone', () => {
    liveSession();
    const { id } = addTodoTool({ text: TODO, repo_path: repo }) as any;
    git(repo, 'checkout', '-qb', 'fix/detect');
    const sha = commit('b.txt', 'fix detect');

    const r: any = closeTodoTool({ todo: id, reason: 'detect now checks the login owns it', commit_sha: sha, repo_path: repo }, NO_ENV);
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ id, text: TODO, state: 'pending' });
    const c = readTodoClosures(repo).find((x) => x.key === todoClosureKey(TODO))!;
    expect(c.state).toBe('pending');
    expect(c.sessionId).toBe(SID);
    expect(c.shas).toEqual([sha]);
    expect(c.reason).toBe('detect now checks the login owns it');
    // Still listed: an unmerged fix is a claim.
    expect(getOpenTodos(repo).some((t) => t.text === TODO)).toBe(true);
  });

  it('confirms at once when the commit is already on the default branch', () => {
    const { id } = addTodoTool({ text: TODO, repo_path: repo }) as any;
    const sha = commit('b.txt', 'fix detect on main');
    // No live session: a sha alone can confirm, so it is not refused.
    const r: any = closeTodoTool({ todo: TODO, reason: 'fixed on main', commit_sha: sha, repo_path: repo }, NO_ENV);
    expect(r).toMatchObject({ id, state: 'closed' });
    expect(getOpenTodos(repo).some((t) => t.text === TODO)).toBe(false);
  });

  it('a pending claim confirms once its branch merges', () => {
    liveSession();
    addTodoTool({ text: TODO, repo_path: repo });
    git(repo, 'checkout', '-qb', 'fix/detect');
    const sha = commit('b.txt', 'fix detect');
    expect((closeTodoTool({ todo: TODO, reason: 'done', commit_sha: sha, repo_path: repo }, NO_ENV) as any).state).toBe('pending');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--ff-only', 'fix/detect');
    const again: any = closeTodoTool({ todo: TODO, reason: 'done', commit_sha: sha, repo_path: repo }, NO_ENV);
    // Already claimed — the first claim is kept — and the sweep that runs with
    // it sees the merge.
    expect(again).toMatchObject({ state: 'closed', alreadyClaimed: true });
    expect(readTodoClosures(repo).find((c) => c.key === todoClosureKey(TODO))!.state).toBe('closed');
    expect(getOpenTodos(repo).some((t) => t.text === TODO)).toBe(false);
  });

  it('an ambiguous reference closes nothing and lists candidates', () => {
    liveSession();
    addTodoTool({ text: 'verify the light-mode heatmap on the signed-in dashboard', repo_path: repo });
    addTodoTool({ text: 'verify the light-mode modals on the signed-in dashboard', repo_path: repo });
    const r: any = closeTodoTool({ todo: 'verify the light-mode', reason: 'checked', repo_path: repo }, NO_ENV);
    expect(r.error).toMatch(/matches no single open TODO/);
    expect(r.candidates.map((c: any) => c.text).sort()).toEqual([
      'verify the light-mode heatmap on the signed-in dashboard',
      'verify the light-mode modals on the signed-in dashboard',
    ]);
    expect(readTodoClosures(repo)).toEqual([]);
  });

  it('without a commit sha, refuses when the session cannot be identified', () => {
    addTodoTool({ text: TODO, repo_path: repo });
    expect((closeTodoTool({ todo: TODO, reason: 'done', repo_path: repo }, NO_ENV) as any).error).toMatch(/no live Origin session/);
    liveSession(SID, 'one');
    liveSession('ffff0000-9999-8888-7777-666655554444', 'two');
    expect((closeTodoTool({ todo: TODO, reason: 'done', repo_path: repo }, NO_ENV) as any).error).toMatch(/2 live Origin sessions/);
    expect(readTodoClosures(repo)).toEqual([]);
  });

  it('requires a reason and rejects a sha the repo does not have', () => {
    liveSession();
    addTodoTool({ text: TODO, repo_path: repo });
    expect((closeTodoTool({ todo: TODO, reason: ' ', repo_path: repo }, NO_ENV) as any).error).toMatch(/reason is required/);
    expect((closeTodoTool({ todo: TODO, reason: 'x', commit_sha: 'deadbeef', repo_path: repo }, NO_ENV) as any).error).toMatch(/not a commit/);
  });
});

describe('get_repo_memory sees what the write tools record', () => {
  const TODO = 'the GitHub App install callback does not prove org admin';

  it('add_todo → listed; close_todo → pending; merged → gone', () => {
    liveSession();
    const { id } = addTodoTool({ text: TODO, repo_path: repo }) as any;

    // No session entries at all: the TODO alone is memory.
    let mem = getRepoMemory({ repoPath: repo, includeDetail: true });
    expect(mem.note).toBeUndefined();
    expect(mem.openTodoCount).toBe(1);
    expect(mem.openTodos).toEqual([{ id, text: TODO, source: 'manual' }]);
    // The digest carries the count, not the list.
    expect(getRepoMemory({ repoPath: repo }).openTodos).toBeUndefined();

    git(repo, 'checkout', '-qb', 'fix/callback');
    const sha = commit('c.txt', 'prove admin');
    expect((closeTodoTool({ todo: id, reason: 'callback checks admin', commit_sha: sha, repo_path: repo }, NO_ENV) as any).state).toBe('pending');
    mem = getRepoMemory({ repoPath: repo, includeDetail: true });
    expect(mem.openTodoCount).toBe(1);
    expect(mem.openTodos![0]).toMatchObject({ id, pending: { reason: 'callback checks admin' } });

    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--ff-only', 'fix/callback');
    // Confirmation is the sweep's job (todo list / the next close_todo run it).
    expect((closeTodoTool({ todo: id, reason: 'callback checks admin', commit_sha: sha, repo_path: repo }, NO_ENV) as any).state).toBe('closed');
    mem = getRepoMemory({ repoPath: repo, includeDetail: true });
    expect(mem.openTodoCount).toBe(0);
    expect(mem.openTodos).toEqual([]);
  });
});

describe('record_decision', () => {
  it('lands on the current session entry and is visible to get_repo_memory and search_history', () => {
    liveSession();
    const r: any = recordDecisionTool({
      decision: 'kept closures pending until merge', why: 'an unmerged branch is a claim, not an outcome',
      files: ['packages/cli/src/todo-sweep.ts', path.join(repo, 'packages/cli/src/memory.ts'), '/elsewhere/x.ts'],
      repo_path: repo,
    }, NO_ENV);
    expect(r.error).toBeUndefined();
    expect(r.sessionId).toBe(SID);
    expect(r.text).toBe('kept closures pending until merge — an unmerged branch is a claim, not an outcome');
    expect(r.files).toEqual(['packages/cli/src/todo-sweep.ts', 'packages/cli/src/memory.ts']);

    const mem = getRepoMemory({ repoPath: repo, includeDetail: true });
    expect(mem.sessions.find((s: any) => s.sessionId.startsWith(SID.slice(0, 8)))?.decisions).toContain(r.text);

    const hits = searchHistory(repo, 'closures pending until merge', { kinds: ['decision'] }).hits;
    expect(hits[0]?.title).toBe(r.text);
    expect(hits[0]?.files).toContain('packages/cli/src/todo-sweep.ts');

    const dup: any = recordDecisionTool({ decision: 'kept closures pending until merge', why: 'an unmerged branch is a claim, not an outcome', repo_path: repo }, NO_ENV);
    expect(dup.existing).toBe(true);
  });

  it('survives the session end / commit rewrite that rebuilds decisions from markers', () => {
    liveSession();
    const r: any = recordDecisionTool({ decision: 'used text keys for closures', repo_path: repo }, NO_ENV);
    const before = readSessionMemoryEntry(repo, SID)!;
    // What every producer does: rebuild the entry from transcript markers,
    // which never carry a tool call's arguments.
    writeSessionMemory(repo, {
      ...before, recordedDecisions: undefined, decisions: ['a marker decision'],
      summary: 'session end summary', filesChanged: ['b.ts'], endedAt: new Date().toISOString(),
    });
    const after = readSessionMemoryEntry(repo, SID)!;
    expect(after.summary).toBe('session end summary');
    expect(after.decisions).toEqual(['a marker decision', r.text]);
    expect(after.recordedDecisions?.map((d) => d.text)).toEqual([r.text]);
  });

  it('is refused, not misfiled, when no single session is identifiable', () => {
    expect((recordDecisionTool({ decision: 'x', repo_path: repo }, NO_ENV) as any).error).toMatch(/no live Origin session/);
    liveSession(SID, 'one');
    liveSession('ffff0000-9999-8888-7777-666655554444', 'two', { claudeSessionId: 'host-session-2' });
    expect((recordDecisionTool({ decision: 'x', repo_path: repo }, NO_ENV) as any).error).toMatch(/2 live Origin sessions/);
    // The host's own session id picks it out.
    const r: any = recordDecisionTool({ decision: 'x', repo_path: repo }, { CLAUDE_CODE_SESSION_ID: 'host-session-2' } as any);
    expect(r.sessionId).toBe('ffff0000-9999-8888-7777-666655554444');
  });
});

describe('resolveCaptureSession', () => {
  it('ignores an ENDED session file', () => {
    liveSession(SID, 'gone', { status: 'ENDED' });
    expect(resolveCaptureSession(repo, repo, NO_ENV)).toEqual({ reason: 'none', count: 0 });
  });
});
