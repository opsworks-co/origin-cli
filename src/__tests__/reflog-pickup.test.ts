// Attribution read back from git's own record (reflog-pickup.ts): a local
// `git merge --squash`, a reset redone as a new commit, and commits Origin's
// hooks never saw. Real repositories, hooks off — every commit here is one no
// Origin hook ran for, which is exactly the case under test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../api.js', () => ({ api: { importGitNote: vi.fn(() => Promise.resolve({ ok: true })) } }));

const {
  carryLocalSquashAttribution, carryResetRedoAttribution, markCommitSeen, parseSquashMsg, pickUpUnseenCommits,
  readHeadReflog, rememberSquashSources, resetRedoDroppedTip, resetRedoSources, evidenceForUnseenCommit,
} = await import('../reflog-pickup.js');

let repo: string;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
function commit(file: string, body: string, msg = `edit ${file}`): string {
  fs.writeFileSync(path.join(repo, file), body);
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
}
const readNote = (sha: string): any => { try { return JSON.parse(git('notes', '--ref=origin', 'show', sha)); } catch { return null; } };
const sessionsOn = (sha: string): string[] => {
  const n = readNote(sha);
  const ids = new Set<string>((n?.attribution_record?.contributions ?? []).map((c: any) => c.session?.id).filter(Boolean));
  if (n?.origin?.sessionId) ids.add(n.origin.sessionId);
  return [...ids].sort();
};
function annotate(sha: string, id: string) {
  const ref = `https://origin.example.com/sessions/${id}`;
  const note = {
    origin: { version: 1, sessionId: id, agent: 'claude-code', model: 'claude-opus-5-5', promptCount: 1, originUrl: ref },
    attribution_record: {
      schema_version: '1.0', revision: { vcs: 'git', id: sha }, attribution_level: 'commit',
      recorded_at: '2026-10-01T00:00:00Z', producer: { name: 'origin-cli', version: '0.1.0' },
      contributions: [{ evidence: 'session_capture', agent: { id: 'claude-code' }, model: { id: 'claude-opus-5-5' }, session: { id, reference_uri: ref } }],
    },
  };
  git('notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify(note), sha);
}
/** A shadow commit of the given file contents on top of `base`, as Origin's turn shadows are. */
function shadow(base: string, files: Record<string, string>): string {
  const idx = path.join(repo, '.git', `shadow-index-${Math.random()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  execFileSync('git', ['read-tree', base], { cwd: repo, env, stdio: 'pipe' });
  for (const [name, body] of Object.entries(files)) {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: body, encoding: 'utf-8' }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${name}`], { cwd: repo, env, stdio: 'pipe' });
  }
  const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf-8' }).trim();
  fs.rmSync(idx, { force: true });
  return execFileSync('git', ['commit-tree', tree, '-p', base, '-m', 'shadow'], { cwd: repo, encoding: 'utf-8' }).trim();
}
const LATER = () => Date.now() + 5 * 60 * 1000;

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-reflog-pickup-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  commit('base.txt', 'base\n', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('reset, then commit again', () => {
  it('carries the dropped commit\'s note when the new commit has its exact tree', () => {
    const d = commit('a.txt', 'one\n');
    annotate(d, 'sess-a');
    git('reset', '-q', '--soft', 'HEAD~1');
    git('commit', '-q', '-m', 'redo');
    const c = git('rev-parse', 'HEAD');
    expect(resetRedoSources(repo, c)).toEqual([d]);
    expect(carryResetRedoAttribution(repo, c)?.written).toBe(1);
    expect(sessionsOn(c)).toEqual(['sess-a']);
  });

  it('carries every commit of a multi-commit reset folded into one', () => {
    const d1 = commit('a.txt', 'one\n');
    const d2 = commit('b.txt', 'two\n');
    annotate(d1, 'sess-a');
    annotate(d2, 'sess-b');
    git('reset', '-q', '--mixed', 'HEAD~2');
    git('add', '-A');
    git('commit', '-q', '-m', 'both');
    const c = git('rev-parse', 'HEAD');
    expect(resetRedoSources(repo, c)).toEqual([d1, d2]);
    carryResetRedoAttribution(repo, c);
    expect(sessionsOn(c)).toEqual(['sess-a', 'sess-b']);
  });

  it('steps over a stash between the reset and the commit', () => {
    const d = commit('a.txt', 'one\n');
    annotate(d, 'sess-a');
    git('reset', '-q', '--soft', 'HEAD~1');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'dirt\n');
    git('stash', 'push', '-q', '--', 'base.txt');
    git('commit', '-q', '-m', 'redo');
    const c = git('rev-parse', 'HEAD');
    expect(resetRedoSources(repo, c)).toEqual([d]);
  });

  it('does not carry when the redone commit\'s content differs', () => {
    const d = commit('a.txt', 'one\n');
    annotate(d, 'sess-a');
    git('reset', '-q', '--soft', 'HEAD~1');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one, edited by hand\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'redo');
    const c = git('rev-parse', 'HEAD');
    expect(resetRedoSources(repo, c)).toBeNull();
    expect(carryResetRedoAttribution(repo, c)).toBeNull();
    expect(readNote(c)).toBeNull();
  });

  it('does not carry for a plain commit, a revert back to an earlier tree, or an amend', () => {
    const a = commit('a.txt', 'one\n');
    annotate(a, 'sess-a');
    expect(resetRedoSources(repo, a)).toBeNull();
    // Same tree as `base` again, but nothing was reset: not a redo.
    git('revert', '--no-edit', 'HEAD');
    expect(resetRedoSources(repo, git('rev-parse', 'HEAD'))).toBeNull();
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    git('add', '-A');
    git('commit', '-q', '--amend', '--no-edit');
    expect(resetRedoSources(repo, git('rev-parse', 'HEAD'))).toBeNull();
  });

  it('reads the dropped tip only from an unbroken reflog chain', () => {
    const e = (sha: string, subject: string) => ({ sha, subject, at: 0 });
    const [C, P, D, X] = ['c', 'p', 'd', 'x'].map((ch) => ch.repeat(40));
    expect(resetRedoDroppedTip([e(C, 'commit: redo'), e(P, 'reset: moving to HEAD~1'), e(D, 'commit: d')], C, P)).toBe(D);
    // HEAD reached P by a checkout from elsewhere: not a reset of P's own line.
    expect(resetRedoDroppedTip([e(C, 'commit: redo'), e(P, 'checkout: moving from x to main'), e(X, 'commit: x')], C, P)).toBeNull();
    // Something moved HEAD between the reset and the commit.
    expect(resetRedoDroppedTip([e(C, 'commit: redo'), e(X, 'checkout: moving'), e(P, 'reset: moving to HEAD~1'), e(D, 'commit: d')], C, P)).toBeNull();
    expect(resetRedoDroppedTip([e(C, 'commit (amend): redo'), e(P, 'reset: moving to HEAD~1'), e(D, 'commit: d')], C, P)).toBeNull();
  });
});

