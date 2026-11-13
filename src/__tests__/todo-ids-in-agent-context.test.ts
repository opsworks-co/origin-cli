// An agent closes a TODO by naming its id (`[Origin: Closes] <id>`), and the
// framework tells it to look at "the open TODOs listed above". Nothing listed
// them: the ids rode in the deterministic memory digest only, which the LLM
// brief replaces whenever one exists, and that digest skipped the archive
// where most TODOs sit. On 2026-10-29 a session opened b694b1b4 ("Phase 3 …"),
// built it in #2755 and never closed it; the orchestrator later spent a run
// finding it done. Now the open TODOs are a block of their own, and a session
// is told the ids of the TODOs it opened.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordTodoClosures, todoClosureKey, todoDisplayId, writeSessionMemory } from '../memory.js';
import { buildOpenTodosContext, buildSessionTodosContext, CONTEXT_TODOS } from '../todo.js';
import { assembleRepoContext } from '../context-injection.js';

function makeRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-todo-ctx-')));
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

const entry = (sessionId: string, endedAt: string, openTodos: string[]) => ({
  sessionId, agentSlug: 'claude-code', model: 'claude-opus-5', startedAt: endedAt, endedAt, branch: 'main',
  summary: 'work', filesChanged: ['a.ts'], promptCount: 2, linesAdded: 10, linesRemoved: 0, openTodos,
});

describe('open TODO ids in the agent context', () => {
  let repo: string;
  let home: string;
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;

  beforeEach(() => {
    repo = makeRepo();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-todo-ctx-home-'));
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

  it('lists the open TODOs newest first, with the ids `origin todo` uses, and how to close one', () => {
    writeSessionMemory(repo, entry('old-session', '2026-10-13T12:00:00.000Z', ['Run a real gh pr create from a Start run']) as any);
    writeSessionMemory(repo, entry('new-session', '2026-10-29T02:46:00.000Z', ['Phase 3: run the reviewers after a run opens its PR']) as any);
    const block = buildOpenTodosContext(repo)!;
    const lines = block.split('\n');
    expect(lines[0]).toContain('[Origin: Closes] <id>');
    expect(lines[1]).toBe(`  - ${todoDisplayId('Phase 3: run the reviewers after a run opens its PR', 'new-session')}  Phase 3: run the reviewers after a run opens its PR`);
    expect(lines[2]).toContain(todoDisplayId('Run a real gh pr create from a Start run', 'old-session'));
  });

  it('leaves out one a session already claimed, caps the list, and says nothing when none is open', () => {
    expect(buildOpenTodosContext(repo)).toBeNull();
    const texts = Array.from({ length: CONTEXT_TODOS + 3 }, (_, i) => `leftover number ${i}`);
    writeSessionMemory(repo, entry('s1', '2026-10-29T10:00:00.000Z', texts) as any);
    recordTodoClosures(repo, [{ key: todoClosureKey(texts[0]), id: todoDisplayId(texts[0], 's1'), text: texts[0], reason: 'done in #1', at: '2026-10-29T11:00:00.000Z', state: 'pending', sessionId: 's2' }]);
    const block = buildOpenTodosContext(repo)!;
    expect(block).not.toContain('leftover number 0 ');
    expect(block.split('\n').filter((l) => l.startsWith('  - '))).toHaveLength(CONTEXT_TODOS);
    expect(block).toContain(`…and ${texts.length - 1 - CONTEXT_TODOS} more`);
  });

  it('reaches the agent even when the memory digest is the LLM brief, or absent', () => {
    const todos = 'Open TODOs in this repo, newest first:\n  - b694b1b4  Phase 3';
    expect(assembleRepoContext({ memory: 'brief prose', todos })).toContain(todos);
    expect(assembleRepoContext({ attribution: 'Repository AI context: 77%', todos })).toContain(todos);
  });

  it('tells a session the ids of the TODOs it opened, and drops one it closed by id', () => {
    const sid = '55b8b365-0000-0000-0000-000000000000';
    const phase3 = 'Phase 3: after a run opens its PR, run the reviewers';
    const other = 'Show the stage on the Runs list';
    const responses = [`Done.\n[Origin: Open] ${phase3}`, `More.\n\n[Origin: Open] ${other}`];
    const block = buildSessionTodosContext(sid, responses)!;
    expect(block).toContain(`${todoDisplayId(phase3, sid)}  ${phase3}`);
    expect(block).toContain(todoDisplayId(other, sid));

    const after = buildSessionTodosContext(sid, [...responses, `[Origin: Closes] ${todoDisplayId(phase3, sid)} — built in #2755`])!;
    expect(after).not.toContain(phase3);
    expect(after).toContain(other);
    expect(buildSessionTodosContext(sid, ['no markers here'])).toBeNull();
  });
});
