// Regression test: Google's `usageMetadata.promptTokenCount` is the TOTAL
// prompt size and already INCLUDES `cachedContentTokenCount` (cached tokens
// are a subset, not additive — confirmed against the Gemini API docs:
// "promptTokenCount ... includes the number of tokens in the cached content").
//
// The usageMetadata fallback used to map `input = promptTokenCount` and
// `cached = cachedContentTokenCount` separately. Downstream the post-loop sum
// adds `input` into inputTokens (which feeds tokensUsed/cost) and `cached`
// into cacheReadTokens — so the cached tokens were counted twice, inflating
// tokensUsed. Fresh input must be `promptTokenCount - cachedContentTokenCount`.
//
// Covers BOTH parser entry points: the JSONL streaming path (type: "model")
// and the single-object parseGeminiTranscript path (messages: [...]).

import { describe, expect, it, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseTranscript } from '../transcript.js';

// Sample Gemini usageMetadata payload. cachedContentTokenCount (600) is a
// subset of promptTokenCount (1000), so fresh input = 1000 - 600 = 400.
const USAGE = {
  promptTokenCount: 1000,
  cachedContentTokenCount: 600,
  candidatesTokenCount: 200,
  thoughtsTokenCount: 50,
};

// Expected, non-double-counted totals:
const EXPECT_INPUT = 400; // 1000 - 600
const EXPECT_CACHED = 600;
const EXPECT_OUTPUT = 250; // candidates 200 + thoughts 50
const EXPECT_TOKENS_USED = EXPECT_INPUT + EXPECT_OUTPUT; // 650 — must NOT include cached

const tmpFiles: string[] = [];
function writeTmp(name: string, contents: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-')), name);
  fs.writeFileSync(p, contents);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('Gemini usageMetadata token mapping (cached is a subset of prompt)', () => {
  it('JSONL streaming path: subtracts cached from prompt for fresh input', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', content: 'hello gemini' }),
      JSON.stringify({ type: 'model', id: 'm1', content: 'hi there', usageMetadata: USAGE }),
    ].join('\n');
    const parsed = parseTranscript(writeTmp('session.jsonl', jsonl));

    expect(parsed.inputTokens).toBe(EXPECT_INPUT);
    expect(parsed.cacheReadTokens).toBe(EXPECT_CACHED);
    expect(parsed.outputTokens).toBe(EXPECT_OUTPUT);
    // The headline number must not double-count the cached portion.
    expect(parsed.tokensUsed).toBe(EXPECT_TOKENS_USED);
  });

  it('single-object parseGeminiTranscript path: subtracts cached from prompt', () => {
    const obj = JSON.stringify({
      messages: [
        { role: 'user', parts: [{ text: 'hello gemini' }] },
        { id: 'm1', role: 'model', content: 'hi there', usageMetadata: USAGE },
      ],
    });
    const parsed = parseTranscript(writeTmp('session.json', obj));

    expect(parsed.inputTokens).toBe(EXPECT_INPUT);
    expect(parsed.cacheReadTokens).toBe(EXPECT_CACHED);
    expect(parsed.outputTokens).toBe(EXPECT_OUTPUT);
    expect(parsed.tokensUsed).toBe(EXPECT_TOKENS_USED);
  });
});
