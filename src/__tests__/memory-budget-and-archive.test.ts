// The memory note keeps as many sessions as fit a BYTE budget, and what an
// aged-out session still owes — its open TODOs and its decisions — outlives it.
//
// Before: the note kept the last 20 sessions whatever their size, and a
// session's open TODOs and decisions lived only on its rollup. On this repo the
// oldest kept session was four days old, so an unfinished item disappeared from
// `origin todo list` four days after it was written, with nobody closing it.
//
// Also here: the note is written on stdin. It was `git notes add -m <payload>`,
// and a payload of hundreds of KB is refused by the OS as an argument (Linux
// caps one at 128 KB, Windows a command line at 32 KB, macOS all of argv at
// 1 MB) — the write threw E2BIG, every caller swallowed it, and memory quietly
// stopped being recorded.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  settlePayload, mergeMemoryPayloads, writeSessionMemory, readAllSessionMemory, readArchivedMemory,
  recordTodoClosures, recordManualTodos, readManualTodos, foldRemoteMemory, todoClosureKey, todoDisplayId,
  type SessionMemoryEntry, type CommitMemoryEntry,
} from '../memory.js';
import { readMemoryTodos } from '../todo.js';

const day = (n: number) => `2026-08-${String(n).padStart(2, '0')}T00:00:00.000Z`;

const session = (id: string, n: number, over: Partial<SessionMemoryEntry> = {}): SessionMemoryEntry => ({
  sessionId: id, agentSlug: 'claude-code', model: 'claude', startedAt: day(n), endedAt: day(n),
  branch: 'main', summary: `work ${id}`, filesChanged: [`${id}.ts`], promptCount: 1,
  linesAdded: 1, linesRemoved: 0, openTodos: [], ...over,
});

const commit = (sha: string, sessionId: string, bytes = 0): CommitMemoryEntry => ({
  commitSha: sha, sessionId, agentSlug: 'claude-code', message: 'x'.repeat(bytes) || `commit ${sha}`,
  filesChanged: ['a.ts'], linesAdded: 1, linesRemoved: 0, branch: 'main', committedAt: day(1),
});

const payload = (sessions: SessionMemoryEntry[], commits: CommitMemoryEntry[] = [], extra = {}) => ({
  version: 2, sessions, commits, tombstones: [], closedTodos: [], manualTodos: [], ...extra,
});

describe('settlePayload — the byte-budget window', () => {
  it('keeps every session while the note fits, however many there are', () => {
    const sessions = Array.from({ length: 40 }, (_, i) => session(`s${i}`, (i % 28) + 1));
    expect(settlePayload(payload(sessions), 1024 * 1024).sessions).toHaveLength(40);
  });

  it('drops the oldest sessions, and their commit records, once the budget is spent', () => {
    // Commit records are what makes a session expensive; each of these is ~5 KB.
    const sessions = Array.from({ length: 10 }, (_, i) => session(`s${i}`, i + 1));
    const commits = sessions.map((s) => commit(`c${s.sessionId}`, s.sessionId, 5_000));
    const out = settlePayload(payload(sessions, commits), 60_000);
    const kept = out.sessions.map((s) => s.sessionId);
    expect(kept.length).toBeLessThan(10);
    expect(kept).toContain('s9');
    expect(kept).not.toContain('s0');
    expect(out.commits.map((c) => c.sessionId).sort()).toEqual([...kept].sort());
    expect(JSON.stringify(out, null, 2).length).toBeLessThanOrEqual(60_000);
  });

  it('never keeps fewer than five sessions, even when one alone overflows the budget', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => session(`s${i}`, i + 1));
    const commits = sessions.map((s) => commit(`c${s.sessionId}`, s.sessionId, 20_000));
    expect(settlePayload(payload(sessions, commits), 10_000).sessions.map((s) => s.sessionId))
      .toEqual(['s3', 's4', 's5', 's6', 's7']);
  });

  it('decides by time, not by where a session sits in the list', () => {
    // A long session upserts into the slot it took when it FIRST wrote, so the
    // newest session can sit at the front. The count window sliced by position
    // and evicted it; the budget must not.
    const sessions = [session('newest', 28), ...Array.from({ length: 8 }, (_, i) => session(`s${i}`, i + 1))];
    const commits = sessions.map((s) => commit(`c${s.sessionId}`, s.sessionId, 20_000));
    const kept = settlePayload(payload(sessions, commits), 10_000).sessions.map((s) => s.sessionId);
    expect(kept[0]).toBe('newest'); // stored order is kept
    expect(kept).toEqual(['newest', 's4', 's5', 's6', 's7']);
  });
});

