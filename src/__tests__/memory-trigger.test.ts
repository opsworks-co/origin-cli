// When memory is written is configurable (config.memoryUpdate): at session end
// (default), on every commit, or both. Writing on commit is what captures
// commit-and-go agents that never reach a clean session end — but it means a
// session writes memory MORE THAN ONCE, so writeSessionMemory must upsert by
// sessionId (one latest entry per session) instead of appending a duplicate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeSessionMemory, readAllSessionMemory,
  shouldWriteMemoryOnCommit, shouldWriteMemoryOnSessionEnd,
  writeMemoryBrief, readMemoryBrief, buildMemoryBriefContext, memoryBriefSignature, clearSessionMemory,
  buildMemoryContext,
  writeCommitMemory, readAllCommitMemory,
  type SessionMemoryEntry, type CommitMemoryEntry,
} from '../memory.js';

const commit = (over: Partial<CommitMemoryEntry>): CommitMemoryEntry => ({
  commitSha: 'abc1234', sessionId: 's1', agentSlug: 'antigravity', message: 'Add calculator',
  filesChanged: ['calculator.py'], linesAdded: 20, linesRemoved: 0, branch: 'main',
  committedAt: new Date().toISOString(), ...over,
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const entry = (over: Partial<SessionMemoryEntry>): SessionMemoryEntry => ({
  sessionId: 's1', agentSlug: 'claude-code', model: 'claude', startedAt: '2026-08-06T00:00:00Z',
  endedAt: new Date().toISOString(), branch: 'main', summary: 'work', filesChanged: ['a.ts'],
  promptCount: 1, linesAdded: 1, linesRemoved: 0, openTodos: [], ...over,
});

describe('memory write trigger decisions', () => {
  it('session-end writes only at session end', () => {
    expect(shouldWriteMemoryOnSessionEnd('session-end')).toBe(true);
    expect(shouldWriteMemoryOnCommit('session-end')).toBe(false);
  });
  it('commit writes only on commit', () => {
    expect(shouldWriteMemoryOnCommit('commit')).toBe(true);
    expect(shouldWriteMemoryOnSessionEnd('commit')).toBe(false);
  });
  it('both writes on commit AND at session end', () => {
    expect(shouldWriteMemoryOnCommit('both')).toBe(true);
    expect(shouldWriteMemoryOnSessionEnd('both')).toBe(true);
  });
});

describe('writeSessionMemory upsert-by-sessionId', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mem-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const x = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('re-writing the same sessionId REPLACES its entry (one per session), not appends', () => {
    writeSessionMemory(repo, entry({ sessionId: 's1', linesAdded: 3, summary: 'first commit' }));
    writeSessionMemory(repo, entry({ sessionId: 's1', linesAdded: 10, summary: 'second commit', filesChanged: ['a.ts', 'b.ts'] }));

    const all = readAllSessionMemory(repo);
    const s1 = all.filter((e) => e.sessionId === 's1');
    expect(s1).toHaveLength(1);            // upsert, not duplicate
    expect(s1[0].linesAdded).toBe(10);     // latest state won
    expect(s1[0].summary).toBe('second commit');
    expect(s1[0].filesChanged).toEqual(['a.ts', 'b.ts']);
  });

  it('different sessionIds are kept as separate entries', () => {
    writeSessionMemory(repo, entry({ sessionId: 's1' }));
    writeSessionMemory(repo, entry({ sessionId: 's2' }));
    const ids = readAllSessionMemory(repo).map((e) => e.sessionId).sort();
    expect(ids).toEqual(['s1', 's2']);
  });

  it('commit memory is IMMUTABLE (add-once by SHA) and does not clobber sessions', () => {
    writeSessionMemory(repo, entry({ sessionId: 's1', summary: 'session rollup' }));
    writeCommitMemory(repo, commit({ commitSha: 'aaa1111', sessionId: 's1', message: 'Add calculator' }));
    // second write with same SHA but a different message must be IGNORED (frozen)
    writeCommitMemory(repo, commit({ commitSha: 'aaa1111', sessionId: 's1', message: 'REWRITTEN' }));
    const commits = readAllCommitMemory(repo);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe('Add calculator');    // not rewritten
    // the session rollup survived the commit writes
    expect(readAllSessionMemory(repo).find((e) => e.sessionId === 's1')?.summary).toBe('session rollup');
    // ...and writing a session again preserves the commit log
    writeSessionMemory(repo, entry({ sessionId: 's1', summary: 'updated rollup' }));
    expect(readAllCommitMemory(repo)).toHaveLength(1);
  });

  it('prunes commit records whose session dropped out of the retained window', () => {
    writeSessionMemory(repo, entry({ sessionId: 'old' }));
    writeCommitMemory(repo, commit({ commitSha: 'old1', sessionId: 'old' }));
    expect(readAllCommitMemory(repo).map((c) => c.commitSha)).toContain('old1');
    // push 20 more sessions so 'old' falls off the MAX_ENTRIES window
    for (let i = 0; i < 21; i++) writeSessionMemory(repo, entry({ sessionId: `n${i}`, summary: `s${i}` }));
    writeCommitMemory(repo, commit({ commitSha: 'new1', sessionId: 'n20' }));
    const shas = readAllCommitMemory(repo).map((c) => c.commitSha);
    expect(shas).toContain('new1');    // its session is retained
    expect(shas).not.toContain('old1'); // 'old' session dropped → its commit pruned
  });

  it('per-file change notes round-trip and surface in the injected context', () => {
    writeSessionMemory(repo, entry({
      sessionId: 's1', summary: 'Add password generator', filesChanged: ['password_generator.py'],
      fileNotes: { 'password_generator.py': 'configurable length + charset' },
    }));
    expect(readAllSessionMemory(repo)[0].fileNotes?.['password_generator.py']).toBe('configurable length + charset');
    const ctx = buildMemoryContext(repo)!;
    expect(ctx).toContain('Recent changes:');
    expect(ctx).toContain('password_generator.py: configurable length + charset');
  });

  it('session decisions round-trip and surface in the injected context', () => {
    writeSessionMemory(repo, entry({
      sessionId: 's1', summary: 'Add server-side summarizer',
      decisions: ['Reuse the org AI-provider key server-side so it never ships to the CLI'],
    }));
    expect(readAllSessionMemory(repo)[0].decisions).toEqual([
      'Reuse the org AI-provider key server-side so it never ships to the CLI',
    ]);
    const ctx = buildMemoryContext(repo)!;
    expect(ctx).toContain('Key decisions from previous sessions:');
    expect(ctx).toContain('Reuse the org AI-provider key server-side so it never ships to the CLI');
  });

  it('commit decisions round-trip on the immutable commit record', () => {
    writeCommitMemory(repo, commit({
      commitSha: 'dec1234', sessionId: 's1', message: 'Add auth',
      decisions: ['Use bcrypt over argon2 for broader Node compatibility'],
    }));
    expect(readAllCommitMemory(repo).find((c) => c.commitSha === 'dec1234')?.decisions).toEqual([
      'Use bcrypt over argon2 for broader Node compatibility',
    ]);
  });

  it('memory brief: signature is stable, changes with the sessions, round-trips, and clears', () => {
    const e1 = entry({ sessionId: 's1', summary: 'Add calculator', filesChanged: ['calc.py'] });
    const sig1 = memoryBriefSignature([e1]);
    expect(memoryBriefSignature([e1])).toBe(sig1);                 // stable
    expect(memoryBriefSignature([e1, entry({ sessionId: 's2', summary: 'Add clock', filesChanged: ['clock.py'] })])).not.toBe(sig1); // drifts

    expect(buildMemoryBriefContext(repo)).toBeNull();             // no brief yet
    writeMemoryBrief(repo, { version: 1, brief: 'Recent focus: terminal toys.\nIn flight / unfinished:\n- no tests', signature: sig1, generatedAt: new Date().toISOString() });
    expect(readMemoryBrief(repo)?.signature).toBe(sig1);
    const injected = buildMemoryBriefContext(repo)!;
    expect(injected).toContain('Recent focus: terminal toys');
    expect(injected).toContain('In flight / unfinished');

    clearSessionMemory(repo);                                     // also drops the brief
    expect(buildMemoryBriefContext(repo)).toBeNull();
  });
});
