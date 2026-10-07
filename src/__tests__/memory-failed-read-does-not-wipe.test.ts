// A failed READ of the memory note must not become an empty note on the next write.
//
// Every memory writer is read-modify-write of the whole note, and the read
// swallowed every failure as "no memory yet". So a `git notes show` that timed
// out on a loaded machine (seen while testing the byte budget: load average 17,
// one write in ten lost) handed the writer an empty payload, and the writer
// saved it back with its one new record: the repo's entire memory, replaced by
// a single session.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const failShow = { on: false };
vi.mock('../utils/exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/exec.js')>();
  const isShow = (args: string[]) => failShow.on && args.includes('notes') && args.includes('show');
  return {
    ...real,
    git: (args: string[], opts?: Parameters<typeof real.git>[1]) => {
      if (isShow(args)) throw new Error('fatal: timed out');
      return real.git(args, opts);
    },
    gitDetailed: (args: string[], opts?: Parameters<typeof real.gitDetailed>[1]) =>
      isShow(args) ? { stdout: '', stderr: 'fatal: timed out', status: 128 } : real.gitDetailed(args, opts),
  };
});

const { writeSessionMemory, readAllSessionMemory, recordManualTodos } = await import('../memory.js');

const session = (id: string) => ({
  sessionId: id, agentSlug: 'claude-code', model: 'claude', startedAt: '2026-08-01T00:00:00.000Z',
  endedAt: '2026-08-01T01:00:00.000Z', branch: 'main', summary: `work ${id}`, filesChanged: ['a.ts'],
  promptCount: 1, linesAdded: 1, linesRemoved: 0, openTodos: [],
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('a memory write after a failed read', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mem-failread-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
  });
  afterEach(() => {
    failShow.on = false;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('is skipped, and the note keeps what it had', () => {
    for (const id of ['a', 'b', 'c']) writeSessionMemory(repo, session(id));
    expect(readAllSessionMemory(repo)).toHaveLength(3);

    failShow.on = true;
    writeSessionMemory(repo, session('d'));
    recordManualTodos(repo, [{ key: 'k', id: 'i', text: 'typed', at: '2026-08-02T00:00:00.000Z' }]);
    failShow.on = false;

    expect(readAllSessionMemory(repo).map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('still writes the first note when there is none yet', () => {
    writeSessionMemory(repo, session('first'));
    expect(readAllSessionMemory(repo).map((s) => s.sessionId)).toEqual(['first']);
  });
});
