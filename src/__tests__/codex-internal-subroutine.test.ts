import { describe, it, expect } from 'vitest';
import { isCodexInternalSubroutine } from '../commands/hooks.js';
import { isKnownCodexInternalPrompt } from '../agents/codex.js';

describe('isCodexInternalSubroutine', () => {
  it('flags the ambient-suggestion safety filter by its known prompt', () => {
    expect(isCodexInternalSubroutine({
      model: 'gpt-5.4-mini',
      prompt: 'You are an expert at upholding safety and compliance standards for Codex ambient suggestions. I will present you with two categories of content...',
      toolCalls: 0,
    })).toBe(true);
  });

  it('flags an unknown internal meta-call via the corroborated heuristic (mini + system-style + no tools)', () => {
    expect(isCodexInternalSubroutine({
      model: 'gpt-5.4-mini',
      prompt: 'You are going to classify the following text into one of two buckets.',
      toolCalls: 0,
    })).toBe(true);
  });

  it('keeps a real coding session (main model, real prompt, tool calls)', () => {
    expect(isCodexInternalSubroutine({
      model: 'gpt-5.5',
      prompt: 'Check what is in this repo',
      toolCalls: 13,
    })).toBe(false);
  });

  it('does not flag a mini-model session that does real work (has tool calls)', () => {
    expect(isCodexInternalSubroutine({
      model: 'gpt-5.4-mini',
      prompt: 'You are helping me — add a README',
      toolCalls: 4,
    })).toBe(false);
  });

  it('does not flag a natural user prompt on a mini model', () => {
    expect(isCodexInternalSubroutine({
      model: 'gpt-5.4-mini',
      prompt: 'fix the failing test in utils',
      toolCalls: 0,
    })).toBe(false);
  });

  it('ignores empty prompts', () => {
    expect(isCodexInternalSubroutine({ model: 'gpt-5.4-mini', prompt: '', toolCalls: 0 })).toBe(false);
  });
});

// user-prompt-submit drops a LIVE prompt only on the anchored
// ambient-safety meta-prompt — never on prompts merely MENTIONING the
// feature, and never on the typeable title/summarize patterns, which stay
// discovery-time-only (full corroboration available).
describe('isKnownCodexInternalPrompt (live-hook guard)', () => {
  it('matches the ambient-suggestion safety filter prompt (anchored at start)', () => {
    expect(isKnownCodexInternalPrompt(
      'You are an expert at upholding safety and compliance standards for Codex ambient suggestions. I will present you with two categories of content...',
    )).toBe(true);
    expect(isKnownCodexInternalPrompt(
      '  \nYou are an expert at upholding safety and compliance standards for X.',
    )).toBe(true); // leading whitespace trimmed before the anchor
  });

  it('does NOT match a user prompt that merely mentions the feature or phrase', () => {
    expect(isKnownCodexInternalPrompt('why do Codex ambient suggestions show up as sessions?')).toBe(false);
    expect(isKnownCodexInternalPrompt(
      'my prompt contains "You are an expert at upholding safety and compliance standards" — why was it dropped?',
    )).toBe(false);
  });

  it('does NOT match typeable meta-shaped prompts (title/summarize)', () => {
    expect(isKnownCodexInternalPrompt('Generate a short title for this PR')).toBe(false);
    expect(isKnownCodexInternalPrompt('Summarize the command output please')).toBe(false);
  });

  it('does NOT match real user prompts, empty, or non-string input', () => {
    expect(isKnownCodexInternalPrompt('fix the failing test in utils')).toBe(false);
    expect(isKnownCodexInternalPrompt('')).toBe(false);
    expect(isKnownCodexInternalPrompt(null)).toBe(false);
    expect(isKnownCodexInternalPrompt(undefined)).toBe(false);
    expect(isKnownCodexInternalPrompt(['You are an expert at upholding safety and compliance standards'] as any)).toBe(false);
    expect(isKnownCodexInternalPrompt({ text: 'x' } as any)).toBe(false);
  });

  it('ambient-mention substring still flags at discovery time via the full predicate', () => {
    expect(isCodexInternalSubroutine({
      model: 'gpt-5.4-mini',
      prompt: '…rules for Codex ambient suggestions apply…',
      toolCalls: 0,
    })).toBe(true);
  });

  it('title/summarize prompts still flag at discovery time via the full predicate', () => {
    expect(isCodexInternalSubroutine({
      model: 'gpt-5.4-mini',
      prompt: 'Generate a short title for the following conversation.',
      toolCalls: 0,
    })).toBe(true);
    expect(isCodexInternalSubroutine({
      model: 'gpt-5.4-mini',
      prompt: 'Summarize the tool output below.',
      toolCalls: 0,
    })).toBe(true);
  });
});
