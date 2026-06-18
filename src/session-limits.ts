// ─── SESSION_LIMITS policy — shared evaluation logic ───────────────────────
//
// Team admins can attach a SESSION_LIMITS policy to the org (configured in
// the web UI like every other policy type). Rule condition JSON supports:
//
//   { "idle_notify_minutes": 60 }    — desktop-notify the user once their
//                                      session has been idle this long
//   { "max_idle_minutes": 90 }       — heartbeat auto-ends the session after
//                                      this much idle time (action: block)
//   { "max_duration_minutes": 120 }  — user-prompt-submit blocks new prompts
//                                      once the session is this old
//                                      (action: block; otherwise notify-only)
//
// Why these limits exist: long-lived sessions are the dominant avoidable
// cost pattern. Every idle gap > 5 min kills the prompt cache, so the next
// prompt re-writes the entire accumulated context at 1.25× input price, and
// a context that never resets makes every turn drag hundreds of KTok of
// cache reads behind it. The cheap fix is behavioral — close idle sessions,
// start fresh ones — which is exactly what these limits nudge/enforce.
//
// Split of responsibilities:
//   • heartbeat daemon (heartbeat.ts) — the TIMER. Hooks only fire when the
//     agent does something, so an idle session never triggers them; the
//     heartbeat ticks every 30s regardless. It sends the idle notification
//     and performs the max-idle auto-end.
//   • lifecycle hooks (commands/hooks.ts) — the ENFORCER. user-prompt-submit
//     blocks (exit 2) past max duration. Enforced at prompt boundaries only,
//     never mid-turn, so in-flight work is never cut off.
//
// Like the budget lockout, this is a guardrail, not a security boundary —
// the CLI can't kill the agent's process, only refuse to let Origin-tracked
// work continue and tell the user why.

import { execFile } from 'child_process';

export interface SessionLimitsRule {
  type: string;
  condition: string;
  action: string;
  severity?: string;
}

export interface SessionLimitsConfig {
  idleNotifyMinutes?: number;
  maxIdleMinutes?: number;
  maxDurationMinutes?: number;
  // True when at least one contributing rule has action "block" — only then
  // do we hard-enforce (block prompts / auto-end). warn/notify rules still
  // produce desktop notifications but never interrupt work.
  enforce: boolean;
}

/**
 * Extract a merged SESSION_LIMITS config from a session's enforcementRules.
 * Multiple rules merge strictest-wins (lowest threshold); a single "block"
 * action anywhere makes the whole config enforcing. Returns null when no
 * rule carries a usable limit.
 */
export function parseSessionLimits(
  rules: SessionLimitsRule[] | undefined | null,
): SessionLimitsConfig | null {
  if (!rules || !Array.isArray(rules)) return null;
  const cfg: SessionLimitsConfig = { enforce: false };
  let found = false;

  for (const rule of rules) {
    if (!rule || rule.type !== 'SESSION_LIMITS') continue;
    let cond: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rule.condition);
      if (parsed && typeof parsed === 'object') cond = parsed;
    } catch { continue; }

    const take = (key: string): number | undefined => {
      const v = cond[key];
      return typeof v === 'number' && isFinite(v) && v > 0 ? v : undefined;
    };
    const idleNotify = take('idle_notify_minutes');
    const maxIdle = take('max_idle_minutes');
    const maxDuration = take('max_duration_minutes');
    if (idleNotify === undefined && maxIdle === undefined && maxDuration === undefined) continue;

    found = true;
    const min = (a: number | undefined, b: number | undefined) =>
      a === undefined ? b : b === undefined ? a : Math.min(a, b);
    cfg.idleNotifyMinutes = min(cfg.idleNotifyMinutes, idleNotify);
    cfg.maxIdleMinutes = min(cfg.maxIdleMinutes, maxIdle);
    cfg.maxDurationMinutes = min(cfg.maxDurationMinutes, maxDuration);
    if ((rule.action || '').toLowerCase() === 'block') cfg.enforce = true;
  }

  return found ? cfg : null;
}

export interface SessionLimitsStatus {
  idleMinutes: number;
  ageMinutes: number;
  /** Idle ≥ idle_notify_minutes — heartbeat should desktop-notify (once per idle episode). */
  idleNotifyDue: boolean;
  /** Idle ≥ max_idle_minutes with an enforcing rule — heartbeat should end the session. */
  idleEndDue: boolean;
  /** Age ≥ 85% of max_duration_minutes but under it — heartbeat should warn (once). */
  durationWarnDue: boolean;
  /** Age ≥ max_duration_minutes — notify; hooks block new prompts when enforcing. */
  durationExceeded: boolean;
}

// Warn shortly before the hard duration cap so the user can wrap up
// instead of discovering the block mid-thought.
export const DURATION_WARN_FRACTION = 0.85;

/**
 * Pure evaluation of a session against its limits. `lastActivityMs` is the
 * epoch ms of the last lifecycle-hook activity (in practice: the state
 * file's mtime — bumped by every UserPromptSubmit/PreToolUse/Stop, so it is
 * fresh the whole time the agent is actually working and only ages when
 * both the user and the agent have gone quiet).
 */
export function evaluateSessionLimits(
  cfg: SessionLimitsConfig,
  startedAtIso: string | undefined,
  lastActivityMs: number,
  nowMs: number,
): SessionLimitsStatus {
  const startedMs = startedAtIso ? new Date(startedAtIso).getTime() : NaN;
  const ageMinutes = isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 60_000) : 0;
  const idleMinutes = lastActivityMs > 0 ? Math.max(0, (nowMs - lastActivityMs) / 60_000) : 0;

  const cap = cfg.maxDurationMinutes;
  return {
    idleMinutes,
    ageMinutes,
    idleNotifyDue: cfg.idleNotifyMinutes !== undefined && idleMinutes >= cfg.idleNotifyMinutes,
    idleEndDue: cfg.enforce && cfg.maxIdleMinutes !== undefined && idleMinutes >= cfg.maxIdleMinutes,
    durationWarnDue: cap !== undefined && ageMinutes >= cap * DURATION_WARN_FRACTION && ageMinutes < cap,
    durationExceeded: cap !== undefined && ageMinutes >= cap,
  };
}

/**
 * Message shown (via stderr + exit 2) when a prompt is blocked by the
 * max-duration limit. Written for the human, but it also reaches the model
 * on some agents — keep it actionable for both.
 */
export function buildDurationBlockMessage(maxDurationMinutes: number, ageMinutes: number): string {
  return (
    `[Origin Policy] This session is ${Math.round(ageMinutes)} minutes old — past your team's ` +
    `${maxDurationMinutes}-minute session limit. New prompts are blocked. ` +
    `Start a NEW session to continue: a fresh session has a small context, so it is faster ` +
    `and far cheaper than resuming this one (long sessions re-read their entire history every turn).`
  );
}

/**
 * Best-effort desktop notification. macOS: osascript; Linux: notify-send;
 * elsewhere: silently skipped. Fire-and-forget — never throws, never blocks
 * the caller (the heartbeat tick must stay fast).
 */
export function sendDesktopNotification(title: string, body: string): void {
  try {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (process.platform === 'darwin') {
      execFile(
        'osascript',
        ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`],
        { timeout: 5000 },
        () => { /* best effort */ },
      );
    } else if (process.platform === 'linux') {
      execFile('notify-send', [title, body], { timeout: 5000 }, () => { /* best effort */ });
    }
  } catch { /* never let a notification failure surface */ }
}
