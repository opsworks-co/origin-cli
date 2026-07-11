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

  it('returns undefined when there are no markers', () => {
    expect(parseOriginMarkers('just some prose\nno markers here')).toBeUndefined();
    expect(parseOriginMarkers('')).toBeUndefined();
    expect(parseOriginMarkers(null)).toBeUndefined();
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
});
