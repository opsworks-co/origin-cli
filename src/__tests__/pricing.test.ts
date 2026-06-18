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

describe('Anthropic Opus pricing — per generation: 4.5+ is $5/$25, 4.1 and older $15/$75', () => {
  it('charges $5 per million input tokens for modern (4.5+) opus variants', () => {
    expect(estimateCost('claude-opus-4-5', ONE_MILLION, 0)).toBeCloseTo(5, 4);
    expect(estimateCost('claude-opus-4-6', ONE_MILLION, 0)).toBeCloseTo(5, 4);
    expect(estimateCost('claude-opus-4-7', ONE_MILLION, 0)).toBeCloseTo(5, 4);
    expect(estimateCost('claude-opus-4-8', ONE_MILLION, 0)).toBeCloseTo(5, 4);
  });

  it('charges $25 per million output tokens for modern (4.5+) opus variants', () => {
    expect(estimateCost('claude-opus-4-8', 0, ONE_MILLION)).toBeCloseTo(25, 4);
    expect(estimateCost('claude-opus-4-7', 0, ONE_MILLION)).toBeCloseTo(25, 4);
  });

  it('charges legacy $15/$75 for Opus 4.1 and Claude 3 Opus', () => {
    expect(estimateCost('claude-opus-4-1', ONE_MILLION, 0)).toBeCloseTo(15, 4);
    expect(estimateCost('claude-opus-4-1-20250805', 0, ONE_MILLION)).toBeCloseTo(75, 4);
    expect(estimateCost('claude-3-opus-20240229', ONE_MILLION, 0)).toBeCloseTo(15, 4);
  });

  it('regression: a million modern Opus input tokens must NOT cost $15 (the legacy rate)', () => {
    expect(estimateCost('claude-opus-4-7', ONE_MILLION, 0)).not.toBeCloseTo(15, 1);
  });

  it('regression: a million modern Opus output tokens must NOT cost $75 (the legacy rate)', () => {
    expect(estimateCost('claude-opus-4-7', 0, ONE_MILLION)).not.toBeCloseTo(75, 1);
  });
});

