// The LLM session summarizer is opt-in and self-gating: it must never make a
// network call unless memorySummary='llm' AND the session did real work. The
// live LLM call itself is network (covered by manual/E2E, like the repo brief);
// these cover the gates that decide whether to call at all.
import { describe, it, expect, beforeEach } from 'vitest';
import { memorySummaryMode, synthesizeSessionSummary } from '../session-summary.js';
import { loadConfig, saveConfig, type OriginConfig } from '../config.js';

const WORK = { prompts: ['add auth'], filesChanged: ['auth.ts'], linesAdded: 10, linesRemoved: 0 };
const NO_WORK = { prompts: ['what is in my memory?'], filesChanged: [], linesAdded: 0, linesRemoved: 0 };

const setMode = (mode?: 'heuristic' | 'llm') => {
  // The test only exercises memorySummary; an isolated-HOME repo has no config,
  // so fall back to a minimal object (OriginConfig's other fields are irrelevant
  // here — cast past its required apiUrl/apiKey/etc.).
  const c = (loadConfig() || {}) as OriginConfig;
  if (mode) c.memorySummary = mode; else delete c.memorySummary;
  saveConfig(c);
};

describe('memorySummaryMode', () => {
  beforeEach(() => setMode(undefined));

  it('defaults to heuristic', () => {
    expect(memorySummaryMode()).toBe('heuristic');
  });
  it('is llm only when explicitly configured', () => {
    setMode('llm');
    expect(memorySummaryMode()).toBe('llm');
  });
});

describe('synthesizeSessionSummary self-gating (no network)', () => {
  beforeEach(() => setMode(undefined));

  it('returns null in heuristic mode even with real work (never calls out)', async () => {
    expect(await synthesizeSessionSummary(WORK)).toBeNull();
  });

  it('returns null in llm mode when there was no work (gated before key/network)', async () => {
    setMode('llm');
    expect(await synthesizeSessionSummary(NO_WORK)).toBeNull();
  });
});
