// A tool call that FAILED wrote nothing, so it must not be captured as work.
//
// Found on prod session cb853c02 turn 2 ("add a lockfile to deploy-prod.sh"):
// Origin reported +240 for scripts/deploy-prod.sh while git says the turn's
// commit added +124. The transcript holds three Edits of that file —
//
//   Edit old=5  new=121  is_error=true    ← rejected: "String to replace not found"
//   Edit old=4  new=122  is_error=false   ← the retry that actually landed
//   Edit old=2  new=8    is_error=false   ← a header comment
//
// — and capture kept all three. 124 real + 116 phantom = the 240 on screen,
// rendered as the same block twice in the turn's diff (two near-identical
// hunks at different baselines, which dedupeRedundantHunks can't collapse
// because the contexts differ).
//
// Both capture paths had the blind spot: the transcript extractor read every
// assistant `tool_use` block without consulting the `tool_result` that answers
// it, and the live PostToolUse ledger never looked at `tool_response`.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { capturePromptEdits } from '../prompt-capture/index.js';
import { toolCallFailed } from '../commands/hooks.js';

const REPO = '/repo';

function writeTranscript(lines: any[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-failed-tool-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

const userPrompt = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const editCall = (id: string, file: string, oldStr: string, newStr: string) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id,
      name: 'Edit',
      input: { file_path: `${REPO}/${file}`, old_string: oldStr, new_string: newStr },
    }],
  },
});

const toolResult = (id: string, isError: boolean) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? 'String to replace not found' : 'ok' }],
  },
});

describe('transcript capture skips failed tool calls', () => {
  it('drops the rejected Edit and keeps the retry that landed', () => {
    const file = writeTranscript([
      userPrompt('add a lockfile to deploy-prod.sh'),
      editCall('t1', 'script.sh', 'OLD-MISSING', 'A\nB\nC'),
      toolResult('t1', true),
      editCall('t2', 'script.sh', 'OLD-REAL', 'A\nB\nC'),
      toolResult('t2', false),
    ]);
    const caps = capturePromptEdits({ agent: 'claude', repoPath: REPO, transcriptPath: file, sessionCommitShas: [] });

    expect(caps).toHaveLength(1);
    expect(caps[0].edits).toHaveLength(1);
    expect(caps[0].edits[0].oldContent).toBe('OLD-REAL');
  });

  it('keeps every edit when nothing failed', () => {
    const file = writeTranscript([
      userPrompt('two edits'),
      editCall('t1', 'a.ts', 'x', 'y'),
      toolResult('t1', false),
      editCall('t2', 'b.ts', 'p', 'q'),
      toolResult('t2', false),
    ]);
    const caps = capturePromptEdits({ agent: 'claude', repoPath: REPO, transcriptPath: file, sessionCommitShas: [] });

    expect(caps[0].edits).toHaveLength(2);
  });

  it('keeps an edit whose result never arrived (turn still running)', () => {
    // No tool_result at all — the turn is mid-flight. Dropping here would lose
    // real work; only an explicit is_error suppresses.
    const file = writeTranscript([
      userPrompt('one edit, no result yet'),
      editCall('t1', 'a.ts', 'x', 'y'),
    ]);
    const caps = capturePromptEdits({ agent: 'claude', repoPath: REPO, transcriptPath: file, sessionCommitShas: [] });

    expect(caps[0].edits).toHaveLength(1);
  });
});

describe('toolCallFailed (live PostToolUse path)', () => {
  it('detects the shapes agents actually send', () => {
    expect(toolCallFailed({ tool_response: { is_error: true } })).toBe(true);
    expect(toolCallFailed({ tool_response: { isError: true } })).toBe(true);
    expect(toolCallFailed({ tool_response: { success: false } })).toBe(true);
    expect(toolCallFailed({ tool_response: { error: 'String to replace not found' } })).toBe(true);
    expect(toolCallFailed({ tool_response: 'Error: file not found' })).toBe(true);
    expect(toolCallFailed({ success: false })).toBe(true);
  });

  it('treats success and unknown shapes as success — a dropped capture is unrecoverable', () => {
    expect(toolCallFailed({ tool_response: { is_error: false } })).toBe(false);
    expect(toolCallFailed({ tool_response: { filePath: '/repo/a.ts' } })).toBe(false);
    expect(toolCallFailed({ tool_response: 'Applied 1 edit to /repo/a.ts' })).toBe(false);
    expect(toolCallFailed({})).toBe(false);
    expect(toolCallFailed(undefined as any)).toBe(false);
    // "error" as ordinary output text, not a status field.
    expect(toolCallFailed({ tool_response: { stdout: 'error: nothing to commit' } })).toBe(false);
  });
});
