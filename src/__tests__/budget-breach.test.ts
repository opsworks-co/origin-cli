/**
 * Tests for the budget-breach reaction logic (budget-breach.ts).
 *
 * When a hard budget cap is breached the heartbeat must (1) notify the
 * user once per episode, and (2) end the session — but only after the
 * breach has stood for a grace window (so an immediately-raised cap
 * never kills a session) AND the session is quiet (so a mid-turn agent
 * whose hooks can't block is never yanked while still working).
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateBudgetBreach,
  BUDGET_END_GRACE_MS,
  BUDGET_END_QUIET_MS,
  type BudgetBreachState,
} from '../budget-breach.js';

const T0 = 1_750_000_000_000; // arbitrary fixed epoch

describe('evaluateBudgetBreach', () => {
  it('does nothing while not blocked', () => {
    const d = evaluateBudgetBreach(null, false, T0 - 10_000, T0);
    expect(d).toEqual({ state: null, notifyDue: false, terminateDue: false });
  });

  it('notifies exactly once at the start of an episode, never terminating on first sight', () => {
    const first = evaluateBudgetBreach(null, true, T0 - 10_000, T0);
    expect(first.notifyDue).toBe(true);
    expect(first.terminateDue).toBe(false);
    expect(first.state).toEqual({ firstSeenMs: T0 });

    // Next tick, still blocked — no second notification.
    const second = evaluateBudgetBreach(first.state, true, T0 - 10_000, T0 + 30_000);
    expect(second.notifyDue).toBe(false);
  });

  it('terminates only when BOTH grace and quiet windows are satisfied', () => {
    const episode: BudgetBreachState = { firstSeenMs: T0 };

    // Grace satisfied, but the session is mid-turn (fresh activity) → hold.
    const busy = evaluateBudgetBreach(
      episode, true, T0 + BUDGET_END_GRACE_MS - 5_000, T0 + BUDGET_END_GRACE_MS,
    );
    expect(busy.terminateDue).toBe(false);

    // Quiet satisfied, but inside the grace window → hold (admin may
    // still raise the cap).
    const early = evaluateBudgetBreach(
      episode, true, T0 - BUDGET_END_QUIET_MS, T0 + BUDGET_END_GRACE_MS - 1_000,
    );
    expect(early.terminateDue).toBe(false);

    // Both satisfied → terminate.
    const now = T0 + BUDGET_END_GRACE_MS;
    const due = evaluateBudgetBreach(episode, true, now - BUDGET_END_QUIET_MS, now);
    expect(due.terminateDue).toBe(true);
  });

  it('clears the episode when the breach lifts, so the next breach notifies again', () => {
    const episode: BudgetBreachState = { firstSeenMs: T0 };
    const lifted = evaluateBudgetBreach(episode, false, T0, T0 + 60_000);
    expect(lifted.state).toBeNull();
    expect(lifted.terminateDue).toBe(false);

    // Cap breached again later — fresh episode, fresh notification,
    // fresh grace window.
    const again = evaluateBudgetBreach(lifted.state, true, T0, T0 + 120_000);
    expect(again.notifyDue).toBe(true);
    expect(again.state?.firstSeenMs).toBe(T0 + 120_000);
  });

  it('never terminates without a known activity timestamp', () => {
    // mtime unreadable (0) — refuse to terminate rather than guess the
    // session is quiet.
    const episode: BudgetBreachState = { firstSeenMs: T0 };
    const d = evaluateBudgetBreach(episode, true, 0, T0 + 10 * BUDGET_END_GRACE_MS);
    expect(d.terminateDue).toBe(false);
  });
});

// ─── AGENTS.md lockout notice ───────────────────────────────────────────────

import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeBudgetLockNotice, clearBudgetLockNotice } from '../budget-breach.js';

describe('AGENTS.md budget-lock notice', () => {
  const mkRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'origin-notice-'));
  const read = (repo: string) => {
    try { return fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8'); } catch { return null; }
  };

  it('creates AGENTS.md with the stop-work block when the file is missing', () => {
    const repo = mkRepo();
    try {
      writeBudgetLockNotice(repo, 'Monthly cap at 110%');
      const content = read(repo)!;
      expect(content).toContain('BUDGET LOCK');
      expect(content).toContain('Monthly cap at 110%');
      expect(content).toContain('Do NOT edit files');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('prepends the block to an existing AGENTS.md without destroying user content', () => {
    const repo = mkRepo();
    try {
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Project conventions\nUse tabs.\n');
      writeBudgetLockNotice(repo, 'cap breached');
      const content = read(repo)!;
      expect(content.indexOf('BUDGET LOCK')).toBeLessThan(content.indexOf('Project conventions'));
      expect(content).toContain('Use tabs.');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('is idempotent — re-writing refreshes the block instead of stacking copies', () => {
    const repo = mkRepo();
    try {
      writeBudgetLockNotice(repo, 'first reason');
      writeBudgetLockNotice(repo, 'second reason');
      const content = read(repo)!;
      expect(content.match(/BUDGET LOCK/g)!.length).toBe(1);
      expect(content).toContain('second reason');
      expect(content).not.toContain('first reason');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('clear removes the block and preserves user content', () => {
    const repo = mkRepo();
    try {
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Conventions\n');
      writeBudgetLockNotice(repo, 'cap breached');
      clearBudgetLockNotice(repo);
      const content = read(repo)!;
      expect(content).not.toContain('BUDGET LOCK');
      expect(content).toContain('Conventions');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('clear deletes the file entirely when the notice was its only content', () => {
    const repo = mkRepo();
    try {
      writeBudgetLockNotice(repo, 'cap breached');
      clearBudgetLockNotice(repo);
      expect(read(repo)).toBeNull();
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('clear is a no-op on files without the marker and on missing repos', () => {
    const repo = mkRepo();
    try {
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Untouched\n');
      clearBudgetLockNotice(repo);
      expect(read(repo)).toBe('# Untouched\n');
      clearBudgetLockNotice(undefined);
      clearBudgetLockNotice('/nonexistent/path/xyz');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});
