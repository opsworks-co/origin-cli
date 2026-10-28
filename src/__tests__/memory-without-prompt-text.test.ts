/**
 * Memory is pushed by default; prompt text is not. So with prompt text off a
 * memory entry is written without the user's prompt (intent used to fall back
 * to the first prompt verbatim, summary to the same 200 characters), and what
 * older entries and the LLM brief still carry is stripped before a push.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildMemoryEntry } from '../commands/hooks/session-end.js';
import { withoutPromptText, scrubPromptTextFromMemory, writeSessionMemory, readAllSessionMemory, writeMemoryBrief, readMemoryBrief, type SessionMemoryEntry } from '../memory.js';

const PROMPT = 'rewrite the billing engine before the acquisition call';
const base = { model: 'm', branch: 'b', filesChanged: ['a.ts'], linesAdded: 1, linesRemoved: 0 };
const state = { sessionId: 's-1', startedAt: '2026-10-25T10:00:00Z', prompts: [PROMPT] };

describe('buildMemoryEntry with prompt text off', () => {
  it('no verbatim prompt in intent or summary, and the entry says so', () => {
    const e = buildMemoryEntry(state, { ...base, includePromptText: false });
    expect(JSON.stringify(e)).not.toContain('acquisition');
    expect(e.intent).toBeUndefined();
    expect(e.summary).toBe('No summary');
    expect(e.promptTextWithheld).toBe(true);
  });

  it('keeps [Origin: Intent] markers and the agent summary', () => {
    const e = buildMemoryEntry(state, { ...base, includePromptText: false, summary: 'Rewrote billing', markers: { intent: ['make billing testable'] } });
    expect(e.intent).toEqual(['make billing testable']);
    expect(e.summary).toBe('Rewrote billing');
  });

  it('with prompt text on (or unsaid) it is unchanged', () => {
    const e = buildMemoryEntry(state, base);
    expect(e.intent).toEqual([PROMPT]);
    expect(e.summary).toBe(PROMPT);
    expect(e.promptTextWithheld).toBeUndefined();
  });
});

describe('withoutPromptText', () => {
  const old: SessionMemoryEntry = {
    sessionId: 's-0', agentSlug: 'claude', model: 'm', startedAt: '', endedAt: '', branch: null,
    summary: PROMPT, filesChanged: [], promptCount: 1, linesAdded: 0, linesRemoved: 0, openTodos: [], intent: [PROMPT],
  };
  it('drops intent, and a summary that was the prompt fallback', () => {
    const e = withoutPromptText(old);
    expect(JSON.stringify(e)).not.toContain('acquisition');
    expect(e.summary).toBe('No summary');
    expect(e.promptTextWithheld).toBe(true);
  });
  it('keeps a summary of its own', () => {
    expect(withoutPromptText({ ...old, summary: 'Rewrote billing' }).summary).toBe('Rewrote billing');
  });
});

describe('scrubPromptTextFromMemory', () => {
  function repo(): string {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mem-noprompt-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    return dir;
  }

  it('strips older entries and drops a brief that may paraphrase them; a second run changes nothing', () => {
    const dir = repo();
    try {
      writeSessionMemory(dir, buildMemoryEntry(state, base));
      writeMemoryBrief(dir, { version: 1, brief: `Last session: ${PROMPT}`, signature: 'x', generatedAt: '2026-10-25T10:00:00Z' });

      expect(scrubPromptTextFromMemory(dir)).toEqual({ changed: true, ok: true });
      expect(JSON.stringify(readAllSessionMemory(dir))).not.toContain('acquisition');
      expect(readMemoryBrief(dir)).toBeNull();
      expect(scrubPromptTextFromMemory(dir)).toEqual({ changed: false, ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a brief generated prompt-free', () => {
    const dir = repo();
    try {
      writeSessionMemory(dir, buildMemoryEntry(state, { ...base, includePromptText: false }));
      writeMemoryBrief(dir, { version: 1, brief: 'Billing work in flight', signature: 'x', generatedAt: '2026-10-25T10:00:00Z', promptFree: true });
      expect(scrubPromptTextFromMemory(dir)).toEqual({ changed: false, ok: true });
      expect(readMemoryBrief(dir)?.brief).toBe('Billing work in flight');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