describe('git merge --squash', () => {
  function squashBranch(): { f1: string; f2: string } {
    git('checkout', '-q', '-b', 'feat');
    const f1 = commit('a.txt', 'one\n');
    const f2 = commit('b.txt', 'two\n');
    annotate(f1, 'sess-a');
    annotate(f2, 'sess-b');
    git('checkout', '-q', 'main');
    commit('main.txt', 'main moved\n');
    return { f1, f2 };
  }

  it('carries every squashed commit\'s note to the squash commit', () => {
    const { f1, f2 } = squashBranch();
    git('merge', '-q', '--squash', 'feat');
    // prepare-commit-msg's half: git removes SQUASH_MSG before post-commit runs.
    expect(rememberSquashSources(repo)?.sort()).toEqual([f1, f2].sort());
    git('commit', '-q', '-m', 'squash feat');
    expect(fs.existsSync(path.join(repo, '.git', 'SQUASH_MSG'))).toBe(false);
    const c = git('rev-parse', 'HEAD');
    expect(carryLocalSquashAttribution(repo, c)?.written).toBe(1);
    expect(sessionsOn(c)).toEqual(['sess-a', 'sess-b']);
    // Consumed, and the marker directory is gone with it.
    expect(fs.existsSync(path.join(repo, '.git', 'origin-squash-sources'))).toBe(false);
  });

  it('a later ordinary commit clears a squash marker nobody took', () => {
    squashBranch();
    git('merge', '-q', '--squash', 'feat');
    rememberSquashSources(repo);
    git('reset', '-q', '--hard');
    expect(fs.existsSync(path.join(repo, '.git', 'SQUASH_MSG'))).toBe(false);
    expect(rememberSquashSources(repo)).toBeNull();
    const c = commit('other.txt', 'x\n');
    expect(carryLocalSquashAttribution(repo, c)).toBeNull();
    expect(readNote(c)).toBeNull();
    expect(fs.existsSync(path.join(repo, '.git', 'origin-squash-sources'))).toBe(false);
  });

  it('parses only git\'s own unindented commit lines', () => {
    const sha = 'a'.repeat(40);
    const body = `Squashed commit of the following:\n\ncommit ${sha}\nAuthor: x\n\n    commit ${'b'.repeat(40)}\n`;
    expect(parseSquashMsg(body)).toEqual([sha]);
  });
});

