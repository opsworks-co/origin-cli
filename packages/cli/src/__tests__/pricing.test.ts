/**
 * Tests for cost estimation against Anthropic's published pricing.
 *
 * Pricing in transcript.ts is the source of truth for what the dashboard
 * shows as "session cost." A drift here silently understates AI spend
 * for every Origin user, which is the kind of bug that destroys trust the
 * moment someone cross-checks Origin against their actual API invoice.
 *
 * Reference: https://www.anthropic.com/pricing  (verified 2026-04-24)
 */

import { describe, it, expect } from 'vitest';
import { estimateCost, getDefaultPricing } from '../transcript.js';

const ONE_MILLION = 1_000_000;

describe('Anthropic Opus pricing — was undercounted by 3× (was $5/$25, should be $15/$75)', () => {
  it('charges $15 per million input tokens for any opus variant', () => {
    expect(estimateCost('claude-opus-4', ONE_MILLION, 0)).toBeCloseTo(15, 4);
    expect(estimateCost('claude-opus-4-5', ONE_MILLION, 0)).toBeCloseTo(15, 4);
    expect(estimateCost('claude-opus-4-6', ONE_MILLION, 0)).toBeCloseTo(15, 4);
    expect(estimateCost('claude-opus-4-7', ONE_MILLION, 0)).toBeCloseTo(15, 4);
  });

  it('charges $75 per million output tokens for any opus variant', () => {
    expect(estimateCost('claude-opus-4', 0, ONE_MILLION)).toBeCloseTo(75, 4);
    expect(estimateCost('claude-opus-4-7', 0, ONE_MILLION)).toBeCloseTo(75, 4);
  });

  it('regression: a million Opus input tokens must NOT cost $5 (the old wrong value)', () => {
    expect(estimateCost('claude-opus-4-7', ONE_MILLION, 0)).not.toBeCloseTo(5, 1);
  });

  it('regression: a million Opus output tokens must NOT cost $25 (the old wrong value)', () => {
    expect(estimateCost('claude-opus-4-7', 0, ONE_MILLION)).not.toBeCloseTo(25, 1);
  });
});

describe('Anthropic Sonnet pricing', () => {
  it('charges $3 per million input tokens', () => {
    expect(estimateCost('claude-sonnet-4', ONE_MILLION, 0)).toBeCloseTo(3, 4);
    expect(estimateCost('claude-sonnet-4-5', ONE_MILLION, 0)).toBeCloseTo(3, 4);
  });

  it('charges $15 per million output tokens', () => {
    expect(estimateCost('claude-sonnet-4-5', 0, ONE_MILLION)).toBeCloseTo(15, 4);
  });
});

describe('cache pricing semantics', () => {
  it('charges cache reads at 10% of input price (Opus: $1.50/M)', () => {
    // 1M cache-read tokens on Opus → 0.1 × $15 = $1.50
    expect(estimateCost('claude-opus-4-7', 0, 0, ONE_MILLION, 0)).toBeCloseTo(1.5, 4);
  });

  it('charges cache writes at 125% of input price (Opus: $18.75/M)', () => {
    // 1M cache-creation tokens on Opus → 1.25 × $15 = $18.75
    expect(estimateCost('claude-opus-4-7', 0, 0, 0, ONE_MILLION)).toBeCloseTo(18.75, 4);
  });

  it('totals input + output + cache reads + cache writes correctly', () => {
    // Mixed Opus session: 100K input + 10K output + 500K cache read + 50K cache write
    // = (0.1 × 15) + (0.01 × 75) + (0.5 × 1.5) + (0.05 × 18.75)
    // = 1.5 + 0.75 + 0.75 + 0.9375 = 3.9375
    expect(
      estimateCost('claude-opus-4-7', 100_000, 10_000, 500_000, 50_000),
    ).toBeCloseTo(3.9375, 4);
  });
});

describe('default pricing table snapshot', () => {
  // If anyone ever tries to silently lower the Opus price again, this fails.
  it('Opus baseline rates match Anthropic public pricing', () => {
    const pricing = getDefaultPricing();
    expect(pricing['opus']).toEqual({ input: 15, output: 75 });
  });

  it('Sonnet baseline rates match Anthropic public pricing', () => {
    const pricing = getDefaultPricing();
    expect(pricing['sonnet']).toEqual({ input: 3, output: 15 });
  });

  it('Haiku baseline rates match Haiku 3.5 / 4 public pricing', () => {
    const pricing = getDefaultPricing();
    expect(pricing['haiku']).toEqual({ input: 0.80, output: 4 });
  });
});