describe('settlePayload — what an evicted session still owes', () => {
  const evicting = (old: SessionMemoryEntry, extra = {}) => {
    const recent = Array.from({ length: 5 }, (_, i) => session(`r${i}`, i + 10));
    const commits = recent.map((s) => commit(`c${s.sessionId}`, s.sessionId, 20_000));
    return settlePayload(payload([old, ...recent], commits, extra), 10_000);
  };

  it('moves its open TODOs and decisions to the archive', () => {
    const out = evicting(session('old', 1, {
      openTodos: ['sweep the e2e files for [length - 1]'],
      decisions: ['byte budget over count — the count protected nothing'],
    }));
    expect(out.sessions.map((s) => s.sessionId)).not.toContain('old');
    expect(out.archivedTodos).toEqual([expect.objectContaining({
      key: todoClosureKey('sweep the e2e files for [length - 1]'), sessionId: 'old', at: day(1),
    })]);
    expect(out.archivedDecisions?.map((d) => d.text)).toEqual(['byte budget over count — the count protected nothing']);
  });

  it('does not archive a TODO a confirmed closure already discharged', () => {
    const text = 'already shipped';
    const out = evicting(session('old', 1, { openTodos: [text] }), {
      closedTodos: [{ key: todoClosureKey(text), id: 'x', text, reason: 'r', at: day(2), state: 'closed' }],
    });
    expect(out.archivedTodos).toEqual([]);
    // …and its closure, which now reaches nothing, is pruned.
    expect(out.closedTodos).toEqual([]);
  });

  it('keeps a pending closure alive while the archived TODO it annotates is there', () => {
    const text = 'claimed on a branch';
    const out = evicting(session('old', 1, { openTodos: [text] }), {
      closedTodos: [{ key: todoClosureKey(text), id: 'x', text, reason: 'r', at: day(2), state: 'pending' }],
    });
    expect(out.archivedTodos?.map((t) => t.text)).toEqual([text]);
    expect(out.closedTodos?.map((c) => c.key)).toEqual([todoClosureKey(text)]);
  });

  it('drops an archived TODO once its closure is confirmed', () => {
    const text = 'closed later';
    const archived = { key: todoClosureKey(text), text, sessionId: 'gone', at: day(1) };
    const out = settlePayload(payload([session('s', 2)], [], {
      archivedTodos: [archived],
      closedTodos: [{ key: archived.key, id: 'x', text, reason: 'r', at: day(3), state: 'closed' }],
    }));
    expect(out.archivedTodos).toEqual([]);
  });

  it('holds the archive to its share, dropping old decisions before any TODO', () => {
    const decisions = Array.from({ length: 50 }, (_, i) => ({
      key: `d${i}`, text: `decision ${i} ${'y'.repeat(200)}`, sessionId: 'gone', at: day((i % 28) + 1),
    }));
    const todos = Array.from({ length: 3 }, (_, i) => ({ key: `t${i}`, text: `todo ${i}`, sessionId: 'gone', at: day(1) }));
    const out = settlePayload(payload([session('s', 2)], [], { archivedTodos: todos, archivedDecisions: decisions }), 20_000);
    expect(out.archivedTodos).toHaveLength(3);
    expect(out.archivedDecisions!.length).toBeLessThan(50);
    expect(out.archivedDecisions!.length).toBeGreaterThan(0);
    // The ones kept are the newest.
    const kept = out.archivedDecisions!.map((d) => Date.parse(d.at));
    const cut = Math.min(...kept);
    expect(decisions.filter((d) => Date.parse(d.at) > cut).every((d) => out.archivedDecisions!.some((k) => k.key === d.key))).toBe(true);
  });

  it('merges archives from both machines by key', () => {
    const a = { key: 'a', text: 'A', sessionId: 's1', at: day(1) };
    const b = { key: 'b', text: 'B', sessionId: 's2', at: day(2) };
    const merged = mergeMemoryPayloads(
      payload([session('x', 3)], [], { archivedTodos: [a], archivedDecisions: [a] }),
      payload([session('x', 3)], [], { archivedTodos: [b, a], archivedDecisions: [b] }),
    );
    expect(merged.archivedTodos?.map((t) => t.key).sort()).toEqual(['a', 'b']);
    expect(merged.archivedDecisions?.map((t) => t.key).sort()).toEqual(['a', 'b']);
  });
});

// ─── On a real note ──────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function makeRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mem-budget-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.dev');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

