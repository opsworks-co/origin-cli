// Decision logic for the "block push when the coding agent is disabled in
// Origin" governance feature. Pure + dependency-free so it's unit-tested in
// isolation; the pre-push hook (commands/hooks.ts) supplies the live inputs.
//
// The org's mode lives server-side (Org.pushBlockMode) and is returned by
// GET /api/mcp/push-check. The CLI caches the last-known mode so that when it
// CAN'T reach the API at push time it still knows whether the org wants a
// fail-closed block.

export type PushBlockMode = 'off' | 'on_fail_open' | 'on_fail_closed';

export interface PushBlockInput {
  // Did the push-check API call succeed?
  reachable: boolean;
  // When reachable: did the server allow the push? (false = agent disabled)
  allowed?: boolean;
  // Display name of the agent that was checked, for the message.
  agentName?: string | null;
  // Last-known org mode, used only when the API is unreachable.
  cachedMode?: string;
}

export interface PushBlockDecision {
  block: boolean;
  reason: string;
}

export function decidePushBlock(input: PushBlockInput): PushBlockDecision {
  if (input.reachable) {
    // Server is authoritative. It already folds in the org mode + solo
    // bypass, so a plain `allowed === false` means "agent disabled, block".
    if (input.allowed === false) {
      const who = input.agentName || 'Your coding agent';
      return { block: true, reason: `${who} is disabled in Origin` };
    }
    return { block: false, reason: '' };
  }

  // Unreachable: we can only enforce if we previously learned the org runs
  // fail-closed. Without that knowledge we allow — never brick pushes for an
  // org that hasn't opted in (or that we've never successfully synced).
  if (input.cachedMode === 'on_fail_closed') {
    return {
      block: true,
      reason: "couldn't reach Origin to verify your agent (org policy blocks pushes when unverifiable)",
    };
  }
  return { block: false, reason: '' };
}
