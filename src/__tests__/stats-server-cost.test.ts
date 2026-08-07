// `origin stats` per-model Cost reconciliation. Local git notes only carry
// per-commit token counts for agents that surface them per-turn (Codex), so
// Claude / Gemini / Cursor / Devin priced to $0 even though the server captured
// their real session cost. resolveServerCost joins the server's costByModel into
// the acceptance table, with a brand fallback for bare-brand git-note models.
import { describe, it, expect } from 'vitest';
import { resolveServerCost, type ServerModelCost } from '../commands/stats.js';

const SERVER: ServerModelCost[] = [
  { model: 'gemini-3.1-pro', cost: 0.06 },
  { model: 'cursor-grok-4.5-high-fast', cost: 0.02 },
  { model: 'gpt-5.6-terra', cost: 0.13 },
  { model: 'claude-opus-5', cost: 8.59 },
  { model: 'claude-opus-4-8', cost: 22.58 },
];

describe('resolveServerCost', () => {
  it('exact model match', () => {
    expect(resolveServerCost('gemini-3.1-pro', SERVER)).toBe(0.06);
    expect(resolveServerCost('cursor-grok-4.5-high-fast', SERVER)).toBe(0.02);
    expect(resolveServerCost('gpt-5.6-terra', SERVER)).toBe(0.13);
  });

  it('is case-insensitive', () => {
    expect(resolveServerCost('GPT-5.6-Terra', SERVER)).toBe(0.13);
  });

  it('brand fallback: bare "claude" sums every specific claude-* model', () => {
    expect(resolveServerCost('claude', SERVER)).toBeCloseTo(8.59 + 22.58, 5);
  });

  it('returns undefined when the server has no matching model', () => {
    expect(resolveServerCost('devin', SERVER)).toBeUndefined();
    expect(resolveServerCost('gemini-3.1-pro', [])).toBeUndefined();
    expect(resolveServerCost('gemini-3.1-pro', undefined)).toBeUndefined();
  });

  it('does not cross brands (grok ≠ gpt)', () => {
    expect(resolveServerCost('gpt-5.5', SERVER)).toBeUndefined();
  });
});
