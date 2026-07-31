// File-level sub-agent attribution: which files each Task sub-agent edited.
// parseTranscript records sidechain (sub-agent) file edits with timestamps;
// buildSubagentSummary then attributes each file to the spawn whose execution
// window [startedAt, endedAt] contains the edit's timestamp. Exact for
// sequential sub-agents (the common case). See docs/notes/SUBAGENT_AUDIT.md (R4).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTranscript } from '../transcript.js';
import { buildSubagentSummary } from '../commands/hooks.js';
import type { SessionState } from '../session-state.js';

const T = (s: string) => `2026-07-21T10:00:${s}.000Z`;

const LINES = [
  { type: 'user', uuid: 'u1', timestamp: T('00'), message: { role: 'user', content: 'refactor auth' } },
  { type: 'assistant', uuid: 'a1', timestamp: T('01'), message: { id: 'a1', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'code-reviewer', prompt: 'review' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
  // sub-agent edits two files at :05 and :07
  { type: 'assistant', uuid: 's1', isSidechain: true, timestamp: T('05'), message: { id: 's1', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/auth.ts' } }], usage: { input_tokens: 100, output_tokens: 40 } } },
  { type: 'assistant', uuid: 's2', isSidechain: true, timestamp: T('07'), message: { id: 's2', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'src/api.ts' } }], usage: { input_tokens: 20, output_tokens: 10 } } },
  // parent edits a file at :09 (NOT a sub-agent file)
  { type: 'assistant', uuid: 'a2', timestamp: T('09'), message: { id: 'a2', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/main.ts' } }], usage: { input_tokens: 30, output_tokens: 20 } } },
].map((l) => JSON.stringify(l)).join('\n');

describe('sub-agent file attribution', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-subf-')));
    file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, LINES);
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('parseTranscript records only SIDECHAIN edits (with timestamps) as subagentEdits', () => {
    const r = parseTranscript(file);
    const files = r.subagentEdits.map((e) => e.file).sort();
    expect(files).toEqual(['src/api.ts', 'src/auth.ts']);
    expect(r.subagentEdits.every((e) => e.ts > 0)).toBe(true);
    // The parent's own edit (main.ts) is NOT a sub-agent edit.
    expect(files).not.toContain('src/main.ts');
    // …but every edited file is still in the session's overall filesChanged.
    expect(r.filesChanged).toEqual(expect.arrayContaining(['src/auth.ts', 'src/api.ts', 'src/main.ts']));
  });

  it('buildSubagentSummary attributes files to the spawn whose window contains them', () => {
    const r = parseTranscript(file);
    const state = {
      subagentSpawns: [{
        toolCallId: 't1', subagentType: 'code-reviewer', description: null, prompt: null,
        promptIndex: 0, startedAt: T('02'), endedAt: T('08'),
      }],
    } as unknown as SessionState;

    const summary = buildSubagentSummary(state, r);
    expect(summary).toHaveLength(1);
    expect(summary![0].type).toBe('code-reviewer');
    expect(summary![0].files!.sort()).toEqual(['src/api.ts', 'src/auth.ts']);
  });

  it('does not attribute edits that fall OUTSIDE a spawn window', () => {
    const r = parseTranscript(file);
    // A spawn that ended at :06 — only the :05 edit (auth.ts) falls inside.
    const state = {
      subagentSpawns: [{
        toolCallId: 't1', subagentType: 'code-reviewer', description: null, prompt: null,
        promptIndex: 0, startedAt: T('02'), endedAt: T('06'),
      }],
    } as unknown as SessionState;
    const summary = buildSubagentSummary(state, r);
    expect(summary![0].files).toEqual(['src/auth.ts']);
  });

  it('returns undefined when the session spawned no sub-agents', () => {
    expect(buildSubagentSummary({ subagentSpawns: [] } as unknown as SessionState)).toBeUndefined();
  });
});
