// OR-45 checkpoint 3B, G3: a Gemini edit is proof only when Gemini says the
// call succeeded.
//
// Both capture paths read that outcome from what Gemini CLI itself records:
//
//   • the chats JSONL — every toolCalls[] entry carries `status`, Gemini's
//     CoreToolCallStatus. The scheduler writes 'success' only when the tool
//     returned no error and was not aborted; otherwise 'error' / 'cancelled'.
//   • the AfterTool hook — `tool_response` is the tool's ToolResult,
//     `{ llmContent, returnDisplay, error? }`; `error` is an object
//     (`{ message, type }`) exactly when the call failed.
//
// Failed and cancelled calls wrote nothing and are not captured. A call whose
// outcome is unknown is kept for the turn's file list, without the
// `evidence: 'tool_call'` stamp that line claims require.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { capturePromptEdits } from '../prompt-capture/index.js';
import { toolCallFailed, geminiToolCallFailed, geminiToolSucceeded, noteWrittenTree, recordLiveEdits } from '../commands/hooks/tool-use.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'gemini-jsonl-2-prompts.jsonl');

describe('Gemini transcript capture reads each call\'s status', () => {
  it('the real recording: every call is status success, so every edit is proof', () => {
    const raw = fs.readFileSync(FIXTURE, 'utf-8');
    const statuses = raw.split('\n').filter(Boolean).flatMap((l) => JSON.parse(l).toolCalls ?? []).map((tc: any) => tc.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(['success']));

    const turns = capturePromptEdits({ agent: 'gemini', repoPath: '/Users/artemdolobanko/Documents/or-test-1', transcriptPath: FIXTURE, sessionCommitShas: [] });
    const edits = turns.flatMap((t) => t.edits);
    expect(edits.length).toBeGreaterThanOrEqual(4);
    expect(edits.every((e) => e.source === 'tool_call' && e.evidence === 'tool_call')).toBe(true);
  });

  it('drops error and cancelled calls, keeps unknown ones unstamped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gemini-status-'));
    const file = path.join(dir, 'session-x.jsonl');
    const call = (id: string, name: string, args: Record<string, unknown>, status?: string) =>
      ({ id, name, args, result: [{ functionResponse: { id, name, response: status === 'success' ? { output: 'ok' } : { error: 'failed' } } }], ...(status && { status }) });
    fs.writeFileSync(file, [
      { sessionId: 's', projectHash: 'h', startTime: 'x', lastUpdated: 'x', kind: 'main' },
      { id: 'u1', type: 'user', content: [{ text: 'edit things' }] },
      { id: 'g1', type: 'gemini', content: '', toolCalls: [
        call('c1', 'replace', { file_path: '/repo/ok.py', old_string: 'a', new_string: 'b' }, 'success'),
        call('c2', 'replace', { file_path: '/repo/missing.py', old_string: 'not there', new_string: 'b' }, 'error'),
        call('c3', 'write_file', { file_path: '/repo/denied.py', content: 'x\n' }, 'cancelled'),
        call('c4', 'write_file', { file_path: '/repo/unknown.py', content: 'y\n' }),
      ] },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    try {
      const edits = capturePromptEdits({ agent: 'gemini', repoPath: '/repo', transcriptPath: file, sessionCommitShas: [] }).flatMap((t) => t.edits);
      expect(edits.map((e) => [e.file, e.evidence])).toEqual([['ok.py', 'tool_call'], ['unknown.py', undefined]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Gemini 0.64 rows without a status: edits kept, none stamped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gemini-064-status-'));
    const file = path.join(dir, 'session-y.jsonl');
    fs.writeFileSync(file, [
      { sessionId: 's', projectHash: 'h', startTime: 'x', lastUpdated: 'x', kind: 'main' },
      { id: 'u1', type: 'user', content: [{ text: 'create add.py' }] },
      { id: 'g1', type: 'gemini', content: '', toolCalls: [{ id: 'write_file__call-1', name: 'write_file', args: { file_path: 'add.py', content: 'def add(a, b):\n    return a + b\n' } }] },
      { id: 'r1', type: 'user', content: [{ functionResponse: { id: 'write_file__call-1', name: 'write_file', response: { output: 'ok' } } }] },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    try {
      const edits = capturePromptEdits({ agent: 'gemini', repoPath: '/repo', transcriptPath: file, sessionCommitShas: [] }).flatMap((t) => t.edits);
      expect(edits.map((e) => [e.file, e.evidence])).toEqual([['add.py', undefined]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Gemini AfterTool: failure and proven success', () => {
  const failedResult = { llmContent: 'Error: could not find the string to replace', returnDisplay: 'Error', error: { message: 'could not find the string to replace', type: 'edit_no_occurrence_found' } };

  it('geminiToolCallFailed recognises the ToolResult error object', () => {
    expect(geminiToolCallFailed({ tool_name: 'replace', tool_response: failedResult })).toBe(true);
    expect(geminiToolCallFailed({ tool_name: 'replace', tool_response: { llmContent: 'Successfully modified file', returnDisplay: 'ok' } })).toBe(false);
    expect(geminiToolCallFailed({ tool_name: 'replace', tool_response: { llmContent: 'ok', error: null } })).toBe(false);
    // The generic shapes still count for Gemini.
    expect(geminiToolCallFailed({ tool_name: 'replace', tool_response: { is_error: true } })).toBe(true);
    expect(geminiToolCallFailed({ tool_name: 'replace', tool_response: { error: 'failed' } })).toBe(true);
    expect(geminiToolCallFailed({ success: false })).toBe(true);
  });

  it('the generic toolCallFailed keeps its pre-OR-45 rule: an object-shaped error is an unknown shape', () => {
    expect(toolCallFailed({ tool_name: 'Edit', tool_response: failedResult })).toBe(false);
    expect(toolCallFailed({ tool_name: 'Edit', tool_response: { error: { message: 'x' } } })).toBe(false);
    // The shapes it always recognised are unchanged.
    expect(toolCallFailed({ tool_response: { is_error: true } })).toBe(true);
    expect(toolCallFailed({ tool_response: { isError: true } })).toBe(true);
    expect(toolCallFailed({ tool_response: { success: false } })).toBe(true);
    expect(toolCallFailed({ tool_response: { error: 'String to replace not found' } })).toBe(true);
    expect(toolCallFailed({ tool_response: 'Error: file not found' })).toBe(true);
    expect(toolCallFailed({ success: false })).toBe(true);
  });

  describe('live capture applies the Gemini rule to Gemini only', () => {
    let repo: string;
    const objectError = { llmContent: 'x', returnDisplay: 'x', error: { message: 'could not find the string', type: 'edit_no_occurrence_found' } };
    const payload = (tool_response: unknown) => ({
      tool_name: 'replace', tool_input: { file_path: path.join(repo, 'a.ts'), old_string: 'one', new_string: 'two' }, tool_response,
    });
    const freshState = (agentSlug: string): any => ({ agentSlug, repoPath: repo, prompts: ['edit a.ts'], promptTurnIds: ['t0'] });
    beforeEach(() => {
      repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gemini-live-')));
      // noteWrittenTree records a write only inside a git work tree.
      execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
      fs.writeFileSync(path.join(repo, 'a.ts'), 'two\n');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('drops a Gemini payload whose ToolResult carries an error object, in both live paths', () => {
      const ledger = freshState('gemini');
      expect(recordLiveEdits(ledger, payload(objectError), repo)).toBe(false);
      expect(ledger.liveEdits ?? []).toEqual([]);
      const tree = freshState('gemini');
      expect(noteWrittenTree(tree, payload(objectError), repo)).toBe(false);
    });

    it('keeps the same object-shaped payload from another agent, as it did before OR-45', () => {
      for (const agent of ['claude-code', 'cursor', 'codex']) {
        const ledger = freshState(agent);
        expect(recordLiveEdits(ledger, payload(objectError), repo), agent).toBe(true);
        expect(ledger.liveEdits.flatMap((e: any) => e.edits).map((e: any) => e.file), agent).toEqual(['a.ts']);
        expect(noteWrittenTree(freshState(agent), payload(objectError), repo), agent).toBe(true);
      }
    });
  });

  it('geminiToolSucceeded needs a ToolResult without an error', () => {
    expect(geminiToolSucceeded({ tool_name: 'replace', tool_response: { llmContent: 'Successfully modified file', returnDisplay: 'ok' } })).toBe(true);
    expect(geminiToolSucceeded({ tool_name: 'replace', tool_response: failedResult })).toBe(false);
    expect(geminiToolSucceeded({ tool_name: 'replace' })).toBe(false);
    expect(geminiToolSucceeded({ tool_name: 'replace', tool_response: 'Successfully modified file' })).toBe(false);
    expect(geminiToolSucceeded({ tool_name: 'replace', tool_response: [{ llmContent: 'x' }] })).toBe(false);
    expect(geminiToolSucceeded({ tool_name: 'replace', tool_response: {} })).toBe(false);
  });
});
