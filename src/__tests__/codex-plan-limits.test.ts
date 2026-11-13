import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { codexPlanLimits } from '../agents/codex.js';

const tokenCount = (ts: string, rateLimits: unknown) => JSON.stringify({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1 } }, rate_limits: rateLimits },
});

describe('codexPlanLimits', () => {
  it('reads the plan and both usage windows from the newest token_count', () => {
    const lines = fs.readFileSync(path.join(__dirname, 'fixtures/codex-uncommitted-2-prompts.jsonl'), 'utf-8').split('\n');
    const limits = codexPlanLimits(lines)!;
    expect(limits.planType).toBe('plus');
    expect(limits.windows).toHaveLength(2);
    expect(limits.windows[0]).toMatchObject({ usedPercent: 1, windowMinutes: 300 });
    expect(limits.windows[1]).toMatchObject({ usedPercent: 0, windowMinutes: 10080 });
    expect(limits.windows[0].resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('takes the last report, not the first', () => {
    const limits = codexPlanLimits([
      tokenCount('2026-10-28T10:00:00Z', { plan_type: 'pro', primary: { used_percent: 10, window_minutes: 300, resets_at: 1792677695 } }),
      tokenCount('2026-10-28T11:00:00Z', { plan_type: 'pro', primary: { used_percent: 42, window_minutes: 300, resets_at: 1792677695 } }),
    ])!;
    expect(limits.windows[0].usedPercent).toBe(42);
    expect(limits.capturedAt).toBe('2026-10-28T11:00:00.000Z');
  });

  it('is undefined on an API-key run, which reports no limits', () => {
    expect(codexPlanLimits([tokenCount('2026-10-28T10:00:00Z', null)])).toBeUndefined();
    expect(codexPlanLimits(['not json', ''])).toBeUndefined();
  });
});
