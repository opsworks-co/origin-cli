// ─── Budget-breach reaction: notify + terminate ─────────────────────────────
//
// When the org breaches a HARD budget cap, the server reports
// `budget: { blocked: true, message }` on every heartbeat ping. The
// existing lockout already blocks new prompts/tool calls via hooks
// (see enforceBudgetLockout in commands/hooks.ts); this module adds the
// user-facing half the lockout was missing:
//
//   1. NOTIFY — a desktop notification the moment the breach is first
//      seen, so the user learns about it from the OS instead of from a
//      confusing failed prompt.
//   2. TERMINATE — the heartbeat ends the session shortly after, once
//      it's safe (see below), so breached orgs don't keep half-alive
//      RUNNING sessions on the dashboard and every agent stops cleanly
//      at the same point.
//
// Termination is NOT immediate. Two conditions must both hold, each for
// its own reason:
//
//   • the breach must have stood for ≥ GRACE — gives the heartbeat's
//     next ping (and hook-side server re-checks) a chance to observe an
//     admin raising the cap, so a cap bumped within a minute of the
//     breach never kills anyone's session;
//   • the session must have been QUIET (no state-file writes) for ≥
//     QUIET — state mtime is bumped by every lifecycle hook, so quiet
//     means no in-flight turn. This matters most for agents whose hook
//     protocol can't block (Cursor/Codex): yanking the state file
//     mid-turn would stop TRACKING work that is still happening, which
//     is worse than tracking slightly past the cap.
//
// After termination the lockout still holds: the next prompt's
// session/start returns the breach in its `budget` payload (over-budget
// sessions are tracked-with-warning, not refused) and the fresh state is
// created with budgetBlocked=true — so the gates keep blocking until the
// cap resets.

import fs from 'fs';
import path from 'path';

export const BUDGET_END_GRACE_MS = 60_000;
export const BUDGET_END_QUIET_MS = 60_000;

// Agents whose hook protocol honors exit-2 blocking. For these, the
// prompt/tool gates stop the agent loop, so terminating the Origin
// session on a breach loses nothing. Codex and Cursor IGNORE blocking
// exits — their sessions are deliberately kept ALIVE while breached so
// the continued burn stays tracked (and badged) on the dashboard; the
// git pre-commit gate is what stops their work from landing.
export const BUDGET_BLOCKING_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'gemini']);

// Tracked per breach EPISODE (process-local in the heartbeat daemon —
// a daemon restart re-notifying once is acceptable; persisting flags in
// the state file would bump the mtime the quiet check reads).
export interface BudgetBreachState {
  firstSeenMs: number;
}

export interface BudgetBreachDecision {
  // Carry-forward episode state; null when the breach has lifted.
  state: BudgetBreachState | null;
  // First tick of a new episode — send the "budget exceeded" notification.
  notifyDue: boolean;
  // Grace + quiet both satisfied — end the session now.
  terminateDue: boolean;
}

/**
 * Pure per-tick decision. `lastActivityMs` is the state file's mtime
 * (epoch ms) — the same liveness signal the stale check and
 * SESSION_LIMITS use.
 */
export function evaluateBudgetBreach(
  prev: BudgetBreachState | null,
  blocked: boolean,
  lastActivityMs: number,
  nowMs: number,
): BudgetBreachDecision {
  if (!blocked) {
    // Lifted (cap raised, period reset) — clear the episode so a future
    // breach notifies again.
    return { state: null, notifyDue: false, terminateDue: false };
  }
  if (!prev) {
    // New episode. Never terminate on the first observation — the
    // grace window starts now.
    return { state: { firstSeenMs: nowMs }, notifyDue: true, terminateDue: false };
  }
  const graceSatisfied = nowMs - prev.firstSeenMs >= BUDGET_END_GRACE_MS;
  const quietSatisfied =
    lastActivityMs > 0 && nowMs - lastActivityMs >= BUDGET_END_QUIET_MS;
  return { state: prev, notifyDue: false, terminateDue: graceSatisfied && quietSatisfied };
}

// ─── AGENTS.md lockout notice ───────────────────────────────────────────────
//
// Model-facing soft enforcement for agents whose hook protocols can't
// block (Codex reads AGENTS.md natively; Cursor honors it too). While a
// hard cap is breached, a marked block is appended to the repo's
// AGENTS.md telling the MODEL to stop working and explain why — so Codex
// itself refuses to continue instead of failing mysteriously at commit
// time. Removed the moment the lockout lifts. Markers keep the block
// idempotent and independent of Origin's main origin-managed section.

