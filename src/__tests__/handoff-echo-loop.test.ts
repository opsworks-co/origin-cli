// A "what's in my memory?" turn produces an answer that IS a recap of the
// injected context. If that answer becomes the session summary and is written
// to the handoff, it gets injected next session as "Previous session context",
// the next agent recaps THAT, and it compounds — memory-about-memory that drags
// stale context forward. These guards break the loop.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeHandoff, buildHandoffContext, isRecapSummary, handoffRepresentsWork,
  type HandoffData,
} from '../handoff.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const handoff = (over: Partial<HandoffData>): HandoffData => ({
  version: 1, sessionId: 's', agentSlug: 'cursor', model: 'grok', endedAt: new Date().toISOString(),
  branch: 'main', prompts: [], summary: null, filesChanged: [], linesAdded: 0, linesRemoved: 0,
  lastPrompt: '', lastResponse: null, openTodos: [], ...over,
});

describe('isRecapSummary', () => {
  it('flags summaries that are themselves Origin recaps', () => {
    for (const s of [
      'From Origin memory for this repo, here is what surfaced: Overall ~97% AI...',
      'Prior work in this repo — 3 sessions (claude-code, cursor):',
      'Recent agent activity: gemini-cli wrote bouncing_ball.py',
      'Most-touched AI files: eleven-rows-new.txt (4 commits)',
      'Recent sessions: 1. ~31m ago (claude-code)...',
    ]) {
      expect(isRecapSummary(s)).toBe(true);
    }
  });
  it('does NOT flag a real work summary', () => {
    expect(isRecapSummary('Added JWT auth middleware and refresh-token rotation')).toBe(false);
    expect(isRecapSummary('Fixed the pricing table off-by-one')).toBe(false);
    expect(isRecapSummary(null)).toBe(false);
  });
});

describe('handoffRepresentsWork', () => {
  it('true only when files or lines changed', () => {
    expect(handoffRepresentsWork({ filesChanged: ['a.ts'], linesAdded: 0, linesRemoved: 0 })).toBe(true);
    expect(handoffRepresentsWork({ filesChanged: [], linesAdded: 3, linesRemoved: 0 })).toBe(true);
    expect(handoffRepresentsWork({ filesChanged: [], linesAdded: 0, linesRemoved: 0 })).toBe(false);
  });
});

describe('buildHandoffContext breaks the echo loop', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-handoff-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const x = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('a chat-only recap handoff injects NOTHING (self-heals bad handoffs on disk)', () => {
    // Exactly the origin-demo-1 shape: no files, no lines, summary is a recap.
    writeHandoff(repo, handoff({
      summary: 'From Origin memory for this repo, here is what surfaced: Recent sessions...',
      lastPrompt: 'check your origin memory, what do you know about previous work',
      filesChanged: [], linesAdded: 0, linesRemoved: 0, openTodos: [],
    }));
    expect(buildHandoffContext(repo)).toBeNull();
  });

  it('a real-work handoff still injects its summary + files', () => {
    writeHandoff(repo, handoff({
      summary: 'Added JWT auth middleware', filesChanged: ['src/auth.ts'], linesAdded: 40, linesRemoved: 2,
    }));
    const ctx = buildHandoffContext(repo)!;
    expect(ctx).toContain('Added JWT auth middleware');
    expect(ctx).toContain('src/auth.ts');
  });

  it('drops a recap summary even when some work happened, but keeps the files', () => {
    writeHandoff(repo, handoff({
      summary: 'Prior work in this repo — 2 sessions', filesChanged: ['notes.txt'], linesAdded: 5, linesRemoved: 0,
    }));
    const ctx = buildHandoffContext(repo)!;
    expect(ctx).not.toContain('Prior work in this repo');
    expect(ctx).toContain('notes.txt');
  });

  it('a carried-TODO-only handoff still surfaces the TODOs', () => {
    writeHandoff(repo, handoff({
      summary: null, filesChanged: [], linesAdded: 0, linesRemoved: 0,
      openTodos: ['wire refresh-token rotation'],
    }));
    const ctx = buildHandoffContext(repo)!;
    expect(ctx).toContain('wire refresh-token rotation');
  });
});
