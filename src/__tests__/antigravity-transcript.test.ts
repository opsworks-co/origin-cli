// Validates the agy transcript parser against a REAL transcript captured from
// `agy` on this machine (fixtures/antigravity-transcript.jsonl) — the ground
// truth that the SessionStart-based wiring in #343 missed.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  parseAntigravityTranscript,
  normalizeAntigravityModel,
  estimateTokens,
  estimateAntigravityUsage,
} from '../antigravity-transcript.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'antigravity-transcript.jsonl');

describe('parseAntigravityTranscript (real agy fixture)', () => {
  const jsonl = fs.readFileSync(FIXTURE, 'utf-8');
  const parsed = parseAntigravityTranscript(jsonl);

  it('extracts the user prompt(s) from USER_REQUEST envelopes', () => {
    expect(parsed.prompts.length).toBeGreaterThanOrEqual(1);
    expect(parsed.prompts[0]).toBe('make some changes and not commit');
    // The metadata/settings blocks are stripped, not included in the prompt.
    expect(parsed.prompts[0]).not.toContain('USER_REQUEST');
    expect(parsed.prompts[0]).not.toContain('Model Selection');
  });

  it('captures the real model from the settings line', () => {
    expect(parsed.model).toBe('gemini-3.5-flash');
  });

  it('accumulates input/output text for token estimation', () => {
    expect(parsed.inputChars).toBeGreaterThan(0);
    expect(parsed.outputChars).toBeGreaterThan(parsed.inputChars); // model did the work
  });
});

describe('compaction re-injection', () => {
  // When agy compacts a long session it drops a CHECKPOINT ("Resuming from a
  // compaction") and then re-injects the ORIGINAL user request as a fresh
  // USER_EXPLICIT step. That re-injection is not a new prompt — counting it
  // produces a phantom duplicate turn (the bug the user hit: two identical
  // "make small change and not commit" turns).
  const user = (text: string) =>
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
  const checkpoint = () =>
    JSON.stringify({ type: 'CHECKPOINT', source: 'SYSTEM', content: '# Resuming from a compaction\nYou are continuing work on...' });

  it('collapses a prompt re-injected after a compaction checkpoint', () => {
    const jsonl = [user('make small change and not commit'), checkpoint(), user('make small change and not commit'), user('how many raws did you change')].join('\n');
    const { prompts } = parseAntigravityTranscript(jsonl);
    expect(prompts).toEqual(['make small change and not commit', 'how many raws did you change']);
  });

  it('keeps an identical prompt the user genuinely re-sent (no compaction between)', () => {
    const jsonl = [user('run the tests'), user('run the tests')].join('\n');
    const { prompts } = parseAntigravityTranscript(jsonl);
    expect(prompts).toEqual(['run the tests', 'run the tests']);
  });
});

