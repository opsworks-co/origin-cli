/**
 * The per-prompt EDIT pipeline must drop agent injections too.
 *
 * `capturePromptEdits` counts prompts INDEPENDENTLY of `parseTranscript`, and
 * the caller resolves a row's edits by the session's promptIndex. When the two
 * counts disagree, every prompt after the divergence is looked up at the wrong
 * index — #1136's 6-real-prompts-vs-18-captures failure, where a turn did work,
 * the work was captured, and the row still rendered empty.
 *
 * #1136 fixed that by sharing `cleanPrompt`, which strips injections by TAG.
 * A Skill's body has no tag — it is plain markdown — so it walked straight
 * through and opened a fresh turn here, even after `parseTranscript` learned to
 * drop it. The two halves of one rule are now both shared: `cleanPrompt` for
 * the tagged envelopes, `isAgentInjectedEntry` for the structural flag.
 */
import { describe, it, expect } from 'vitest';
import { capturePromptEdits } from '../prompt-capture/index.js';
import { parseTranscript, isAgentInjectedEntry } from '../transcript.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', timestamp: '2026-08-30T13:00:00.000Z',
  message: { role: 'user', content: text }, ...extra,
});
const edit = (file: string, id: string) => ({
  type: 'assistant', timestamp: '2026-08-30T13:00:01.000Z',
  message: { id, role: 'assistant', model: 'claude-opus-5', content: [
    { type: 'tool_use', id: 'tu_' + id, name: 'Edit',
      input: { file_path: file, old_string: 'a', new_string: 'b' } },
  ] },
});
const skillBody = {
  type: 'user', timestamp: '2026-08-30T13:00:02.000Z', isMeta: true,
  message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /tmp/s\n\n# Building things\n\nmarkdown' }] },
};

function fixture(rows: any[]): { transcriptPath: string; repoPath: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mep-'));
  const transcriptPath = path.join(repoPath, 's.jsonl');
  fs.writeFileSync(transcriptPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { transcriptPath, repoPath };
}

const cap = (rows: any[]) =>
  capturePromptEdits({ agent: 'claude', ...fixture(rows) } as any);

describe('capturePromptEdits and agent injections', () => {
  it('exposes one shared rule, not a second copy of it', () => {
    expect(isAgentInjectedEntry({ isMeta: true })).toBe(true);
    expect(isAgentInjectedEntry({})).toBe(false);
    expect(isAgentInjectedEntry(null)).toBe(false);
    expect(isAgentInjectedEntry(undefined)).toBe(false);
  });

  it('does not let a Skill body open a turn', () => {
    expect(cap([
      user('first real prompt'), edit('a.ts', 'm1'),
      skillBody, edit('b.ts', 'm2'),
      user('second real prompt'), edit('c.ts', 'm3'),
    ]).length).toBe(2);
  });

  it('agrees with parseTranscript — the invariant that keeps indices aligned', () => {
    const rows = [
      user('one'), edit('a.ts', 'm1'),
      skillBody, edit('b.ts', 'm2'),
      user('two'), edit('c.ts', 'm3'),
      skillBody, edit('d.ts', 'm4'),
      user('three'), edit('e.ts', 'm5'),
    ];
    const f = fixture(rows);
    const caps = capturePromptEdits({ agent: 'claude', ...f } as any);
    const list = parseTranscript(f.transcriptPath).prompts;
    expect(list.length).toBe(3);
    expect(caps.length).toBe(list.length);
  });

  it('does not over-drop: two unflagged prompts still open two turns', () => {
    expect(cap([
      user('real one'), edit('a.ts', 'm1'),
      user('real two'), edit('b.ts', 'm2'),
    ]).length).toBe(2);
  });
});
