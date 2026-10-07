/**
 * TODO 3c8b0f0d. Session 64038e34's memory entry (refs/notes/origin-memory):
 * ~10 files changed across four merged PRs, entry lists ONE — the test the
 * final commit touched — and six "open" items of which one was open.
 *
 *  - Files: every upsert REPLACED the entry, and a post-commit write carries
 *    only that commit's files. A session's recorded work now only grows.
 *  - Open items: dropped when the repo holds a CONFIRMED closure for them (by
 *    text, or an item about `TODO <id>` whose id is closed), or when the same
 *    session said `[Origin: Closes]` for it. Pending closures do not hide.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { accumulateSessionWork, withoutResolvedTodos, todoDisplayId, writeSessionMemory, readAllSessionMemory, recordTodoClosures, type SessionMemoryEntry, type TodoClosure } from '../memory.js';
import { buildMemoryEntry, closedBySameSession } from '../commands/hooks/session-end.js';

const entry = (over: Partial<SessionMemoryEntry> = {}): SessionMemoryEntry => ({
  sessionId: 's-1', agentSlug: 'claude-code', model: 'm', startedAt: '2026-09-21T13:00:00Z', endedAt: '2026-09-21T15:00:00Z',
  branch: 'b', summary: 'x', filesChanged: [], promptCount: 1, linesAdded: 0, linesRemoved: 0, openTodos: [], ...over,
});
const closure = (text: string, state: 'closed' | 'pending', id = 'aaaaaaaa'): TodoClosure => ({
  key: text.trim().toLowerCase().replace(/\s+/g, ' '), id, text, reason: 'shipped', at: '2026-09-21T16:00:00Z', state,
});

describe('accumulateSessionWork', () => {
  it('a later single-commit write does not shrink the session to that commit', () => {
    const before = entry({ filesChanged: ['a.ts', 'b.ts', 'c.ts'], linesAdded: 640, linesRemoved: 19 });
    const lastCommit = entry({ filesChanged: ['c.test.ts'], linesAdded: 12, linesRemoved: 1 });
    const out = accumulateSessionWork(lastCommit, before);
    expect(out.filesChanged.sort()).toEqual(['a.ts', 'b.ts', 'c.test.ts', 'c.ts']);
    expect(out.linesAdded).toBe(640);
    expect(out.linesRemoved).toBe(19);
  });

  it('the first write is taken as is', () => {
    const e = entry({ filesChanged: ['a.ts'] });
    expect(accumulateSessionWork(e, undefined)).toBe(e);
  });
});

describe('withoutResolvedTodos', () => {
  const open = 'Not seen on the dashboard — needs a deploy';
  const aboutOther = 'TODO `87ec29e1`: repoLine still says the squash';
  const real = 'Still open: the chip nets by position only';

  it('drops an item the repo closed, and one about a TODO id that is closed', () => {
    const out = withoutResolvedTodos(entry({ openTodos: [open, aboutOther, real] }), [
      closure(open, 'closed'),
      closure('repoLine tooltip', 'closed', '87ec29e1'),
    ]);
    expect(out.openTodos).toEqual([real]);
  });

  it('a PENDING closure is a claim, not a fact — the item stays', () => {
    const out = withoutResolvedTodos(entry({ openTodos: [open] }), [closure(open, 'pending')]);
    expect(out.openTodos).toEqual([open]);
  });

  it('an id merely resembling a closed one does not match', () => {
    const out = withoutResolvedTodos(entry({ openTodos: ['TODO `87ec29e2`: something else'] }), [closure('x', 'closed', '87ec29e1')]);
    expect(out.openTodos).toHaveLength(1);
  });
});

describe('an Open item the same session Closes', () => {
  const item = 'Fix needs two halves: serve preSquashCommitTurns';

  it('matches by text', () => {
    expect(closedBySameSession(item, 's-1', [item.toUpperCase()])).toBe(true);
  });

  it('matches by the id `origin todo` shows for it', () => {
    const id = todoDisplayId(item, 's-1');
    expect(closedBySameSession(item, 's-1', [`${id} — shipped in #1753`])).toBe(true);
  });

  it('does not match another session\'s id for the same text', () => {
    const other = todoDisplayId(item, 's-2');
    expect(closedBySameSession(item, 's-1', [other])).toBe(false);
  });

  it('buildMemoryEntry leaves it out of openTodos', () => {
    const e = buildMemoryEntry(
      { sessionId: 's-1', startedAt: '2026-09-21T13:00:00Z', prompts: ['do it'] },
      {
        model: 'm', branch: 'b', filesChanged: [], linesAdded: 0, linesRemoved: 0,
        markers: { open: [item, 'genuinely open'], closes: [item] },
      },
    );
    expect(e.openTodos).toEqual(['genuinely open']);
  });
});

describe('writeSessionMemory — what the stored note holds', () => {
  function repo(): string {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-memfix-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    return dir;
  }

  it('keeps every file across the session\'s writes and drops a closed item', () => {
    const dir = repo();
    try {
      writeSessionMemory(dir, entry({ filesChanged: ['a.ts', 'b.ts'], linesAdded: 100, openTodos: ['shipped thing', 'real leftover'] }));
      recordTodoClosures(dir, [closure('shipped thing', 'closed')]);
      writeSessionMemory(dir, entry({ filesChanged: ['c.test.ts'], linesAdded: 5, openTodos: ['shipped thing', 'real leftover'] }));

      const stored = readAllSessionMemory(dir).find((e) => e.sessionId === 's-1')!;
      expect(stored.filesChanged.sort()).toEqual(['a.ts', 'b.ts', 'c.test.ts']);
      expect(stored.linesAdded).toBe(100);
      expect(stored.openTodos).toEqual(['real leftover']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
