// Regression test: Gemini CLI writes some assistant turns twice with
// the same `id` and identical `tokens` (stream-finalize double-flush).
// The JSONL parser must dedupe by `id` or it double-counts tokens
// (and cost). Separately, Gemini JSONL stores both `content` and
// `tokens` at the TOP level (not nested under `message`), which used
// to make the JSONL parser ignore them entirely — every Gemini
// session reported zero tokens and dropped every user prompt.
//
// The fixture was captured from a real Gemini CLI session and has
// duplicate ids across ~half the assistant turns. If either dedupe
// or the top-level extraction regresses, this test catches it.

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { parseTranscript } from '../transcript.js';

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'gemini-jsonl-2-prompts.jsonl',
);

describe('Gemini JSONL token + prompt extraction', () => {
  it('dedupes duplicate-id message rows and reads top-level tokens', () => {
    if (!fs.existsSync(FIXTURE)) {
      throw new Error(`fixture missing at ${FIXTURE}`);
    }
    const parsed = parseTranscript(FIXTURE);

    // Recompute the expected post-dedupe totals straight from the
    // fixture so the assertion stays accurate if the fixture is
    // updated. Walk lines manually since the fixture is JSONL.
    const lines = fs
      .readFileSync(FIXTURE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    const seen = new Set<string>();
    let expectedInput = 0;
    let expectedOutput = 0;
    let expectedCached = 0;
    let totalGeminiRows = 0;
    for (const line of lines) {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const type = m.type || m.role || '';
      if (type !== 'gemini' && type !== 'model') continue;
      totalGeminiRows++;
      if (!m.tokens) continue;
      if (m.id && seen.has(m.id)) continue;
      if (m.id) seen.add(m.id);
      expectedInput += m.tokens.input || 0;
      expectedOutput += (m.tokens.output || 0) + (m.tokens.thoughts || 0);
      expectedCached += m.tokens.cached || 0;
    }

    // Sanity: fixture really has duplicate ids — otherwise the
    // dedupe test proves nothing.
    expect(totalGeminiRows).toBeGreaterThan(seen.size);

    expect(parsed.inputTokens).toBe(expectedInput);
    expect(parsed.outputTokens).toBe(expectedOutput);
    expect(parsed.cacheReadTokens).toBe(expectedCached);

    // Prompts are also surfaced — Gemini's top-level content shape
    // was dropped before this fix. Both prompts from the fixture
    // should land in result.prompts.
    expect(parsed.prompts.length).toBeGreaterThanOrEqual(2);
  });
});
