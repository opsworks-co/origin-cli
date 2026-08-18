import { describe, it, expect } from 'vitest';
import {
  parseOriginMarkers,
  parseMarkersFromTranscript,
  extractTranscriptText,
} from '../origin-markers.js';

describe('parseOriginMarkers (plain text)', () => {
  it('buckets each marker kind and strips list/quote clutter', () => {
    const text = [
      '[Origin: Intent] Add rate limiting to the login route',
      '- [Origin: Decision] Use a sliding window — fixed windows allow bursts',
      '> [Origin: Open] Redis vs in-memory store still undecided',
      '  * [Origin: Verify] Check the limiter resets after the window',
      'some unrelated line',
    ].join('\n');
    const m = parseOriginMarkers(text)!;
    expect(m.intent).toEqual(['Add rate limiting to the login route']);
    expect(m.decision).toEqual(['Use a sliding window — fixed windows allow bursts']);
    expect(m.open).toEqual(['Redis vs in-memory store still undecided']);
    expect(m.verify).toEqual(['Check the limiter resets after the window']);
  });

  it('is case-insensitive on the marker name and trims a trailing period', () => {
    const m = parseOriginMarkers('[origin: decision] Went with UTC everywhere.')!;
    expect(m.decision).toEqual(['Went with UTC everywhere']);
  });

  it('de-dupes identical (kind, content) pairs', () => {
    const m = parseOriginMarkers('[Origin: Decision] X\n[Origin: Decision] X\n[Origin: Decision] Y')!;
    expect(m.decision).toEqual(['X', 'Y']);
  });

  it('drops unfilled template placeholders (never persists <…> to git notes)', () => {
    const template = [
      "[Origin: Intent] <one sentence on WHY you're making this change>",
      '[Origin: Decision] <choice you made> — <why>',
      '[Origin: Verify] <something a human reviewer should check>',
    ].join('\n');
    expect(parseOriginMarkers(template)).toBeUndefined();
    // Real content that merely contains angle brackets survives.
    const real = parseOriginMarkers('[Origin: Decision] switched to Map<string, any> — simpler')!;
    expect(real.decision).toEqual(['switched to Map<string, any> — simpler']);
  });

  it('returns undefined when there are no markers', () => {
    expect(parseOriginMarkers('just some prose\nno markers here')).toBeUndefined();
    expect(parseOriginMarkers('')).toBeUndefined();
    expect(parseOriginMarkers(null)).toBeUndefined();
  });

  // Every string below was pulled verbatim out of refs/notes/origin-memory,
  // where the unanchored regex had stored it as a real decision.
  it('ignores markers mentioned mid-sentence rather than emitted', () => {
    const prose = [
      '// explicit [Origin: Decision] markers and/or the LLM summary. The "why" a',
      'Filled example: [Origin: Decision] used bcrypt over argon2 — broader Node compatibility.',
      'two sources — explicit [Origin: Decision] markers via parseMarkersFromTranscriptPath (ground truth)',
      '<code>[Origin: Decision]</code>, <code>[Origin: Open]</code>,',
      "  '  [Origin: Decision] <choice you made> — <why>',",
    ].join('\n');
    expect(parseOriginMarkers(prose)).toBeUndefined();
  });

  it('keeps an opening inline-code span (only PAIRED quotes are wrapping)', () => {
    const m = parseOriginMarkers('[Origin: Verify] `parseMarkers` matches quoted text — confirm')!;
    expect(m.verify).toEqual(['`parseMarkers` matches quoted text — confirm']);
  });

  it('still reads a marker that opens the line, however it is decorated', () => {
    const text = [
      '[Origin: Decision] Anchored the regex — mid-sentence mentions were being stored',
      '**[Origin: Verify]** Confirm the notes no longer carry the template example',
    ].join('\n');
    const m = parseOriginMarkers(text)!;
    expect(m.decision).toEqual(['Anchored the regex — mid-sentence mentions were being stored']);
    expect(m.verify).toEqual(['Confirm the notes no longer carry the template example']);
  });
});

describe('extractTranscriptText', () => {
  it('pulls marker lines out of JSONL assistant messages (escaped newlines)', () => {
    // Claude-Code-style JSONL: assistant content is a JSON string with \n.
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'add auth' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'Working on it.\n[Origin: Decision] Chose JWT over sessions — stateless\nDone.' },
      }),
    ].join('\n');
    const text = extractTranscriptText(jsonl);
    expect(text).toContain('[Origin: Decision] Chose JWT over sessions');
    // and the marker lands on its own line so the parser sees it
    const m = parseMarkersFromTranscript(jsonl)!;
    expect(m.decision).toEqual(['Chose JWT over sessions — stateless']);
  });

  it('handles a DisplayMessage[] array transcript', () => {
    const arr = JSON.stringify([
      { role: 'user', content: 'do X' },
      { role: 'assistant', content: '[Origin: Open] Edge case Y unhandled' },
    ]);
    const m = parseMarkersFromTranscript(arr)!;
    expect(m.open).toEqual(['Edge case Y unhandled']);
  });

  it('handles content blocks nested in an array (deep collect)', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '[Origin: Verify] Run the payment e2e test' }] },
    });
    const m = parseMarkersFromTranscript(jsonl)!;
    expect(m.verify).toEqual(['Run the payment e2e test']);
  });

  it('falls back gracefully on non-JSON transcript lines', () => {
    const raw = 'plain line\n[Origin: Intent] Ship the thing\nanother plain line';
    const m = parseMarkersFromTranscript(raw)!;
    expect(m.intent).toEqual(['Ship the thing']);
  });

  it('ignores markers in the framework guidance the CLI injects into prompts', () => {
    // The SessionStart/UserPromptSubmit hooks paste the marker template —
    // worked example and all — into the transcript as user-side context.
    const guidance = [
      '  [Origin: Decision] <choice you made> — <why>',
      'Filled example: [Origin: Decision] used bcrypt over argon2 — broader Node compatibility.',
    ].join('\n');
    const jsonl = [
      JSON.stringify({ type: 'attachment', attachment: { content: guidance } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: guidance } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: '[Origin: Decision] Chose JWT over sessions — stateless' },
      }),
    ].join('\n');
    const m = parseMarkersFromTranscript(jsonl)!;
    expect(m.decision).toEqual(['Chose JWT over sessions — stateless']);
  });

  it('ignores markers inside tool payloads — files read, files written, output', () => {
    // Reading (or editing) a file that documents the template must not make
    // the template a decision. This is how hooks.ts's own source line landed
    // in git notes.
    const templateSource = "  '  [Origin: Decision] <choice you made> — <why>',";
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'fix it' },
        toolUseResult: { stdout: `[Origin: Intent] Ship the thing\n${templateSource}` },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '[Origin: Open] Notes written before this fix still carry junk' },
            { type: 'tool_use', name: 'Write', input: { file_path: 'hooks.ts', content: templateSource } },
          ],
        },
      }),
    ].join('\n');
    const m = parseMarkersFromTranscript(jsonl)!;
    expect(m.open).toEqual(['Notes written before this fix still carry junk']);
    expect(m.intent).toBeUndefined();
    expect(m.decision).toBeUndefined();
  });

  it('reads Codex-shaped records, where the role is nested under payload', () => {
    const jsonl = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '[Origin: Decision] Prefix-strip — path.relative is host-only' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'exec', input: '[Origin: Intent] not mine' },
      }),
    ].join('\n');
    const m = parseMarkersFromTranscript(jsonl)!;
    expect(m.decision).toEqual(['Prefix-strip — path.relative is host-only']);
    expect(m.intent).toBeUndefined();
  });
});
