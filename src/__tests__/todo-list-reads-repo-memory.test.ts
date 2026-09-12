// `origin todo list` said "No open TODOs" against a repo whose memory notes
// carried fifty-five.
//
// Two defects, one symptom. The command read only a local store, and the
// store had never been written: the id generator did `require('crypto')` in
// an ESM package, so every write threw inside session end's best-effort catch.
// Meanwhile session end had been recording the same TODOs into the repo's
// memory rollup — the record the injected context, `origin context memory`
// and the Memory tab all read. The list now reads those notes; the store adds
// what a person typed and remembers which memory TODOs were closed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readTodoClosures, todoClosureKey, writeSessionMemory } from '../memory.js';
import {
  getOpenTodos,
  getTodoById,
  markTodoDone,
  removeTodo,
  addManualTodo,
  addTodosFromSession,
  readMemoryTodos,
  loadTodos,
} from '../todo.js';

function makeRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-todo-mem-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

const entry = (over: Record<string, any> = {}) => ({
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  agentSlug: 'claude-code',
  model: 'claude-opus-5',
  startedAt: '2026-09-07T10:00:00.000Z',
  endedAt: '2026-09-07T12:00:00.000Z',
  branch: 'main',
  summary: 'wired the refresh endpoint',
  filesChanged: ['apps/api/src/routes/mcp.ts'],
  promptCount: 4,
  linesAdded: 120,
  linesRemoved: 30,
  openTodos: [],
  ...over,
});

describe('origin todo list reads the repo memory notes', () => {
  let repo: string;
  let home: string;
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;

  beforeEach(() => {
    repo = makeRepo();
    // A fresh store per test: the store lives at ~/.origin/origin-todos.json.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-todo-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedProfile;
    for (const d of [repo, home]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('lists the TODOs sessions recorded in refs/notes/origin-memory, newest session first', () => {
    writeSessionMemory(repo, entry({
      sessionId: 'older-session',
      endedAt: '2026-09-05T12:00:00.000Z',
      openTodos: ['run origin verify-capture after a few real sessions'],
    }) as any);
    writeSessionMemory(repo, entry({
      sessionId: 'newer-session',
      endedAt: '2026-09-07T12:00:00.000Z',
      openTodos: ['confirm Import from remote populates the tab without a reload'],
    }) as any);

    const open = getOpenTodos(repo);
    expect(open.map((t) => t.text)).toEqual([
      'confirm Import from remote populates the tab without a reload',
      'run origin verify-capture after a few real sessions',
    ]);
    expect(open.every((t) => t.source === 'memory')).toBe(true);
    expect(open[0].sessionId).toBe('newer-session');
    expect(open[0].branch).toBe('main');
    expect(open[0].id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('shows a TODO that several sessions carried once, under the session that recorded it last', () => {
    const text = 'the GitLab notes path has never run against a real project';
    writeSessionMemory(repo, entry({ sessionId: 'first', endedAt: '2026-09-04T12:00:00.000Z', openTodos: [text] }) as any);
    writeSessionMemory(repo, entry({ sessionId: 'second', endedAt: '2026-09-06T12:00:00.000Z', openTodos: [text] }) as any);

    const open = getOpenTodos(repo);
    expect(open).toHaveLength(1);
    expect(open[0].sessionId).toBe('second');
  });

  it('closing a memory TODO hides it from the list and keeps it as done', () => {
    writeSessionMemory(repo, entry({ openTodos: ['re-run the baseline', 'measure the O(N²) walk'] }) as any);
    const [first] = getOpenTodos(repo);

    const closed = markTodoDone(first.id.slice(0, 4), repo);
    expect(closed?.status).toBe('done');
    expect(closed?.text).toBe(first.text);

    expect(getOpenTodos(repo).map((t) => t.text)).toEqual(['measure the O(N²) walk']);
    // The local store still records the closure — it is what makes `done` work
    // where the note cannot be written — but it is no longer the ONLY place.
    expect(loadTodos().items).toEqual([expect.objectContaining({ id: first.id, status: 'done', source: 'memory' })]);
    // The note carries it too, which is the whole point: the TODO travels with
    // the repo, so its closure has to travel the same way or every other clone
    // and every other machine reads it as still open. `readMemoryTodos` is the
    // notes-only view, and it is down to one.
    expect(readMemoryTodos(repo).map((t) => t.text)).toEqual(['measure the O(N²) walk']);
    expect(readTodoClosures(repo)).toEqual([expect.objectContaining({
      key: todoClosureKey(first.text), state: 'closed', reason: 'closed by hand',
    })]);
    expect(getTodoById(first.id, repo)?.status).toBe('done');
  });

  it('removing a memory TODO closes it — the notes are a history, there is nothing to delete', () => {
    writeSessionMemory(repo, entry({ openTodos: ['tidy the duplicate rule in mcp.ts'] }) as any);
    const [only] = getOpenTodos(repo);

    const removed = removeTodo(only.id, repo);
    expect(removed?.mode).toBe('closed');
    expect(getOpenTodos(repo)).toEqual([]);
  });

  it('a hand-added TODO sits beside the memory ones, and adding no longer throws', () => {
    writeSessionMemory(repo, entry({ openTodos: ['from the notes'] }) as any);

    // Pre-fix: ReferenceError: require is not defined (ESM package).
    const manual = addManualTodo('ship the release note', repo);
    expect(manual.id).toMatch(/^[0-9a-f]{8}$/);

    expect(getOpenTodos(repo).map((t) => [t.text, t.source])).toEqual([
      ['ship the release note', 'manual'],
      ['from the notes', 'memory'],
    ]);
  });

  it('session end can record extracted TODOs into the store again', () => {
    // Pre-fix this threw on the first id, so the store never existed.
    const added = addTodosFromSession('sess-1', ['TODO: wire refresh-token rotation'], repo, 'main');
    expect(added).toBe(1);
    expect(getOpenTodos(repo)[0]).toMatchObject({ text: 'wire refresh-token rotation', source: 'prompt', sessionId: 'sess-1' });
  });

  it('the same TODO recorded by the store and the notes for one session appears once', () => {
    // Session end feeds both: extractTodosFromPrompts → the store, and the same
    // list → the session's memory rollup. Same text + session ⇒ same id.
    addTodosFromSession('aaaaaaaa-1111-2222-3333-444444444444', ['TODO: wire refresh-token rotation'], repo, 'main');
    writeSessionMemory(repo, entry({ openTodos: ['wire refresh-token rotation'] }) as any);

    const open = getOpenTodos(repo);
    expect(open).toHaveLength(1);
    expect(open[0].source).toBe('prompt');
  });

  it('a repo with no memory notes lists nothing and does not throw', () => {
    expect(getOpenTodos(repo)).toEqual([]);
    expect(readMemoryTodos(path.join(os.tmpdir(), 'not-a-repo-' + Date.now()))).toEqual([]);
  });
});
