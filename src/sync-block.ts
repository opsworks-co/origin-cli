/**
 * Why a session couldn't be uploaded to the server and was kept local.
 *
 * Before this existed, `origin status` blindly attributed EVERY local-only
 * session to "agent was disabled" — a hardcoded string that never looked at
 * the real reason. That sent people chasing a disabled-agent ghost when the
 * true cause was almost always "this repo isn't registered in the org" (the
 * 403 a team key gets for an unregistered repo). We now classify the failure
 * once, persist it on the session file (`state.syncBlock`), and let `status`
 * report the honest reason + the exact remediation.
 */
export type SyncBlockCode =
  | 'agent-disabled'      // AGENT_DISABLED — admin hasn't enabled this agent
  | 'repo-not-registered' // 403 — repo isn't registered in the org (team keys)
  | 'budget'              // hard budget cap refused the session
  | 'auth'                // 401 — dead/rotated key
  | 'unreachable'         // network error, never got an HTTP status
  | 'error';              // any other server error

export interface SyncBlock {
  code: SyncBlockCode;
  message: string;
  repoPath: string;
  at: string; // ISO timestamp of the failed attempt
}

/** Map a thrown API error (see api.ts request()) to a stable reason code. */
export function classifySyncBlock(err: any): SyncBlockCode {
  const code = err?.code;
  const serverError = err?.serverError;
  const status = err?.status;
  if (code === 'AGENT_DISABLED') return 'agent-disabled';
  if (code === 'REPO_NOT_REGISTERED' || serverError === 'Repository not registered') {
    return 'repo-not-registered';
  }
  if (status === 429 || code === 'BUDGET_EXCEEDED') return 'budget';
  if (status === 401) return 'auth';
  if (typeof status !== 'number') return 'unreachable';
  return 'error';
}

/** Build the persisted block record for a failed start attempt. */
export function makeSyncBlock(err: any, repoPath: string, nowIso: string): SyncBlock {
  return {
    code: classifySyncBlock(err),
    message: err?.serverMessage || err?.message || '',
    repoPath: repoPath || '',
    at: nowIso,
  };
}

/** Human-readable label + remediation hint for a reason code, used by `status`. */
export function describeSyncBlock(code: SyncBlockCode): { label: string; hint: string } {
  switch (code) {
    case 'agent-disabled':
      return {
        label: 'agent disabled in your org',
        hint: 'Enable the agent (Agents tab), then run `origin sessions sync`.',
      };
    case 'repo-not-registered':
      return {
        label: 'repo not registered in your org',
        hint: 'An owner can add it (Repositories → Add Repo, or `origin repo:add`), then run `origin sessions sync`.',
      };
    case 'budget':
      return {
        label: 'budget cap reached',
        hint: 'Raise the cap or wait for the reset, then run `origin sessions sync`.',
      };
    case 'auth':
      return {
        label: 'sign-in expired',
        hint: 'Run `origin login`, then `origin sessions sync`.',
      };
    case 'unreachable':
      return {
        label: 'server was unreachable',
        hint: 'Run `origin sessions sync` once you are back online.',
      };
    default:
      return {
        label: 'upload failed',
        hint: 'Run `origin sessions sync` to retry and see the error.',
      };
  }
}
