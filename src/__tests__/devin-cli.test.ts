import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// retagDevinFromProcess detects Devin by process ancestry; mock that primitive
// so the test controls "is a devin process our ancestor?" without a real tree.
const { hasAncestorProcess } = vi.hoisted(() => ({ hasAncestorProcess: vi.fn() }));
vi.mock('../utils/process-detect.js', () => ({ hasAncestorProcess }));

import {
  parseDevinCliTranscript,
  retagDevinFromProcess,
  discoverDevinCliSessionDataByPrompt,
} from '../devin-cli.js';

// Fixture mirrors the real Devin CLI "ATIF-v1.7" transcript
// (~/.local/share/devin/cli/transcripts/<session_id>.json) captured live.
const RAW = JSON.stringify({
  schema_version: 'ATIF-v1.7',
  session_id: 'lake-saffron',
  agent: { name: 'devin', version: '3000.2.17', model_name: 'SWE-1.6 Slow' },
  steps: [
    { step_id: '1', source: 'system', message: 'You are Devin…', timestamp: '2026-07-21T21:00:00Z' },
    { step_id: '9', source: 'user', message: 'create a file hello-devin.txt with one line', timestamp: '2026-07-21T21:00:05Z' },
    {
      step_id: '11', source: 'agent', message: "I'll create the file.",
      timestamp: '2026-07-21T21:00:06Z',
      extra: { generation_model: 'swe-1-6-slow' },
      tool_calls: [{ tool_call_id: 'c1', function_name: 'write', arguments: { file_path: '/x/hello-devin.txt' } }],
    },
    {
      step_id: '13', source: 'agent', message: '',
      timestamp: '2026-07-21T21:00:07Z',
      tool_calls: [{ tool_call_id: 'c2', function_name: 'exec', arguments: { command: 'echo hi' } }],
    },
    { step_id: '14', source: 'agent', message: 'Done — the file is created.', timestamp: '2026-07-21T21:00:08Z' },
  ],
  final_metrics: { total_prompt_tokens: '62525', total_completion_tokens: '386', total_cached_tokens: '0', total_steps: '14' },
});

describe('parseDevinCliTranscript', () => {
  it('extracts model, real token metrics, tool-call count, prompts and output', () => {
    const d = parseDevinCliTranscript(RAW)!;
    expect(d).toBeTruthy();
    expect(d.model).toBe('SWE-1.6 Slow');
    expect(d.inputTokens).toBe(62525);
    expect(d.outputTokens).toBe(386);
    expect(d.tokensUsed).toBe(62525 + 386);
    expect(d.toolCalls).toBe(2);
    expect(d.prompts).toEqual(['create a file hello-devin.txt with one line']);
  });

  it('builds a display transcript with the user prompt, assistant text and tool calls', () => {
    const turns = JSON.parse(parseDevinCliTranscript(RAW)!.transcript!);
    // system step is dropped; user + assistant text + [Tool: …] entries remain
    expect(turns[0]).toEqual({ role: 'user', content: 'create a file hello-devin.txt with one line' });
    const contents = turns.map((t: any) => t.content);
    expect(contents).toContain("I'll create the file.");
    expect(contents).toContain('Done — the file is created.');
    expect(contents.some((c: string) => c.startsWith('[Tool: write]'))).toBe(true);
    expect(contents.some((c: string) => c.startsWith('[Tool: exec]'))).toBe(true);
  });

  it('falls back to a per-step generation_model when the header lacks model_name', () => {
    const raw = JSON.stringify({
      steps: [{ source: 'agent', message: 'hi', extra: { generation_model: 'swe-1-6-slow' } }],
      final_metrics: {},
    });
    expect(parseDevinCliTranscript(raw)!.model).toBe('swe-1-6-slow');
  });

  it('drops steps before `since` but keeps cumulative token metrics', () => {
    const d = parseDevinCliTranscript(RAW, '2026-07-21T21:00:07Z')!;
    // the user prompt (21:00:05) is before the window → excluded
    expect(d.prompts).toEqual([]);
    // final_metrics are session-cumulative, taken as-is
    expect(d.tokensUsed).toBe(62525 + 386);
  });

  it('returns null on malformed / non-ATIF input', () => {
    expect(parseDevinCliTranscript('not json')).toBeNull();
    expect(parseDevinCliTranscript('{}')).toBeNull();
    expect(parseDevinCliTranscript(JSON.stringify({ steps: 'nope' }))).toBeNull();
  });
});

