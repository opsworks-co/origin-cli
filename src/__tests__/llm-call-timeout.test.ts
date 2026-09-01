/**
 * The LLM-backed calls aborted before the model could answer.
 *
 * `request()` defaults to DEFAULT_FETCH_TIMEOUT_MS (8s), sized for the small
 * request/response an agent hook's ~10s budget allows. A model round trip is
 * not that: the server prompts a provider and waits, routinely for tens of
 * seconds.
 *
 * So they aborted essentially every time. `memory brief refresh error
 * (non-fatal) {"message":"This operation was aborted"}` was the single largest
 * source of aborts in this machine's hook log — 20 of them — and each one threw
 * away a provider call the server had already paid for.
 *
 * Generous is safe here because no LLM call runs inside a budgeted AGENT hook:
 * maybeRefreshMemoryBrief runs at session-END, post-COMMIT and backfill (its own
 * comment says so), and the summary runs at session end. Both are best-effort —
 * on failure the caller falls back to the heuristic summary, or leaves the brief
 * unchanged.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_FETCH_TIMEOUT_MS, LLM_CALL_TIMEOUT_MS } from '../fetch-timeout.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = fs.readFileSync(path.join(here, '..', 'api.ts'), 'utf-8');
const hooksSrc = fs.readFileSync(path.join(here, '..', 'commands', 'hooks.ts'), 'utf-8');

describe('LLM-backed API calls', () => {
  it('is long enough for a model round trip', () => {
    expect(LLM_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(LLM_CALL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_FETCH_TIMEOUT_MS);
  });

  it('applies it to every LLM endpoint the CLI calls', () => {
    for (const endpoint of ['/api/mcp/sessions/summary', '/api/mcp/sessions/memory-brief']) {
      const line = apiSrc.split('\n').find((l) => l.includes(endpoint));
      expect(line, `no call site for ${endpoint}`).toBeTruthy();
      expect(line, `${endpoint} still on the default timeout`).toContain('LLM_CALL_TIMEOUT_MS');
    }
  });

  it('keeps those calls out of budgeted agent hooks', () => {
    // The timeout is only safe while this holds. maybeRefreshMemoryBrief must
    // not gain a caller from pre-tool-use / user-prompt-submit, which agents
    // kill after ~10s.
    const callers = hooksSrc.match(/maybeRefreshMemoryBrief\([^)]*'([a-z-]+)'/g) || [];
    expect(callers.length).toBeGreaterThan(0);
    for (const c of callers) {
      expect(c).not.toMatch(/'(pre-tool-use|user-prompt-submit|post-tool-use)'/);
    }
  });
});
