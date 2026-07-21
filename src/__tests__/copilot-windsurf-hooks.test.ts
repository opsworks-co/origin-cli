// Full-support wiring for GitHub Copilot + Windsurf: the `origin enable` hook
// installers must write the agent's native hooks.json pointing every lifecycle
// event at `origin hooks <agent> <event>`, so capture flows through the generic
// (Claude-Code-style) hook path.
//
// NOTE: this verifies the generated hook config only. Live end-to-end capture
// (hooks actually firing on a real Copilot CLI / Windsurf session) still needs a
// real run — see the PR description.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installCopilotHooks, installDevinHooks } from '../commands/enable.js';
import { convertCopilotEventsToClaude, parseTranscript, readCopilotModel, extractPromptFileMappings } from '../transcript.js';
import { capturePromptEdits } from '../prompt-capture/index.js';

describe('Copilot + Windsurf hook installers', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-agent-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('Copilot: repo install writes .github/hooks/origin.json with all lifecycle events', () => {
    installCopilotHooks(dir);
    const p = path.join(dir, '.github', 'hooks', 'origin.json');
    expect(fs.existsSync(p)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(cfg.version).toBe(1);
    // Copilot CLI uses camelCase event names and runs the `bash` field.
    for (const [event, sub] of [['sessionStart', 'session-start'], ['userPromptSubmitted', 'user-prompt-submit'], ['agentStop', 'stop'], ['sessionEnd', 'session-end']] as const) {
      const entry = cfg.hooks[event]?.[0];
      expect(entry?.type).toBe('command');
      expect(entry?.bash).toContain(`origin hooks copilot ${sub}`);
      // Windows variant so the hook also fires under native PowerShell.
      expect(entry?.powershell).toContain(`hooks copilot ${sub}`);
    }
  });

  it('Devin: install writes .devin/hooks.v1.json (Claude-Code shape) routed to origin', () => {
    installDevinHooks(dir);
    const p = path.join(dir, '.devin', 'hooks.v1.json');
    expect(fs.existsSync(p)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Top-level PascalCase event keys, each { hooks: [{ type:'command', command }] }.
    expect(cfg.SessionStart?.[0]?.hooks?.[0]?.command).toContain('origin hooks devin session-start');
    expect(cfg.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain('origin hooks devin user-prompt-submit');
    expect(cfg.Stop?.[0]?.hooks?.[0]?.command).toContain('origin hooks devin stop');
    expect(cfg.SessionEnd?.[0]?.hooks?.[0]?.command).toContain('origin hooks devin session-end');
    expect(cfg.SessionStart?.[0]?.hooks?.[0]?.type).toBe('command');
  });

  it('Devin: re-running is idempotent (no duplicate origin entries)', () => {
    installDevinHooks(dir);
    installDevinHooks(dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.devin', 'hooks.v1.json'), 'utf-8'));
    expect(cfg.SessionStart).toHaveLength(1);
  });

  it('Copilot config is a self-owned file (no merge needed) and re-running is idempotent', () => {
    installCopilotHooks(dir);
    installCopilotHooks(dir); // second run must not duplicate
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.github', 'hooks', 'origin.json'), 'utf-8'));
    expect(cfg.hooks.sessionStart).toHaveLength(1);
  });
});

describe('Copilot events.jsonl → Claude JSONL conversion', () => {
  // Copilot CLI records its transcript as events.jsonl under
  // ~/.copilot/session-state/<id>/; parseTranscript must read prompt, response
  // text, tool calls and tokens out of it via the converter.
  const EVENTS = [
    { type: 'session.start', data: { sessionId: 's1' }, timestamp: '2026-07-20T13:45:30.000Z' },
    { type: 'user.message', data: { content: "what's in this repo?", transformedContent: '<current_datetime>x</current_datetime>\n\nwhat\'s in this repo?\n\n<system_notification>rename</system_notification>' }, timestamp: '2026-07-20T13:45:30.700Z' },
    { type: 'assistant.message', data: { messageId: 'a1', model: 'claude-haiku-4.5', content: '', outputTokens: 200, toolRequests: [{ toolCallId: 't1', name: 'view', arguments: { path: '/repo/README.md' } }] }, timestamp: '2026-07-20T13:45:34.000Z' },
    { type: 'assistant.message', data: { messageId: 'a2', model: 'claude-haiku-4.5', content: 'It is a demo repo.', outputTokens: 322, toolRequests: [] }, timestamp: '2026-07-20T13:45:40.000Z' },
    { type: 'session.shutdown', data: { tokenDetails: { input: { tokenCount: 50 }, cache_read: { tokenCount: 105309 }, cache_write: { tokenCount: 8574 }, output: { tokenCount: 522 } } }, timestamp: '2026-07-20T13:45:41.000Z' },
  ].map((e) => JSON.stringify(e)).join('\n');

  it('returns null for non-Copilot transcripts', () => {
    expect(convertCopilotEventsToClaude('{"type":"user","message":{"content":"hi"}}')).toBeNull();
    expect(convertCopilotEventsToClaude('')).toBeNull();
  });

  it('rewrites events into Claude JSONL with clean prompt, text, tool_use and usage', () => {
    const out = convertCopilotEventsToClaude(EVENTS);
    expect(out).not.toBeNull();
    const lines = out!.split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: 'user', message: { role: 'user', content: "what's in this repo?" } });
    // First assistant turn = tool_use only; second = text.
    expect(lines[1].message.content[0]).toMatchObject({ type: 'tool_use', name: 'view', id: 't1' });
    expect(lines[2].message.content[0]).toMatchObject({ type: 'text', text: 'It is a demo repo.' });
    // input/cache totals attach to the LAST assistant message exactly once.
    expect(lines[2].message.usage).toMatchObject({ output_tokens: 322, input_tokens: 50, cache_read_input_tokens: 105309, cache_creation_input_tokens: 8574 });
    expect(lines[1].message.usage).toEqual({ output_tokens: 200 });
  });

  it('parseTranscript reads a Copilot events.jsonl file end to end', () => {
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-copilot-'));
    const p = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(p, EVENTS);
    const r = parseTranscript(p);
    expect(r.prompts).toEqual(["what's in this repo?"]);
    expect(r.model).toBe('claude-haiku-4.5');
    expect(r.toolCalls).toBe(1);
    expect(r.toolBreakdown).toEqual([{ name: 'view', count: 1 }]);
    // Per-message outputs (200+322) sum to the session total; input/cache once.
    expect(r.outputTokens).toBe(522);
    expect(r.inputTokens).toBe(50);
    expect(r.cacheReadTokens).toBe(105309);
    expect(r.cacheCreationTokens).toBe(8574);
    expect(r.summary).toBe('It is a demo repo.');
  });

  it('readCopilotModel returns the real model, null for non-Copilot', () => {
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-copilot-m-'));
    const p = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(p, EVENTS);
    expect(readCopilotModel(p)).toBe('claude-haiku-4.5');
    const plain = path.join(tmp, 'claude.jsonl');
    fs.writeFileSync(plain, '{"type":"assistant","message":{"model":"claude-opus-4-8"}}');
    expect(readCopilotModel(plain)).toBeNull();
    expect(readCopilotModel('/nope/events.jsonl')).toBeNull();
  });

  it('extractPromptFileMappings attributes each Copilot edit to its own prompt', () => {
    // Two turns: turn 1 is read-only (view), turn 2 creates data.txt. The create
    // must map to prompt 1, not bleed onto the read-only prompt 0 (the bug that
    // put the +5 diff on the wrong turn).
    const events = [
      { type: 'session.start', data: { sessionId: 's1' }, timestamp: '2026-07-20T15:04:13.000Z' },
      { type: 'user.message', data: { content: 'check what is in this repo' }, timestamp: '2026-07-20T15:04:15.000Z' },
      { type: 'assistant.message', data: { messageId: 'a1', model: 'claude-haiku-4.5', content: 'Looking…', toolRequests: [{ toolCallId: 't1', name: 'view', arguments: { path: '/repo/README.md' } }] }, timestamp: '2026-07-20T15:04:21.000Z' },
      { type: 'user.message', data: { content: 'create a file with 5 rows' }, timestamp: '2026-07-20T15:05:17.000Z' },
      { type: 'assistant.message', data: { messageId: 'a2', model: 'claude-haiku-4.5', content: 'Done', toolRequests: [{ toolCallId: 't2', name: 'create', arguments: { path: '/repo/data.txt', content: 'a\nb\nc\nd\ne' } }] }, timestamp: '2026-07-20T15:05:21.000Z' },
    ].map((e) => JSON.stringify(e)).join('\n');
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-copilot-pm-'));
    const p = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(p, events);
    const m = extractPromptFileMappings(p);
    expect(m).toHaveLength(2);
    expect(m[0].promptIndex).toBe(0);
    expect(m[0].filesChanged).toEqual([]); // read-only turn
    expect(m[1].promptIndex).toBe(1);
    expect(m[1].filesChanged).toEqual(['/repo/data.txt']); // the create lands here
  });

  it('capturePromptEdits extracts the per-prompt write (path/file_text) so the turn shows a diff', () => {
    // Copilot's `create` tool carries the body in `file_text` and the path in
    // `path`. capturePromptEdits routes through the Claude JSONL extractor
    // (captureAgent → 'claude'), which must convert the events first — else the
    // turn had no editsJson and rendered no per-prompt diff / line count / status.
    const events = [
      { type: 'user.message', data: { content: 'create 1 file with 10 rows' }, timestamp: '2026-07-20T16:09:00.000Z' },
      { type: 'assistant.message', data: { messageId: 'a1', model: 'gpt-5-mini', content: 'Done', toolRequests: [{ toolCallId: 't1', name: 'create', arguments: { path: '/repo/ten_rows.txt', file_text: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n' } }] }, timestamp: '2026-07-20T16:09:04.000Z' },
    ].map((e) => JSON.stringify(e)).join('\n');
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-copilot-ce-'));
    const p = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(p, events);
    const caps = capturePromptEdits({ agent: 'claude', repoPath: '/repo', transcriptPath: p, sessionCommitShas: [] });
    expect(caps).toHaveLength(1);
    expect(caps[0].promptIndex).toBe(0);
    expect(caps[0].edits).toHaveLength(1);
    expect(caps[0].edits[0]).toMatchObject({ op: 'write', file: 'ten_rows.txt' });
    // The file body must survive (10 numbered rows) so the server counts +10.
    expect(caps[0].edits[0].newContent?.split('\n').filter(Boolean)).toHaveLength(10);
  });

  it('captures Copilot edit tool (old_str/new_str) per turn — no cumulative bleed', () => {
    // Copilot's `edit` tool uses old_str/new_str (Claude uses old_string/
    // new_string). Missing the alias left editsJson empty, so per-prompt diffs
    // fell to the git working tree and EVERY turn showed the latest cumulative
    // change (each "+5" edit read "+10"). With the alias each turn carries its
    // OWN edit content.
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `Row ${i + 1}`).join('\n') + '\n';
    const events = [
      { type: 'user.message', data: { content: 'add 5 more rows but not commit' }, timestamp: '2026-07-20T18:44:00.000Z' },
      { type: 'assistant.message', data: { messageId: 'a1', model: 'claude-haiku-4.5', content: 'Done', toolRequests: [{ toolCallId: 't1', name: 'edit', arguments: { path: '/repo/twenty-rows.txt', old_str: rows(35), new_str: rows(40) } }] }, timestamp: '2026-07-20T18:44:04.000Z' },
      { type: 'user.message', data: { content: 'make some more changes and commit' }, timestamp: '2026-07-20T19:52:00.000Z' },
      { type: 'assistant.message', data: { messageId: 'a2', model: 'claude-haiku-4.5', content: 'Done', toolRequests: [{ toolCallId: 't2', name: 'edit', arguments: { path: '/repo/twenty-rows.txt', old_str: rows(40), new_str: rows(45) } }] }, timestamp: '2026-07-20T19:52:04.000Z' },
    ].map((e) => JSON.stringify(e)).join('\n');
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-copilot-edit-'));
    const p = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(p, events);
    const caps = capturePromptEdits({ agent: 'claude', repoPath: '/repo', transcriptPath: p, sessionCommitShas: [] });
    expect(caps).toHaveLength(2);
    const netAdded = (c: any) => c.edits.reduce((s: number, e: any) => {
      const o = (e.oldContent || '').split('\n').filter(Boolean).length;
      const n = (e.newContent || '').split('\n').filter(Boolean).length;
      return s + Math.max(0, n - o);
    }, 0);
    // Each turn added exactly 5 rows — NOT the cumulative 10.
    expect(caps[0].edits[0]).toMatchObject({ op: 'edit', file: 'twenty-rows.txt' });
    expect(netAdded(caps[0])).toBe(5);
    expect(netAdded(caps[1])).toBe(5);
  });
});
