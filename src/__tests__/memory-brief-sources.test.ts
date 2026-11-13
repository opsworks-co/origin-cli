/**
 * The brief note records which sessions it was written from, so the dashboard
 * can list them instead of guessing. The guess (the 12 newest sessions before
 * generatedAt) went wrong whenever isSubstantiveMemory left a session out.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { memoryBriefInputs, writeMemoryBrief, readMemoryBrief, MEMORY_BRIEF_SOURCE_LIMIT, type SessionMemoryEntry } from '../memory.js';

function entry(i: number, over: Partial<SessionMemoryEntry> = {}): SessionMemoryEntry {
  return {
    sessionId: `s-${i}`, agentSlug: 'claude-code', model: 'm', startedAt: '', endedAt: `2026-11-01T${String(i % 24).padStart(2, '0')}:00:00Z`,
    branch: null, summary: `work ${i}`, filesChanged: ['src/a.ts'], promptCount: 1, linesAdded: 1, linesRemoved: 0, openTodos: [],
    ...over,
  };
}

describe('memoryBriefInputs', () => {
  it('names exactly the sessions it sends, skipping ones isSubstantiveMemory leaves out', () => {
    const entries = [
      entry(1), entry(2, { filesChanged: [] }), entry(3, { summary: '' }), entry(4),
    ];
    const { sessions, sourceSessionIds } = memoryBriefInputs(entries);
    expect(sourceSessionIds).toEqual(['s-1', 's-4']);
    expect(sessions.map((s) => s.summary)).toEqual(['work 1', 'work 4']);
  });

  it('keeps the newest twelve, oldest first, ids in step with the sessions', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(i));
    const { sessions, sourceSessionIds } = memoryBriefInputs(entries);
    expect(sourceSessionIds).toHaveLength(MEMORY_BRIEF_SOURCE_LIMIT);
    expect(sourceSessionIds[0]).toBe('s-8');
    expect(sourceSessionIds.at(-1)).toBe('s-19');
    expect(sessions.map((s) => s.summary)).toEqual(sourceSessionIds.map((id) => `work ${id.slice(2)}`));
    // The LLM request carries no ids; they are only for the note.
    expect(JSON.stringify(sessions)).not.toContain('"s-8"');
  });
});

describe('brief note sourceSessionIds', () => {
  it('round-trips through the note, and an older note without it still reads', () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-brief-sources-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    try {
      git('init', '-q');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 'T');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
      fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
      git('add', '.');
      git('commit', '-qm', 'init');

      writeMemoryBrief(dir, { version: 1, brief: 'Old brief', signature: 'x', generatedAt: '2026-11-01T10:00:00Z' });
      expect(readMemoryBrief(dir)?.sourceSessionIds).toBeUndefined();

      writeMemoryBrief(dir, { version: 1, brief: 'New brief', signature: 'y', generatedAt: '2026-11-02T10:00:00Z', sourceSessionIds: ['s-1', 's-4'] });
      expect(readMemoryBrief(dir)?.sourceSessionIds).toEqual(['s-1', 's-4']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
