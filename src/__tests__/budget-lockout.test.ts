/**
 * Tests for budgetLockoutDecision — the hook-level hard-cap gate.
 *
 * Layer-1 budget enforcement: when the org breaches a hard (block:true)
 * cap, the server reports it on session PATCH responses and heartbeat
 * pings, the CLI persists the flag in session state, and the hooks turn
 * it into decisions: block (exit 2) for agents whose hook protocol
 * honors blocking exits, a stderr warning for the rest.
 */

import { describe, it, expect } from 'vitest';
import { budgetLockoutDecision } from '../commands/hooks.js';

describe('budgetLockoutDecision', () => {
  it('passes through when not blocked', () => {
    const d = budgetLockoutDecision({ budgetBlocked: false, agentSlug: 'claude-code' });
    expect(d).toEqual({ block: false, warn: false, reason: '' });
    expect(budgetLockoutDecision({ agentSlug: 'claude-code' }).block).toBe(false);
  });

  it('blocks Claude Code and Gemini (exit-2 capable hook protocols)', () => {
    for (const slug of ['claude-code', 'gemini', 'Claude-Code']) {
      const d = budgetLockoutDecision({ budgetBlocked: true, agentSlug: slug });
      expect(d.block).toBe(true);
      expect(d.warn).toBe(false);
    }
  });

  it('warns (does not block) for Cursor and Codex', () => {
    for (const slug of ['cursor', 'codex']) {
      const d = budgetLockoutDecision({ budgetBlocked: true, agentSlug: slug });
      expect(d.block).toBe(false);
      expect(d.warn).toBe(true);
      expect(d.reason).toContain('[Origin Budget]');
    }
  });

  it('defaults to blocking when the agent slug is unknown/missing', () => {
    // Missing slug ⇒ assume claude-code (the dominant agent and the one
    // whose hooks invoked us without a slug in older configs).
    expect(budgetLockoutDecision({ budgetBlocked: true }).block).toBe(true);
  });

  it('ORIGIN_BUDGET_OVERRIDE=1 downgrades a block to a warning', () => {
    const d = budgetLockoutDecision({
      budgetBlocked: true,
      agentSlug: 'claude-code',
      overrideEnv: '1',
    });
    expect(d.block).toBe(false);
    expect(d.warn).toBe(true);
  });

  it('includes the server-provided reason and the override hint', () => {
    const d = budgetLockoutDecision({
      budgetBlocked: true,
      budgetBlockReason: 'Daily limit exceeded ($230.00 / $220.00)',
      agentSlug: 'claude-code',
    });
    expect(d.reason).toContain('Daily limit exceeded ($230.00 / $220.00)');
    expect(d.reason).toContain('ORIGIN_BUDGET_OVERRIDE=1');
  });
});