describe('assistant response assembly', () => {
  const user = (text: string) =>
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
  const planner = (o: { thinking?: string; content?: string; tools?: string[] }) =>
    JSON.stringify({
      type: 'PLANNER_RESPONSE', source: 'MODEL',
      thinking: o.thinking, content: o.content,
      tool_calls: (o.tools || []).map((s) => ({ name: 'x', args: { toolSummary: s } })),
    });
  const toolOutput = (content: string) =>
    JSON.stringify({ type: 'VIEW_FILE', source: 'MODEL', content });

  it('assembles reasoning + tool chips + final answer with web markers', () => {
    const jsonl = [
      user('edit the readme'),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: [{ name: 'view_file', args: { toolSummary: 'Viewing README.md' } }] }),
      toolOutput('FILE CONTENTS THAT SHOULD NOT LEAK'),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', thinking: 'I will append a line.', tool_calls: [{ name: 'replace_file_content', args: { toolSummary: 'File edit README.md' } }] }),
      planner({ content: 'Done — appended one line to README.md.' }),
    ].join('\n');
    const { prompts, responses } = parseAntigravityTranscript(jsonl);
    expect(prompts).toEqual(['edit the readme']);
    const r = responses[0];
    // Tool calls render as [Tool: <canonical label>] chips (view_file→Read, etc.)
    expect(r).toContain('[Tool: Read] Viewing README.md');
    expect(r).toContain('[Tool: Edit] File edit README.md');
    expect(r).toContain('[Reasoning] I will append a line.'); // reasoning box
    expect(r).toContain('Done — appended one line');           // final answer
    expect(r).not.toContain('FILE CONTENTS THAT SHOULD NOT LEAK'); // tool output bodies skipped
  });

  it('shows the real command / file on the tool chip (matches the agy terminal), not just the summary', () => {
    const jsonl = [
      user('show changes'),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: [{ name: 'run_command', args: { CommandLine: 'git diff -- README.md', toolSummary: 'Git diff' } }] }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: [{ name: 'write_to_file', args: { TargetFile: '/Users/x/.gemini/brain/abc/explore_pass_changes.md', toolSummary: 'Create artifact' } }] }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/repo/session-notes.txt' } }] }),
    ].join('\n');
    const r = parseAntigravityTranscript(jsonl).responses[0];
    expect(r).toContain('[Tool: Bash] git diff -- README.md');          // real command, not "Git diff"
    expect(r).toContain('[Tool: Write] explore_pass_changes.md');       // basename of the target file
    expect(r).toContain('[Tool: Read] session-notes.txt');
    expect(r).not.toContain('Create artifact');                         // summary not used when a path exists
  });

  it('keeps a multi-paragraph thought in one [Reasoning] block (no internal blank lines)', () => {
    const jsonl = [
      user('do it'),
      planner({ thinking: '**Header**\n\nFirst paragraph.\n\nSecond paragraph.' }),
    ].join('\n');
    const { responses } = parseAntigravityTranscript(jsonl);
    const r = responses[0];
    expect(r).toContain('[Reasoning] **Header**');
    expect(r).toContain('Second paragraph.');
    // No blank line inside the reasoning block (would split it in the web view).
    expect(r).not.toContain('\n\nSecond paragraph.');
  });

  it('aligns one response per prompt and keeps a re-injection in the same turn', () => {
    const checkpoint = () =>
      JSON.stringify({ type: 'CHECKPOINT', source: 'SYSTEM', content: '# Resuming from a compaction' });
    const jsonl = [
      user('do the task'),
      planner({ content: 'first part' }),
      checkpoint(),
      user('do the task'),               // re-injection → same turn
      planner({ content: 'second part' }),
      user('now show me'),               // genuine new turn
      planner({ content: 'here it is' }),
    ].join('\n');
    const { prompts, responses } = parseAntigravityTranscript(jsonl);
    expect(prompts).toEqual(['do the task', 'now show me']);
    expect(responses[0]).toContain('first part');
    expect(responses[0]).toContain('second part'); // post-compaction work folded in
    expect(responses[1]).toBe('here it is');
  });
});

describe('helpers', () => {
  it('normalizes model labels to slugs', () => {
    expect(normalizeAntigravityModel('Gemini 3.5 Flash')).toBe('gemini-3.5-flash');
    expect(normalizeAntigravityModel('Claude Sonnet 4.5')).toBe('claude-sonnet-4.5');
    expect(normalizeAntigravityModel(null)).toBeNull();
  });

  it('estimates ~4 chars per token', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(10)).toBe(3);
  });

  it('builds an estimated-usage object flagged as estimated', () => {
    const u = estimateAntigravityUsage({ inputChars: 40, outputChars: 400 });
    expect(u).toEqual({ inputTokens: 10, outputTokens: 100, totalTokens: 110, estimated: true });
  });

  it('handles empty/garbage transcripts without throwing', () => {
    expect(parseAntigravityTranscript('')).toEqual({ prompts: [], responses: [], promptTimes: [], model: null, inputChars: 0, outputChars: 0, filePaths: [] });
    expect(parseAntigravityTranscript('not json\n{bad').prompts).toEqual([]);
  });
});