describe('Anthropic Fable 5 pricing — $10/$50, not the bare-claude fallback', () => {
  it('charges $10 per million input tokens', () => {
    expect(estimateCost('claude-fable-5', ONE_MILLION, 0)).toBeCloseTo(10, 4);
  });

  it('charges $50 per million output tokens', () => {
    expect(estimateCost('claude-fable-5', 0, ONE_MILLION)).toBeCloseTo(50, 4);
  });

  it('charges cache reads at 10% of input ($1.00/M) and writes at 125% ($12.50/M)', () => {
    expect(estimateCost('claude-fable-5', 0, 0, ONE_MILLION, 0)).toBeCloseTo(1.0, 4);
    expect(estimateCost('claude-fable-5', 0, 0, 0, ONE_MILLION)).toBeCloseTo(12.5, 4);
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

describe('Anthropic Haiku pricing — per generation: 4.5 is $1/$5, 3.5/4.0 $0.80/$4', () => {
  it('charges $1/$5 per million tokens for Haiku 4.5', () => {
    expect(estimateCost('claude-haiku-4-5', ONE_MILLION, 0)).toBeCloseTo(1, 4);
    expect(estimateCost('claude-haiku-4-5-20251001', ONE_MILLION, 0)).toBeCloseTo(1, 4);
    expect(estimateCost('claude-haiku-4-5', 0, ONE_MILLION)).toBeCloseTo(5, 4);
  });

  it('charges legacy $0.80/$4 for older Haiku variants', () => {
    expect(estimateCost('claude-haiku-3-5', ONE_MILLION, 0)).toBeCloseTo(0.8, 4);
    expect(estimateCost('claude-haiku-3-5', 0, ONE_MILLION)).toBeCloseTo(4, 4);
  });

  it('regression: a million Haiku 4.5 input tokens must NOT cost $0.80 (the legacy rate)', () => {
    expect(estimateCost('claude-haiku-4-5', ONE_MILLION, 0)).not.toBeCloseTo(0.8, 1);
  });
});

describe('cache pricing semantics', () => {
  it('charges cache reads at 10% of input price (modern Opus: $0.50/M)', () => {
    // 1M cache-read tokens on Opus 4.7 → 0.1 × $5 = $0.50
    expect(estimateCost('claude-opus-4-7', 0, 0, ONE_MILLION, 0)).toBeCloseTo(0.5, 4);
  });

  it('charges cache writes at 125% of input price (modern Opus: $6.25/M)', () => {
    // 1M cache-creation tokens on Opus 4.7 → 1.25 × $5 = $6.25
    expect(estimateCost('claude-opus-4-7', 0, 0, 0, ONE_MILLION)).toBeCloseTo(6.25, 4);
  });

  it('totals input + output + cache reads + cache writes correctly', () => {
    // Mixed Opus 4.7 session: 100K input + 10K output + 500K cache read + 50K cache write
    // = (0.1 × 5) + (0.01 × 25) + (0.5 × 0.5) + (0.05 × 6.25)
    // = 0.5 + 0.25 + 0.25 + 0.3125 = 1.3125
    expect(
      estimateCost('claude-opus-4-7', 100_000, 10_000, 500_000, 50_000),
    ).toBeCloseTo(1.3125, 4);
  });
});

describe('default pricing table snapshot', () => {
  // If anyone ever tries to silently change Anthropic rates again, this fails.
  it('Opus baseline rates match Anthropic public pricing per generation', () => {
    const pricing = getDefaultPricing();
    expect(pricing['opus']).toEqual({ input: 5, output: 25 });        // Opus 4.5+
    expect(pricing['opus-4-1']).toEqual({ input: 15, output: 75 });   // legacy
    expect(pricing['3-opus']).toEqual({ input: 15, output: 75 });     // legacy
  });

  it('Fable 5 baseline rates match Anthropic public pricing', () => {
    const pricing = getDefaultPricing();
    expect(pricing['fable']).toEqual({ input: 10, output: 50 });
  });

  it('Sonnet baseline rates match Anthropic public pricing', () => {
    const pricing = getDefaultPricing();
    expect(pricing['sonnet']).toEqual({ input: 3, output: 15 });
  });

  it('Haiku baseline rates match Anthropic public pricing per generation', () => {
    const pricing = getDefaultPricing();
    expect(pricing['haiku']).toEqual({ input: 0.80, output: 4 });      // Haiku 3.5 / 4.0
    expect(pricing['haiku-4-5']).toEqual({ input: 1.00, output: 5 });  // Haiku 4.5
  });
});

describe('Google Gemini pricing', () => {
  it('Gemini 2.5 Pro charges $1.25 input / $10 output per 1M', () => {
    expect(estimateCost('gemini-2.5-pro', ONE_MILLION, 0)).toBeCloseTo(1.25, 4);
    expect(estimateCost('gemini-2.5-pro', 0, ONE_MILLION)).toBeCloseTo(10, 4);
  });

  it('Gemini 2.5 Flash charges $0.30 input / $2.50 output per 1M', () => {
    expect(estimateCost('gemini-2.5-flash', ONE_MILLION, 0)).toBeCloseTo(0.30, 4);
    expect(estimateCost('gemini-2.5-flash', 0, ONE_MILLION)).toBeCloseTo(2.50, 4);
  });

  it('Gemini 2.5 Flash Lite is cheaper than Flash (not the same)', () => {
    const flash = estimateCost('gemini-2.5-flash', ONE_MILLION, 0);
    const lite = estimateCost('gemini-2.5-flash-lite', ONE_MILLION, 0);
    expect(lite).toBeLessThan(flash);
    expect(lite).toBeCloseTo(0.10, 4);
  });

  it('uses Gemini cache discount (0.25×) not Anthropic (0.10×)', () => {
    // 1M cache-read on Gemini 2.5 Pro → 0.25 × $1.25 = $0.3125
    expect(estimateCost('gemini-2.5-pro', 0, 0, ONE_MILLION, 0)).toBeCloseTo(0.3125, 4);
  });

  it('does NOT surcharge cache writes on Gemini', () => {
    // Gemini has no cache-creation premium — multiplier is 1.0×, not 1.25×
    expect(estimateCost('gemini-2.5-pro', 0, 0, 0, ONE_MILLION)).toBeCloseTo(1.25, 4);
  });
});

describe('OpenAI GPT-5 / Codex pricing', () => {
  it('GPT-5 charges $2 input / $8 output per 1M', () => {
    expect(estimateCost('gpt-5', ONE_MILLION, 0)).toBeCloseTo(2, 4);
    expect(estimateCost('gpt-5', 0, ONE_MILLION)).toBeCloseTo(8, 4);
  });

  it('GPT-5.4 charges $3 input / $12 output per 1M', () => {
    expect(estimateCost('gpt-5.4', ONE_MILLION, 0)).toBeCloseTo(3, 4);
    expect(estimateCost('gpt-5.4', 0, ONE_MILLION)).toBeCloseTo(12, 4);
  });

  it('Codex prices identically to GPT-5', () => {
    expect(estimateCost('codex', ONE_MILLION, 0)).toBeCloseTo(2, 4);
    expect(estimateCost('codex', 0, ONE_MILLION)).toBeCloseTo(8, 4);
  });

  it('GPT-4o-mini matches longer key before GPT-4o', () => {
    // Substring matching could mis-route gpt-4o-mini → gpt-4o ($2.50). Longest-key
    // sort prevents that; this test pins the contract.
    expect(estimateCost('gpt-4o-mini', ONE_MILLION, 0)).toBeCloseTo(0.15, 4);
  });

  it('strips ISO date suffixes: gpt-4o-2024-08-06 prices as gpt-4o', () => {
    expect(estimateCost('gpt-4o-2024-08-06', ONE_MILLION, 0)).toBeCloseTo(2.50, 4);
  });

  it('uses OpenAI cache discount (0.50×) not Anthropic (0.10×)', () => {
    // 1M cache-read on GPT-5 → 0.50 × $2 = $1.00 (not $0.20 if Anthropic rate)
    expect(estimateCost('gpt-5', 0, 0, ONE_MILLION, 0)).toBeCloseTo(1.0, 4);
  });
});

describe('model name normalization', () => {
  it('strips Anthropic date suffix: claude-sonnet-4-5-20250929 → sonnet pricing', () => {
    expect(estimateCost('claude-sonnet-4-5-20250929', ONE_MILLION, 0)).toBeCloseTo(3, 4);
  });

  it('unknown model defaults to sonnet pricing, not zero', () => {
    expect(estimateCost('unknown-model-xyz', ONE_MILLION, 0)).toBeCloseTo(3, 4);
  });

  it('empty model string defaults to sonnet pricing', () => {
    expect(estimateCost('', ONE_MILLION, 0)).toBeCloseTo(3, 4);
  });
});
