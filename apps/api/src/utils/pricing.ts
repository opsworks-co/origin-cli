// Single source of truth for model pricing on the API side.
// Mirrors packages/cli/src/transcript.ts DEFAULT_MODEL_PRICING — when one
// changes, the other should too. A CI sync check would be nice; for now,
// the comment is the contract. The CLI tarball is distributed standalone,
// which is why its copy lives there and isn't a dependency of this file.

export type ModelPricing = Record<string, { input: number; output: number }>;

// Cache multipliers per provider. Anthropic cache reads cost 10% of input
// and cache writes cost 125% of input; other providers differ. Applied in
// estimateCost() based on a normalized provider lookup, falling back to
// Anthropic rates (which is what the legacy code did unconditionally).
//
// Sources (2026 public pricing):
//   • Anthropic — read 0.10×, write 1.25×
//   • Google Gemini — implicit cache reads 0.25×, no write surcharge
//   • OpenAI — cache reads 0.50×, no write surcharge
export interface CacheMultipliers {
  read: number;    // applied to (cacheReadTokens / 1M) × pricing.input
  write: number;   // applied to (cacheCreationTokens / 1M) × pricing.input
}

const ANTHROPIC_CACHE: CacheMultipliers = { read: 0.10, write: 1.25 };
const GEMINI_CACHE: CacheMultipliers    = { read: 0.25, write: 1.00 };
const OPENAI_CACHE: CacheMultipliers    = { read: 0.50, write: 1.00 };

export function cacheMultipliersFor(modelKey: string): CacheMultipliers {
  if (modelKey.startsWith('gemini')) return GEMINI_CACHE;
  if (modelKey.startsWith('gpt-') || modelKey.startsWith('o1') ||
      modelKey.startsWith('o3') || modelKey.startsWith('o4') ||
      modelKey === 'codex' || modelKey === 'composer') return OPENAI_CACHE;
  return ANTHROPIC_CACHE; // sonnet / opus / haiku / cursor (Anthropic-by-default)
}

export const DEFAULT_MODEL_PRICING: ModelPricing = {
  // Anthropic
  'sonnet': { input: 3,    output: 15 },
  'opus':   { input: 15,   output: 75 },
  'haiku':  { input: 0.80, output: 4  },
  // Google
  'gemini-2.5-pro':        { input: 1.25, output: 10 },
  'gemini-2.5-flash':      { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-3-pro':          { input: 1.25, output: 10 },
  'gemini-3-flash':        { input: 0.15, output: 0.60 },
  'gemini-2.0-flash':      { input: 0.10, output: 0.40 },
  'gemini-2.0':            { input: 0.10, output: 0.40 },
  // OpenAI
  'gpt-4o':      { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'o1':          { input: 15,   output: 60 },
  'o3':          { input: 10,   output: 40 },
  'o3-mini':     { input: 1.10, output: 4.40 },
  'o4-mini':     { input: 1.10, output: 4.40 },
  // OpenAI GPT-5 / Codex
  'gpt-5':    { input: 2.00, output: 8.00 },
  'gpt-5.3':  { input: 2.00, output: 8.00 },
  'gpt-5.4':  { input: 3.00, output: 12.00 },
  'codex':    { input: 2.00, output: 8.00 },
  // Cursor — fallback when getCursorModelFromDb can't resolve the real model
  'cursor':   { input: 3,    output: 15 },
  'composer': { input: 2.50, output: 10.00 },
};

// Strip date/version suffixes so "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5"
// and "gpt-4o-mini-2024-07-18" → "gpt-4o-mini".
export function normalizeModelKey(model: string): string {
  return (model || '')
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')   // OpenAI: gpt-4o-mini-2024-07-18
    .replace(/-\d{8}$/, '');               // Anthropic: claude-sonnet-4-5-20250929
}

// Pick the pricing row + cache multipliers for a model. Strategy:
//   1. Exact match on normalized model key
//   2. Longest pricing key that is a substring of the normalized model
//   3. Sonnet default
export function resolveModelPricing(
  model: string,
  pricing: ModelPricing = DEFAULT_MODEL_PRICING,
): { input: number; output: number; key: string } {
  const normalized = normalizeModelKey(model);
  if (pricing[normalized]) return { ...pricing[normalized], key: normalized };

  const sortedKeys = Object.keys(pricing).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (normalized.includes(key)) return { ...pricing[key], key };
  }
  return { ...(pricing['sonnet'] ?? DEFAULT_MODEL_PRICING['sonnet']), key: 'sonnet' };
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheCreationTokens: number = 0,
  pricing: ModelPricing = DEFAULT_MODEL_PRICING,
): number {
  const { input, output, key } = resolveModelPricing(model, pricing);
  const multipliers = cacheMultipliersFor(key);
  const inputCost         = (inputTokens         / 1_000_000) * input;
  const outputCost        = (outputTokens        / 1_000_000) * output;
  const cacheReadCost     = (cacheReadTokens     / 1_000_000) * (input * multipliers.read);
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * (input * multipliers.write);
  return parseFloat((inputCost + outputCost + cacheReadCost + cacheCreationCost).toFixed(4));
}
