// Claude Code marks every turn inside a Task sub-agent with isSidechain=true.
// parseTranscript must NOT leak the sub-agent's synthetic dispatch prompt as a
// user prompt, must keep the PARENT's model/summary, and must break the
// sub-agent's tokens out of the total (while still counting them in it — the
// session incurred them). See docs/notes/SUBAGENT_AUDIT.md (R4).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTranscript } from '../transcript.js';

const LINES = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'refactor the auth module' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'a1', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'On it.' }], usage: { input_tokens: 100, output_tokens: 50 } } },
  { type: 'assistant', uuid: 'a1b', message: { id: 'a1b', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'code-reviewer', prompt: 'review the diff' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
  // ── sub-agent sidechain ──
  { type: 'user', uuid: 's-u', isSidechain: true, parentUuid: 'a1b', message: { role: 'user', content: 'You are a code-reviewer. Review the diff and report.' } },
  { type: 'assistant', uuid: 's-a', isSidechain: true, parentUuid: 's-u', message: { id: 's-a', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Found 2 issues.' }], usage: { input_tokens: 200, output_tokens: 80 } } },
  // ── back to parent ──
  { type: 'assistant', uuid: 'a2', message: { id: 'a2', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Done — applied the review.' }], usage: { input_tokens: 30, output_tokens: 20 } } },
].map((l) => JSON.stringify(l)).join('\n');

describe('parseTranscript sub-agent (isSidechain) handling', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sub-tx-')));
    file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, LINES);
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('does not leak the sub-agent dispatch prompt as a user prompt', () => {
    const r = parseTranscript(file);
    expect(r.prompts).toEqual(['refactor the auth module']);
    expect(r.prompts.join(' ')).not.toContain('You are a code-reviewer');
  });

  it('keeps the parent model + summary, not the sub-agent\'s', () => {
    const r = parseTranscript(file);
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.summary).toBe('Done — applied the review.');
  });

  it('breaks sub-agent tokens out of the total (but still counts them in it)', () => {
    const r = parseTranscript(file);
    // Total across all turns incl. sidechain.
    expect(r.inputTokens).toBe(100 + 10 + 200 + 30);
    expect(r.outputTokens).toBe(50 + 5 + 80 + 20);
    // The sub-agent's portion, broken out.
    expect(r.subagentTokens).toBe(200 + 80);
  });
});