describe('prompt ordering by real created_at (stable identity)', () => {
  // agy has no UserPromptSubmit hook, so Origin re-parses the whole transcript
  // on every Stop/PostToolUse fire and keys each prompt by array index. If agy
  // reorders its brain log (a prompt queued during a long turn, or a compaction
  // re-injection), file order shifts between fires and the index stops being a
  // stable identity — promptText gets rebound to the wrong slot while the row's
  // timestamp + diff (bound on first insert) stay put. Session 5f072a99: the
  // last prompt "are you done?" surfaced at index 0 and inherited the first
  // turn's file diff. Fix: sort by created_at so the index is deterministic.
  const user = (text: string, createdAt?: string) =>
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: createdAt, content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
  const planner = (content: string) =>
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content });

  it('orders prompts by created_at even when the file lists them out of order', () => {
    // File order is scrambled (the "are you done?" rotation), but timestamps are truthful.
    const jsonl = [
      user('are you done?', '2026-07-04T19:27:00Z'),   // last chronologically, listed first
      user('just do whatever', '2026-07-04T19:12:00Z'), // first chronologically
      user('2 is okay', '2026-07-04T19:24:00Z'),
    ].join('\n');
    const { prompts, promptTimes } = parseAntigravityTranscript(jsonl);
    expect(prompts).toEqual(['just do whatever', '2 is okay', 'are you done?']);
    // Timestamps come out sorted + aligned with prompts[].
    expect(promptTimes).toEqual([
      Date.parse('2026-07-04T19:12:00Z'),
      Date.parse('2026-07-04T19:24:00Z'),
      Date.parse('2026-07-04T19:27:00Z'),
    ]);
  });

  it('keeps each prompt\'s assembled response with it after the sort', () => {
    const jsonl = [
      user('second', '2026-07-04T19:20:00Z'), planner('response to second'),
      user('first', '2026-07-04T19:10:00Z'), planner('response to first'),
    ].join('\n');
    const { prompts, responses } = parseAntigravityTranscript(jsonl);
    expect(prompts).toEqual(['first', 'second']);
    expect(responses[0]).toBe('response to first');
    expect(responses[1]).toBe('response to second');
  });

  it('falls back to file order when any prompt lacks a timestamp (no partial sort)', () => {
    // A missing timestamp must not float a turn to the front — keep file order wholesale.
    const jsonl = [
      user('alpha', '2026-07-04T19:30:00Z'),
      user('beta'),                              // no created_at
      user('gamma', '2026-07-04T19:10:00Z'),
    ].join('\n');
    const { prompts, promptTimes } = parseAntigravityTranscript(jsonl);
    expect(prompts).toEqual(['alpha', 'beta', 'gamma']); // unchanged file order
    expect(promptTimes[1]).toBeNull();
  });

  it('emits promptTimes aligned even for the single-prompt case', () => {
    const { promptTimes } = parseAntigravityTranscript(user('hi', '2026-07-04T19:00:00Z'));
    expect(promptTimes).toEqual([Date.parse('2026-07-04T19:00:00Z')]);
  });
});

describe('filePaths (repo-root recovery signal)', () => {
  // The root of the "origin-demo-12 vs origin-demo-1" bug: agy's workspace name
  // is unreliable, so repo identity is recovered from the ABSOLUTE paths of the
  // files the session actually touched. The parser must surface those.
  it('collects absolute edit/write/read paths and drops relative ones', () => {
    const jsonl = [
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>edit files</USER_REQUEST>' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: [
        { name: 'write_to_file', args: { TargetFile: '/Users/artemdolobanko/Documents/origin-demo-1/file1.txt' } },
        { name: 'replace_file_content', args: { AbsolutePath: '/Users/artemdolobanko/Documents/origin-demo-1/file2.txt' } },
        { name: 'view_file', args: { FilePath: 'relative/only.txt' } }, // dropped — not absolute
        { name: 'write_to_file', args: { TargetFile: '/Users/artemdolobanko/Documents/origin-demo-1/file1.txt' } }, // dup collapsed
      ] }),
    ].join('\n');
    const { filePaths } = parseAntigravityTranscript(jsonl);
    expect(filePaths).toEqual([
      '/Users/artemdolobanko/Documents/origin-demo-1/file1.txt',
      '/Users/artemdolobanko/Documents/origin-demo-1/file2.txt',
    ]);
  });

  it('is empty when the session touched no files', () => {
    const jsonl = [
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>just chat</USER_REQUEST>' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: [
        { name: 'run_command', args: { CommandLine: 'ls' } },
      ] }),
    ].join('\n');
    expect(parseAntigravityTranscript(jsonl).filePaths).toEqual([]);
  });
});