describe('on a real note', () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => {
    delete process.env.ORIGIN_MEMORY_BUDGET_BYTES;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('an aged-out session\'s TODO stays in `origin todo list`, under the id it was listed with', () => {
    const text = 'the Windows capture gate is still not fully restored';
    writeSessionMemory(repo, session('old-session', 1, { openTodos: [text], decisions: ['keep it'] }));
    const before = readMemoryTodos(repo).find((t) => t.text === text);
    expect(before?.id).toBe(todoDisplayId(text, 'old-session'));

    process.env.ORIGIN_MEMORY_BUDGET_BYTES = '4000';
    for (let i = 0; i < 12; i++) writeSessionMemory(repo, session(`n${i}`, i + 2));

    expect(readAllSessionMemory(repo).map((e) => e.sessionId)).not.toContain('old-session');
    const after = readMemoryTodos(repo).find((t) => t.text === text);
    expect(after).toBeDefined();
    expect(after!.id).toBe(before!.id);
    expect(after!.sessionId).toBe('old-session');
    expect(readArchivedMemory(repo).decisions.map((d) => d.text)).toEqual(['keep it']);
  });

  it('closing an archived TODO removes it from the list', () => {
    const text = 'close me after I age out';
    writeSessionMemory(repo, session('old-session', 1, { openTodos: [text] }));
    process.env.ORIGIN_MEMORY_BUDGET_BYTES = '4000';
    for (let i = 0; i < 12; i++) writeSessionMemory(repo, session(`n${i}`, i + 2));
    expect(readMemoryTodos(repo).some((t) => t.text === text)).toBe(true);

    recordTodoClosures(repo, [{
      key: todoClosureKey(text), id: todoDisplayId(text, 'old-session'), text,
      reason: 'done', at: day(20), state: 'closed',
    }]);
    expect(readMemoryTodos(repo).some((t) => t.text === text)).toBe(false);
    expect(readArchivedMemory(repo).todos).toEqual([]);
  });

  it('writes a note larger than any OS will take as an argument', () => {
    // ~1.5 MB: over Linux's 128 KB per-argument limit, Windows' 32 KB command
    // line, and macOS's 1 MB for all of argv. `-m <payload>` threw E2BIG here.
    process.env.ORIGIN_MEMORY_BUDGET_BYTES = String(4 * 1024 * 1024);
    const big = 'z'.repeat(150_000);
    for (let i = 0; i < 10; i++) writeSessionMemory(repo, session(`s${i}`, i + 1, { summary: `${i} ${big}` }));
    expect(readAllSessionMemory(repo)).toHaveLength(10);
  });

  it('a fold brings the remote\'s archive and typed TODOs, not only its sessions', () => {
    // The fold used to write sessions/commits/tombstones/closures and let the
    // rest be "preserved" — from the LOCAL note, so the remote's never arrived.
    writeSessionMemory(repo, session('mine', 5));
    const remoteText = 'typed on the other laptop';
    const staged = {
      ...payload([session('theirs', 6)]),
      manualTodos: [{ key: todoClosureKey(remoteText), id: 'abcd1234', text: remoteText, at: day(6) }],
      archivedTodos: [{ key: 'old owed item', text: 'old owed item', sessionId: 'ancient', at: day(1) }],
      archivedDecisions: [{ key: 'why x', text: 'why X', sessionId: 'ancient', at: day(1) }],
    };
    const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD');
    execFileSync('git', ['notes', '--ref=origin-memory-staging', 'add', '-f', '-F', '-', root], {
      cwd: repo, input: JSON.stringify(staged), stdio: ['pipe', 'pipe', 'pipe'],
    });

    expect(foldRemoteMemory(repo, 'refs/notes/origin-memory-staging')).toBe(true);
    expect(readAllSessionMemory(repo).map((s) => s.sessionId).sort()).toEqual(['mine', 'theirs']);
    expect(readManualTodos(repo).map((m) => m.text)).toEqual([remoteText]);
    expect(readArchivedMemory(repo).todos.map((t) => t.text)).toEqual(['old owed item']);
    expect(readArchivedMemory(repo).decisions.map((t) => t.text)).toEqual(['why X']);
    // A second fold of the same remote has nothing to add.
    expect(foldRemoteMemory(repo, 'refs/notes/origin-memory-staging')).toBe(false);
  });

  it('a manual TODO written locally survives a later session write', () => {
    recordManualTodos(repo, [{ key: 'k', id: 'i', text: 'typed', at: day(1) }]);
    writeSessionMemory(repo, session('s', 2));
    expect(readManualTodos(repo).map((m) => m.text)).toEqual(['typed']);
  });
});
