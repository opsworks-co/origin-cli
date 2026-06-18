/**
 * Tests for the pre-commit budget gate (preCommitBudgetDecision).
 *
 * Why this gate exists: hook-protocol blocking (exit 2 on prompt/tool
 * hooks) only works for Claude Code and Gemini. Codex and Cursor ignore
 * it — user-reported: with all three hard caps breached at 110%, Codex
 * still started locally, edited files, and committed. Git itself honors
 * a non-zero pre-commit exit for EVERY agent, so this decision is the
 * universal choke point that actually stops over-cap work from landing.
 */

import { describe, it, expect } from 'vitest';
import { preCommitBudgetDecision } from '../commands/hooks.js';

const session = (over: Partial<{ sessionId: string; budgetBlocked: boolean; budgetBlockReason: string }>) => ({
  sessionId: 'sess-1',
  budgetBlocked: false,
  budgetBlockReason: undefined as string | undefined,
  ...over,
});

describe('preCommitBudgetDecision', () => {
  it('passes when no sessions exist (plain human commit, no AI session)', () => {
    expect(preCommitBudgetDecision([], undefined).block).toBe(false);
  });

  it('passes when sessions exist but none is budget-blocked', () => {
    const d = preCommitBudgetDecision([session({}), session({ sessionId: 'sess-2' })], undefined);
    expect(d.block).toBe(false);
  });

  it('blocks when any candidate session carries the lockout', () => {
    const d = preCommitBudgetDecision(
      [session({}), session({ sessionId: 'sess-2', budgetBlocked: true, budgetBlockReason: 'Monthly cap at 110%' })],
      undefined,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toContain('Monthly cap at 110%');
    expect(d.reason).toContain('ORIGIN_BUDGET_OVERRIDE=1');
  });

  it('blocks with a generic reason when the state has no message', () => {
    const d = preCommitBudgetDecision([session({ budgetBlocked: true })], undefined);
    expect(d.block).toBe(true);
    expect(d.reason).toContain('hard budget cap exceeded');
  });

  it('the override env is the escape hatch', () => {
    const d = preCommitBudgetDecision([session({ budgetBlocked: true })], '1');
    expect(d.block).toBe(false);
  });

  it('any other override value does not bypass', () => {
    expect(preCommitBudgetDecision([session({ budgetBlocked: true })], '0').block).toBe(true);
    expect(preCommitBudgetDecision([session({ budgetBlocked: true })], 'true').block).toBe(true);
  });
});
