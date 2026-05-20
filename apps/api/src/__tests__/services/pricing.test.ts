/**
 * Tests for the API-side pricing module (apps/api/src/utils/pricing.ts).
 * Mirrors the CLI test suite — both must agree on cost math because the
 * API recomputes costs from token counts and the CLI stamps them at write
 * time. If these drift, dashboard cost ≠ post-recompute cost for the same
 * session, which silently distorts every spend chart.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MODEL_PRICING,
  cacheMultipliersFor,
  estimateCost,
  normalizeModelKey,
  resolveModelPricing,
} from '../../utils/pricing.js';

const ONE_MILLION = 1_000_000;

describe('Anthropic pricing', () => {
  it('Opus charges $15/$75 per 1M', () => {
    expect(estimateCost('claude-opus-4-7', ONE_MILLION, 0)).toBeCloseTo(15, 4);
    expect(estimateCost('claude-opus-4-7', 0, ONE_MILLION)).toBeCloseTo(75, 4);
  });

  it('Sonnet charges $3/$15 per 1M', () => {
    expect(estimateCost('claude-sonnet-4-5', ONE_MILLION, 0)).toBeCloseTo(3, 4);
  });

  it('cache read costs 10% of input on Anthropic', () => {
    expect(estimateCost('claude-opus-4-7', 0, 0, ONE_MILLION, 0)).toBeCloseTo(1.5, 4);
  });

  it('cache write costs 125% of input on Anthropic', () => {
    expect(estimateCost('claude-opus-4-7', 0, 0, 0, ONE_MILLION)).toBeCloseTo(18.75, 4);
  });
});

describe('Gemini pricing + cache', () => {
  it('Gemini 2.5 Pro $1.25/$10 per 1M', () => {
    expect(estimateCost('gemini-2.5-pro', ONE_MILLION, ONE_MILLION)).toBeCloseTo(11.25, 4);
  });

  it('cache read uses 25% of input on Gemini (not 10%)', () => {
    expect(estimateCost('gemini-2.5-pro', 0, 0, ONE_MILLION, 0)).toBeCloseTo(0.3125, 4);
  });

  it('no cache-write surcharge on Gemini', () => {
    expect(estimateCost('gemini-2.5-pro', 0, 0, 0, ONE_MILLION)).toBeCloseTo(1.25, 4);
  });
});

describe('OpenAI / GPT-5 pricing + cache', () => {
  it('GPT-5 charges $2/$8 per 1M', () => {
    expect(estimateCost('gpt-5', ONE_MILLION, ONE_MILLION)).toBeCloseTo(10, 4);
  });

  it('Codex matches GPT-5 pricing', () => {
    expect(estimateCost('codex', ONE_MILLION, 0)).toBeCloseTo(2, 4);
  });

  it('cache read uses 50% of input on OpenAI (not 10%)', () => {
    expect(estimateCost('gpt-5', 0, 0, ONE_MILLION, 0)).toBeCloseTo(1, 4);
  });

  it('no cache-write surcharge on OpenAI', () => {
    expect(estimateCost('gpt-4o', 0, 0, 0, ONE_MILLION)).toBeCloseTo(2.5, 4);
  });
});

describe('normalizeModelKey', () => {
  it('strips Anthropic date suffix', () => {
    expect(normalizeModelKey('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
  });

  it('strips OpenAI ISO date suffix', () => {
    expect(normalizeModelKey('gpt-4o-mini-2024-07-18')).toBe('gpt-4o-mini');
  });

  it('lowercases the model name', () => {
    expect(normalizeModelKey('CLAUDE-OPUS-4')).toBe('claude-opus-4');
  });

  it('handles empty / undefined input', () => {
    expect(normalizeModelKey('')).toBe('');
    expect(normalizeModelKey(undefined as unknown as string)).toBe('');
  });
});

describe('resolveModelPricing', () => {
  it('returns the matched key alongside pricing', () => {
    const r = resolveModelPricing('claude-opus-4');
    expect(r.input).toBe(15);
    expect(r.output).toBe(75);
    expect(r.key).toBe('opus');
  });

  it('exact match wins over substring match', () => {
    const r = resolveModelPricing('gpt-4o-mini');
    expect(r.key).toBe('gpt-4o-mini');
    expect(r.input).toBe(0.15);
  });

  it('falls back to sonnet for unknown models', () => {
    const r = resolveModelPricing('something-weird');
    expect(r.key).toBe('sonnet');
  });
});

describe('cacheMultipliersFor', () => {
  it('Anthropic models get 10%/125%', () => {
    expect(cacheMultipliersFor('sonnet')).toEqual({ read: 0.10, write: 1.25 });
    expect(cacheMultipliersFor('opus')).toEqual({ read: 0.10, write: 1.25 });
    expect(cacheMultipliersFor('haiku')).toEqual({ read: 0.10, write: 1.25 });
    expect(cacheMultipliersFor('cursor')).toEqual({ read: 0.10, write: 1.25 });
  });

  it('Gemini models get 25%/100%', () => {
    expect(cacheMultipliersFor('gemini-2.5-pro')).toEqual({ read: 0.25, write: 1.00 });
    expect(cacheMultipliersFor('gemini-3-flash')).toEqual({ read: 0.25, write: 1.00 });
  });

  it('OpenAI models get 50%/100%', () => {
    expect(cacheMultipliersFor('gpt-5')).toEqual({ read: 0.50, write: 1.00 });
    expect(cacheMultipliersFor('gpt-4o-mini')).toEqual({ read: 0.50, write: 1.00 });
    expect(cacheMultipliersFor('o3-mini')).toEqual({ read: 0.50, write: 1.00 });
    expect(cacheMultipliersFor('codex')).toEqual({ read: 0.50, write: 1.00 });
    expect(cacheMultipliersFor('composer')).toEqual({ read: 0.50, write: 1.00 });
  });
});

describe('DEFAULT_MODEL_PRICING completeness', () => {
  it('contains every model the CLI may stamp on a session', () => {
    // Regression: prevents the "API table is missing keys" silent fallback bug.
    const required = [
      'sonnet', 'opus', 'haiku',
      'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
      'gemini-3-pro', 'gemini-3-flash', 'gemini-2.0-flash', 'gemini-2.0',
      'gpt-4o', 'gpt-4o-mini', 'o1', 'o3', 'o3-mini', 'o4-mini',
      'gpt-5', 'gpt-5.3', 'gpt-5.4', 'codex',
      'cursor', 'composer',
    ];
    for (const key of required) {
      expect(DEFAULT_MODEL_PRICING[key], `missing pricing for "${key}"`).toBeDefined();
    }
  });
});