describe('commits no hook saw', () => {
  /** A live session whose turn 0 began at `start` and ended at `end`, having written `files`. */
  function session(id: string, start: string, end: string, files: string[]): any {
    return {
      sessionId: id, repoPath: repo, agentSlug: 'claude-code', model: 'claude-opus-5-5', prompts: ['write the thing'],
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      promptShadows: [{ promptIndex: 0, shadowSha: start, capturedAt: new Date().toISOString() }],
      turnEndShadows: [{ promptIndex: 0, shadowSha: end, capturedAt: new Date().toISOString() }],
      lastClosedTurnIndex: 0, activeTurn: null,
      liveEdits: [{ promptIndex: 0, toolName: 'Edit', capturedAt: new Date().toISOString(), edits: files.map((file) => ({ file, op: 'write', source: 'tool_call' })) }],
    };
  }

  it('the first scan in a worktree only records what is already there', async () => {
    const a = commit('a.txt', 'one\n');
    commit('b.txt', 'two\n');
    // The first post-commit after an upgrade marks its commit before scanning: still a seed.
    markCommitSeen(repo, a);
    const r = await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] });
    expect(r.seeded).toBe(true);
    expect((await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] })).candidates).toBe(0);
  });

  it('gives an IDE commit of a turn\'s work to the session whose turn window proves it', async () => {
    await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] });
    const p = git('rev-parse', 'HEAD');
    const end = shadow(p, { 'a.txt': 'agent wrote this\n' });
    const c = commit('a.txt', 'agent wrote this\n', 'commit from the IDE');
    const s = session('11111111-1111-4111-8111-111111111111', p, end, ['a.txt']);
    const r = await pickUpUnseenCommits(repo, { now: LATER(), sessions: [s] });
    expect(r.attributed).toBe(1);
    expect(readNote(c)?.origin?.sessionId).toBe(s.sessionId);
    // Marked seen: the next scan does not look at it again.
    expect((await pickUpUnseenCommits(repo, { now: LATER(), sessions: [s] })).candidates).toBe(0);
  });

  it('leaves the commit unattributed when the session did not write one of its files', async () => {
    await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] });
    const p = git('rev-parse', 'HEAD');
    const end = shadow(p, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'A\n');
    const c = commit('b.txt', 'B\n');
    const s = session('22222222-2222-4222-8222-222222222222', p, end, ['a.txt']);
    expect(evidenceForUnseenCommit(repo, c, [s])).toBeNull();
    expect((await pickUpUnseenCommits(repo, { now: LATER(), sessions: [s] })).attributed).toBe(0);
    expect(readNote(c)).toBeNull();
  });

  it('leaves the commit unattributed when its content is not what the turn left (a hand edit after it)', async () => {
    await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] });
    const p = git('rev-parse', 'HEAD');
    const end = shadow(p, { 'a.txt': 'agent\n' });
    const c = commit('a.txt', 'agent, then a human\n');
    expect(evidenceForUnseenCommit(repo, c, [session('33333333-3333-4333-8333-333333333333', p, end, ['a.txt'])])).toBeNull();
  });

  it('leaves the commit unattributed when two sessions could have made it', async () => {
    await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] });
    const p = git('rev-parse', 'HEAD');
    const end = shadow(p, { 'a.txt': 'x\n' });
    const c = commit('a.txt', 'x\n');
    const both = [
      session('44444444-4444-4444-8444-444444444444', p, end, ['a.txt']),
      session('55555555-5555-4555-8555-555555555555', p, end, ['a.txt']),
    ];
    expect(evidenceForUnseenCommit(repo, c, both)).toBeNull();
  });

  it('leaves a commit whose own hook ran to that hook', async () => {
    await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] });
    const p = git('rev-parse', 'HEAD');
    const end = shadow(p, { 'a.txt': 'x\n' });
    const c = commit('a.txt', 'x\n');
    markCommitSeen(repo, c);
    const s = session('66666666-6666-4666-8666-666666666666', p, end, ['a.txt']);
    expect((await pickUpUnseenCommits(repo, { now: LATER(), sessions: [s] })).candidates).toBe(0);
    expect(readNote(c)).toBeNull();
  });

  it('waits for a commit younger than the settle time — its own backgrounded hook may still run', async () => {
    await pickUpUnseenCommits(repo, { sessions: [] });
    commit('a.txt', 'x\n');
    expect((await pickUpUnseenCommits(repo, { sessions: [] })).candidates).toBe(0);
  });

  it('carries an unseen amend from the commit the reflog says it replaced', async () => {
    const a = commit('a.txt', 'one\n');
    annotate(a, 'sess-a');
    await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one, amended\n');
    git('add', '-A');
    git('commit', '-q', '--amend', '--no-edit');
    const amended = git('rev-parse', 'HEAD');
    const r = await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] });
    expect(r.carried).toBe(1);
    expect(sessionsOn(amended)).toEqual(['sess-a']);
  });

  it('carries an unseen reset-redo', async () => {
    const d = commit('a.txt', 'one\n');
    annotate(d, 'sess-a');
    await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] });
    git('reset', '-q', '--soft', 'HEAD~1');
    git('commit', '-q', '-m', 'redo');
    const c = git('rev-parse', 'HEAD');
    expect((await pickUpUnseenCommits(repo, { now: LATER(), sessions: [] })).carried).toBe(1);
    expect(sessionsOn(c)).toEqual(['sess-a']);
  });

  it('reads the reflog newest first with each entry\'s time', () => {
    const a = commit('a.txt', 'x\n');
    const log = readHeadReflog(repo)!;
    expect(log[0].sha).toBe(a);
    expect(log[0].subject).toBe('commit: edit a.txt');
    expect(Math.abs(log[0].at * 1000 - Date.now())).toBeLessThan(60_000);
  });
});
