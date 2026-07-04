import { describe, it, expect } from 'vitest';
import { isCodexInternalSubroutine } from '../commands/hooks.js';

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
