// "Your agent needs you / finished" — the CLI half of the agent notifications.
//
// 1. Claude Code's `Notification` hook fires when the agent needs permission
//    or has sat idle at the input prompt. handleAgentNotificationHook()
//    forwards { message, notificationType } to POST /api/mcp/session/:id/notify
//    (the server records an `agent_waiting` notification and pushes it to the
//    browser) and, when the user opted in, shows a native desktop notification.
// 2. At Stop, notifyTurnFinishedOnDesktop() shows a desktop notification when
//    the turn left new commits on a non-default branch — work ready to review.
//
// Neither may hold the agent up: the network call has a short timeout and
// every failure is swallowed; the desktop popup is a detached execFile; no
// session state is written. Desktop notifications are off unless
// `origin config set desktopNotifications true`.
import { execFileSync } from 'child_process';
import { loadConfig, isConnectedMode } from './config.js';
import { request } from './api.js';
import { sendDesktopNotification } from './session-limits.js';
import { findSessionByClaudeId, isProvisionalSessionId } from './session-state.js';

/** The hook must return fast; the server answers in one indexed lookup. */
export const NOTIFY_TIMEOUT_MS = 2500;

export interface NotifyDeps {
  findSession: (agentSessionId: string, cwd?: string) => { sessionId: string } | null;
  connected: () => boolean;
  desktopEnabled: () => boolean;
  post: (sessionId: string, body: { message: string; notificationType: string | null }, timeoutMs: number) => Promise<unknown>;
  desktop: (title: string, body: string) => void;
}

export const defaultNotifyDeps: NotifyDeps = {
  findSession: (id, cwd) => findSessionByClaudeId(id, cwd),
  connected: () => isConnectedMode(),
  desktopEnabled: () => loadConfig()?.desktopNotifications === true,
  post: (sessionId, body, timeoutMs) =>
    request(`/api/mcp/session/${encodeURIComponent(sessionId)}/notify`, { method: 'POST', body: JSON.stringify(body) }, timeoutMs),
  // Wrapped, not referenced: a test that mocks session-limits without this
  // export must not fail at import time.
  desktop: (title, body) => sendDesktopNotification(title, body),
};

export function waitingTitle(notificationType: string | null, message: string): string {
  const t = `${notificationType ?? ''} ${message}`.toLowerCase();
  return t.includes('permission') ? 'Your agent needs permission' : 'Your agent is waiting for you';
}

/**
 * Handle one `Notification` hook payload. Resolves once the forward finished
 * or timed out; never throws.
 */
export async function handleAgentNotificationHook(
  input: Record<string, any>,
  deps: NotifyDeps = defaultNotifyDeps,
): Promise<{ forwarded: boolean; desktop: boolean }> {
  const message = typeof input?.message === 'string' ? input.message.slice(0, 500) : '';
  const notificationType = typeof input?.notification_type === 'string' ? input.notification_type : null;
  let desktop = false;
  try {
    if (deps.desktopEnabled()) {
      deps.desktop(waitingTitle(notificationType, message), message || 'Claude Code is waiting for you');
      desktop = true;
    }
  } catch { /* best effort */ }

  let forwarded = false;
  try {
    const agentSessionId = typeof input?.session_id === 'string' ? input.session_id : '';
    if (agentSessionId && deps.connected()) {
      const state = deps.findSession(agentSessionId, typeof input?.cwd === 'string' ? input.cwd : undefined);
      if (state?.sessionId && !isProvisionalSessionId(state.sessionId)) {
        await deps.post(state.sessionId, { message, notificationType }, NOTIFY_TIMEOUT_MS);
        forwarded = true;
      }
    }
  } catch { /* offline, timed out, 404 — the agent must not notice */ }
  return { forwarded, desktop };
}

/** main/master, or what origin/HEAD points at. */
export function isDefaultBranchName(branch: string, repoPath: string): boolean {
  if (branch === 'main' || branch === 'master') return true;
  try {
    const head = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
    return head === `origin/${branch}`;
  } catch {
    return false;
  }
}

/**
 * At Stop: the turn moved HEAD on a non-default branch, i.e. it committed work
 * that is waiting for a PR or a merge. A desktop popup only — the server's
 * `agent_ready` is decided at session end against the Work board.
 */
export function notifyTurnFinishedOnDesktop(
  opts: { repoPath: string; branch: string | null; headBefore: string | null; headAfter: string | null },
  deps: Pick<NotifyDeps, 'desktopEnabled' | 'desktop'> & { isDefaultBranch?: (branch: string, repoPath: string) => boolean } = defaultNotifyDeps,
): boolean {
  try {
    if (!deps.desktopEnabled()) return false;
    const { branch, headBefore, headAfter } = opts;
    if (!branch || branch === 'HEAD' || !headAfter || !headBefore || headBefore === headAfter) return false;
    if ((deps.isDefaultBranch ?? isDefaultBranchName)(branch, opts.repoPath)) return false;
    deps.desktop('Your agent finished', `New commits on ${branch}, ready for review`);
    return true;
  } catch {
    return false;
  }
}