// Devin CLI reuses Claude Code's hooks; a Devin run with only the claude-code
// hook installed arrives tagged 'claude-code'. The hook's session_id does NOT
// match the transcript filename, so detection is by PROCESS ANCESTRY (the hook
// is a descendant of the `devin` binary). This is the fix for the reported
// "Devin session shown as Claude" bug.
describe('retagDevinFromProcess', () => {
  beforeEach(() => hasAncestorProcess.mockReset());

  it('re-tags a claude-code hook to devin when running under a devin process', () => {
    hasAncestorProcess.mockReturnValue(true);
    expect(retagDevinFromProcess('claude-code')).toBe('devin');
    expect(retagDevinFromProcess('claude')).toBe('devin');
    expect(retagDevinFromProcess(undefined)).toBe('devin');
  });

  it('leaves the slug untouched when devin is NOT an ancestor (real Claude session)', () => {
    hasAncestorProcess.mockReturnValue(false);
    expect(retagDevinFromProcess('claude-code')).toBe('claude-code');
    expect(retagDevinFromProcess(undefined)).toBeUndefined();
  });

  it('never re-tags a non-claude agent, even under a devin process', () => {
    hasAncestorProcess.mockReturnValue(true);
    // Only the claude-code/claude slug is hijacked by Devin; and we short-circuit
    // before even probing the process tree for other agents.
    expect(retagDevinFromProcess('cursor')).toBe('cursor');
    expect(retagDevinFromProcess('codex')).toBe('codex');
    expect(retagDevinFromProcess('devin')).toBe('devin');
    expect(hasAncestorProcess).not.toHaveBeenCalled();
  });
});

// The hook's session_id can't locate the transcript (Devin uses a different id
// for the file), so capture correlates by the run's PROMPT text instead.
describe('discoverDevinCliSessionDataByPrompt', () => {
  let dataHome: string;
  const prevXdg = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-xdg-'));
    process.env.XDG_DATA_HOME = dataHome;
    const dir = path.join(dataHome, 'devin', 'cli', 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    // Filename ("abstracted-evening") deliberately differs from any hook id.
    const active = path.join(dir, 'abstracted-evening.json');
    fs.writeFileSync(active, RAW);
    // A decoy transcript with an unrelated prompt.
    const decoy = path.join(dir, 'old-decoy.json');
    fs.writeFileSync(decoy, JSON.stringify({
      schema_version: 'ATIF-v1.7', session_id: 'old-decoy',
      agent: { model_name: 'SWE-1.5' },
      steps: [{ source: 'user', message: 'something totally different' }],
      final_metrics: { total_prompt_tokens: '1', total_completion_tokens: '1' },
    }));
    // Deterministic mtimes: the active session's transcript is the newest (as it
    // is in production — the run in progress touches its file last). The decoy
    // is older so newest-mtime fallback resolves to the active one.
    const now = Date.now() / 1000;
    fs.utimesSync(decoy, now - 600, now - 600);
    fs.utimesSync(active, now, now);
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    fs.rmSync(dataHome, { recursive: true, force: true });
  });

  it('finds the transcript whose user prompt matches the session prompt', () => {
    const d = discoverDevinCliSessionDataByPrompt(['create a file hello-devin.txt with one line'])!;
    expect(d).toBeTruthy();
    expect(d.model).toBe('SWE-1.6 Slow');       // from abstracted-evening, not the decoy
    expect(d.tokensUsed).toBe(62525 + 386);
  });

  it('returns null when no transcript is within the since window', () => {
    // since in the future → both files are older than the cutoff → no candidates.
    const d = discoverDevinCliSessionDataByPrompt(['create a file hello-devin.txt with one line'], { since: '2099-01-01T00:00:00Z' });
    expect(d).toBeNull();
  });

  it('returns null when no transcript contains the prompt — NO fallback to newest', () => {
    // Regression guard: the newest-in-window fallback grabbed an unrelated
    // session's transcript and its output clobbered the live turn. A prompt that
    // matches nothing must return null so the caller does not adopt wrong data.
    expect(discoverDevinCliSessionDataByPrompt(['a prompt that appears in no transcript'])).toBeNull();
  });

  it('returns null for an empty prompt list (nothing to correlate on)', () => {
    expect(discoverDevinCliSessionDataByPrompt([])).toBeNull();
  });
});
