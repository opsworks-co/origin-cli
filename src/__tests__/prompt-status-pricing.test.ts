import { describe, it, expect, beforeEach } from 'vitest';
import { estimateCostFromTokens } from '../commands/prompt-status.js';
import { estimateCost, __resetActivePricingForTests } from '../transcript.js';

const M = 1_000_000;

describe('prompt-status live cost', () => {
  beforeEach(() => __resetActivePricingForTests());

  it('prices Claude 5.x models at their own rates, not the Sonnet default', () => {
    expect(estimateCostFromTokens('claude-opus-5-5', M, M)).toBeCloseTo(24, 4); // $4 + $20
    expect(estimateCostFromTokens('claude-fable-5-2', M, M)).toBeCloseTo(48, 4); // $8 + $40
    expect(estimateCostFromTokens('claude-fable-5-2', 0, 0, M)).toBeCloseTo(0.2, 4);
    expect(estimateCostFromTokens('claude-sonnet-5-5', M, M)).toBeCloseTo(12, 4);
    expect(estimateCostFromTokens('claude-haiku-5-5', M, M)).toBeCloseTo(0.6, 4);
  });

  it('agrees with the shared CLI price table for every model', () => {
    for (const model of ['claude-opus-4-8', 'claude-opus-5', 'claude-fable-5-1', 'claude-mythos-5-2', 'gpt-5.5', 'claude-opus-5-5[1m]']) {
      expect(estimateCostFromTokens(model, 120_000, 40_000, 3_000_000, 90_000))
        .toBe(estimateCost(model, 120_000, 40_000, 3_000_000, 90_000));
    }
  });
});
