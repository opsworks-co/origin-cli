// Regression tests for the prompt-cleaner. Codex reads AGENTS.md natively
// and re-emits its content as the first "user" turn in its rollout — that
// envelope used to leak through and show up as a fake first prompt in the
// dashboard. Verify both detection paths drop it.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTranscript } from '../transcript.js';

function writeJsonl(entries: any[]): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-prompt-test-'));
  const file = path.join(tmp, 'transcript.jsonl');
  // Always end with a trailing newline + sentinel assistant entry — a single
  // newline-free JSON entry would trip parseTranscript's single-object Gemini
  // detection and skip the JSONL parser entirely.
  const sentinel = { type: 'assistant', message: { role: 'assistant', content: '' } };
  const all = [...entries, sentinel];
  fs.writeFileSync(file, all.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

describe('cleanPrompt — system-injected envelope filtering', () => {
  it('drops a user message that is just our origin-managed AGENTS.md echo', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: '# AGENTS.md instructions for /Users/me/repo <INSTRUCTIONS> <!-- origin-managed --> Origin: Session tracking active — prompts, files, and tokens will be captured. </INSTRUCTIONS>',
        },
      },
      {
        type: 'user',
        message: { role: 'user', content: 'make some changes and commit' },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual(['make some changes and commit']);
  });

  it('drops a user message containing only the origin-managed marker (Claude Code path)', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'wrapper\n<!-- origin-managed -->\nOrigin: Session tracking active\n<!-- origin-managed -->\nmore wrapper',
        },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual([]);
  });

  it('strips the <INSTRUCTIONS> envelope but keeps any real text outside it', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'fix the failing test\n<INSTRUCTIONS>system stuff</INSTRUCTIONS>',
        },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual(['fix the failing test']);
  });

  it('keeps a normal prompt that has no envelope at all', () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: { role: 'user', content: 'add a dark mode toggle' },
      },
    ]);
    const parsed = parseTranscript(file);
    expect(parsed.prompts).toEqual(['add a dark mode toggle']);
  });
});