const BUDGET_NOTICE_MARKER = '<!-- origin-budget-lock -->';

function buildBudgetNotice(reason: string): string {
  return [
    BUDGET_NOTICE_MARKER,
    '# ⛔ BUDGET LOCK — STOP: DO NOT PERFORM FURTHER WORK',
    '',
    `Your team's AI budget hard cap has been exceeded (${reason}).`,
    'Origin policy is now in effect for this repository:',
    '- Do NOT edit files, run commands, or create commits.',
    '- Commits are blocked by a git pre-commit hook; do not attempt to bypass it.',
    '- Tell the user: "The team\'s AI budget cap is exceeded — work is locked until',
    '  the cap resets or an admin raises it (Origin dashboard → Budgets)."',
    BUDGET_NOTICE_MARKER,
  ].join('\n');
}

/**
 * Write (or refresh) the budget-lock block in <repo>/AGENTS.md.
 * Creates the file when missing — that is the point for Codex, which
 * reads AGENTS.md natively at session start. Best-effort, never throws.
 */
export function writeBudgetLockNotice(repoPath: string | undefined, reason: string): void {
  if (!repoPath) return;
  try {
    const target = path.join(repoPath, 'AGENTS.md');
    const block = buildBudgetNotice(reason);
    let existing = '';
    try { existing = fs.readFileSync(target, 'utf-8'); } catch { /* new file */ }
    if (existing.includes(BUDGET_NOTICE_MARKER)) {
      const re = new RegExp(`${BUDGET_NOTICE_MARKER}[\\s\\S]*?${BUDGET_NOTICE_MARKER}`);
      const updated = existing.replace(re, block);
      if (updated !== existing) fs.writeFileSync(target, updated);
      return;
    }
    // Notice goes FIRST — models weight the top of instruction files, and
    // a stop-work order must not be buried under project conventions.
    fs.writeFileSync(target, existing.trim() ? `${block}\n\n${existing}` : `${block}\n`);
  } catch { /* never break a hook over the notice */ }
}

/** Remove the budget-lock block. Deletes AGENTS.md only when the notice
 *  was its sole content (i.e. we created the file ourselves). */
export function clearBudgetLockNotice(repoPath: string | undefined): void {
  if (!repoPath) return;
  try {
    const target = path.join(repoPath, 'AGENTS.md');
    if (!fs.existsSync(target)) return;
    const existing = fs.readFileSync(target, 'utf-8');
    if (!existing.includes(BUDGET_NOTICE_MARKER)) return;
    const re = new RegExp(`${BUDGET_NOTICE_MARKER}[\\s\\S]*?${BUDGET_NOTICE_MARKER}\\n*`);
    const cleaned = existing.replace(re, '');
    if (cleaned.trim() === '') fs.unlinkSync(target);
    else fs.writeFileSync(target, cleaned);
  } catch { /* best effort */ }
}

/**
 * Loud user-facing banner for the agent's INITIAL SCREEN when a session
 * starts (or resumes) over a breached hard cap. Channel differs by agent:
 * Claude Code / Gemini render the session-start hook's systemMessage;
 * Codex displays hook stdout lines as warnings. Most of these renderers
 * strip ANSI color, so "red" is delivered with 🔴/⛔ glyphs + caps —
 * they survive every agent's text pipeline.
 */
export function buildBudgetBanner(reason: string): string {
  return [
    '🔴⛔ BUDGET EXCEEDED — AI WORK LOCKED ⛔🔴',
    `${reason}.`,
    'New prompts/commits are blocked until the cap resets or an admin raises it (Origin dashboard → Budgets).',
  ].join('\n');
}

/**
 * Amber variant for SOFT-cap breaches scoped to this developer's lane
 * (their user / agent / repo limit). Informational only — nothing is
 * locked; org-wide soft caps never produce this (admin alerts cover
 * those).
 */
export function buildBudgetWarningBanner(reason: string): string {
  return [
    '🟠⚠️ BUDGET WARNING — SOFT CAP EXCEEDED ⚠️🟠',
    `${reason}.`,
    'Work continues (soft limit) — mind the spend. Details: Origin dashboard → Budgets.',
  ].join('\n');
}
