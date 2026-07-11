import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from './config.js';
import { fetchWithTimeout } from './fetch-timeout.js';

function getConfig() {
  const config = loadConfig();
  if (!config) throw new Error('Not logged in. Run: origin login');
  return config;
}

// Auth status file — written on every API result so hooks (and any
// future surface) can detect a dead key without re-hitting the server.
// The hooks then inject a visible warning into the agent's
// systemMessage so the user sees "your CLI is dead" inside Claude
// Code / Codex / Cursor, instead of staring at a silent dashboard
// while every request 401s into hooks.log.
const AUTH_STATUS_PATH = path.join(os.homedir(), '.origin', 'auth-status.json');

interface AuthStatus {
  state: 'ok' | 'unauthorized' | 'unreachable';
  lastCheckedAt: string;
  /** Key prefix (first 14 chars) — never the full key — so the warning
   *  surface can disambiguate when a user has multiple profiles. */
  keyPrefix?: string;
  /** Human-readable error from the server, if any. */
  message?: string;
}

export function readAuthStatus(): AuthStatus | null {
  try {
    return JSON.parse(fs.readFileSync(AUTH_STATUS_PATH, 'utf-8')) as AuthStatus;
  } catch {
    return null;
  }
}

function writeAuthStatus(status: AuthStatus): void {
  try {
    fs.mkdirSync(path.dirname(AUTH_STATUS_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(AUTH_STATUS_PATH, JSON.stringify(status, null, 2));
  } catch { /* best-effort — don't blow up a hook over a status file */ }
}

// Self-healing re-login. The first time a hook (or any request) sees a
// 401, we spawn a detached `origin login` process which runs the
// device-code flow: opens the browser, the user clicks Approve once
// in the dashboard tab they already have open, and the CLI writes a
// fresh key to ~/.origin/config.json. Subsequent hooks pick it up
// transparently. The lock file prevents spawning multiple browser
// windows when several hooks fire back-to-back during the recovery
// window.
const RELOGIN_LOCK_PATH = path.join(os.homedir(), '.origin', 'relogin.lock');
const RELOGIN_LOCK_TTL_MS = 15 * 60 * 1000; // browser approval window + slack

function shouldSpawnRelogin(): boolean {
  try {
    const raw = fs.readFileSync(RELOGIN_LOCK_PATH, 'utf-8');
    const { spawnedAt } = JSON.parse(raw) as { spawnedAt: number };
    if (typeof spawnedAt === 'number' && Date.now() - spawnedAt < RELOGIN_LOCK_TTL_MS) {
      return false; // another relogin is already in flight
    }
  } catch { /* no lock or unreadable — proceed */ }
  return true;
}

function markReloginSpawned(): void {
  try {
    fs.mkdirSync(path.dirname(RELOGIN_LOCK_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(RELOGIN_LOCK_PATH, JSON.stringify({ spawnedAt: Date.now() }));
  } catch { /* best-effort */ }
}

export function clearReloginLock(): void {
  try { fs.unlinkSync(RELOGIN_LOCK_PATH); } catch { /* already gone */ }
}

function isHookContext(): boolean {
  // The CLI is being invoked as an agent hook (e.g. `origin hooks codex
  // user-prompt-submit`). Hooks run in the background by the agent — the
  // user isn't watching the terminal and doesn't expect a browser window
  // to pop up just because a stale API key returned 401. Skip the relogin
  // spawn in this context and let the user run `origin login` manually
  // when they're ready (the auth-status file already records the failure).
  const argv = process.argv.slice(2);
  return argv.length >= 1 && argv[0] === 'hooks';
}

function spawnReloginBackground(): void {
  // Auto-spawning the browser-based device-code login on every 401 popped
  // unwanted sign-in tabs whenever any hook/heartbeat hit a stale key.
  // The user has flagged this — they don't want web auth triggered out of
  // band. Skip the spawn entirely; the auth-status file already records
  // the failure and the user can run `origin login --key <key>` manually
  // when they're ready. (Hook context was already excluded; this just
  // brings the rest of the CLI in line.)
  return;
}

/** Ensure a parsed API response is a non-null object. */
function assertObj(res: unknown, label: string): asserts res is Record<string, unknown> {
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    throw new Error(`Invalid API response for ${label}: expected object, got ${res === null ? 'null' : typeof res}`);
  }
}

/** Ensure a parsed API response is a non-null object with specific required fields. */
function assertFields(res: unknown, label: string, fields: string[]): asserts res is Record<string, unknown> {
  assertObj(res, label);
  for (const f of fields) {
    if ((res as Record<string, unknown>)[f] === undefined) {
      throw new Error(`Invalid API response for ${label}: missing required field '${f}'`);
    }
  }
}

async function request(path: string, opts: RequestInit = {}, timeoutMs?: number) {
  const config = getConfig();
  let res: Response;
  try {
    res = await fetchWithTimeout(`${config.apiUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
        ...opts.headers as Record<string, string>,
      },
    }, timeoutMs);
  } catch (err: any) {
    writeAuthStatus({
      state: 'unreachable',
      lastCheckedAt: new Date().toISOString(),
      keyPrefix: config.apiKey?.slice(0, 14),
      message: err?.message || 'network error',
    });
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    if (res.status === 401) {
      // Dead key. Snapshot the failure so hooks can warn the user
      // inside their agent UI instead of swallowing 401s into logs.
      writeAuthStatus({
        state: 'unauthorized',
        lastCheckedAt: new Date().toISOString(),
        keyPrefix: config.apiKey?.slice(0, 14),
        message: body?.error || 'Invalid API key',
      });
      // Permanent fix: kick off `origin login` in the background so
      // the user just clicks Approve in the dashboard tab they
      // already have open and the CLI self-heals. Lock-gated so a
      // burst of failing hooks doesn't spawn multiple browser
      // windows. The current request still fails (we can't pause a
      // hook on a 5-min device-code wait) but every subsequent
      // hook will succeed once the user clicks Approve.
      spawnReloginBackground();
    }
    const err = new Error(body?.message || body?.error || res.statusText) as any;
    err.status = res.status;
    err.serverError = body?.error;
    err.serverMessage = body?.message;
    // Surface structured codes (AGENT_DISABLED, etc.) so callers can switch
    // on them instead of string-matching the message.
    err.code = body?.code;
    err.body = body;
    throw err;
  }
  // Successful response — clear any stale unauthorized flag and the
  // relogin lock so a future drift can spawn the flow again.
  const prior = readAuthStatus();
  if (prior && prior.state !== 'ok') {
    writeAuthStatus({
      state: 'ok',
      lastCheckedAt: new Date().toISOString(),
      keyPrefix: config.apiKey?.slice(0, 14),
    });
    clearReloginLock();
  }
  return res.json();
}

export const api = {
  getPolicies: () => request('/api/mcp/policies'),
  registerMachine: (data: any) => request('/api/machines', { method: 'POST', body: JSON.stringify(data) }),
  getMachines: () => request('/api/machines'),
  syncRepo: (id: string) => request(`/api/repos/${id}/sync`, { method: 'POST' }),
  getRepos: () => request('/api/repos'),
  getWhoami: () => request('/api/mcp/whoami'),
  // Tell the server how many sessions from a PREVIOUS account are sitting
  // unimported locally, so the dashboard can show an import/forget banner.
  // Returns { pendingAction: 'import' | 'forget' | null } — the web-initiated
  // intent the CLI should carry out. Pass clearAction once it's been carried
  // out so the server nulls it.
  reportUnimportedSessions: (count: number, clearAction = false) =>
    request('/api/mcp/report-unimported-sessions', {
      method: 'POST',
      body: JSON.stringify({ count, clearAction }),
    }),
  // Pre-push governance check: is the developer's agent enabled enough to
  // allow this push? Returns { allowed, agentEnabled, agentName, mode }.
  // Accepts an AbortSignal so the pre-push hook can bound the wait — a slow
  // or down API must never stall a developer's push.
  pushCheck: (agentSlug?: string, signal?: AbortSignal) =>
    request(
      `/api/mcp/push-check${agentSlug ? `?agentSlug=${encodeURIComponent(agentSlug)}` : ''}`,
      signal ? { signal } : {},
    ),
  getMe: async () => {
    const res = await request('/api/auth/me');
    assertObj(res, 'getMe');
    return res;
  },

  // Session lifecycle (MCP API — used by hooks)
  // All session-write endpoints fan out to every secondary profile so each
  // logged-in account ends up with its own session record. Primary owns
  // the canonical sessionId returned to the caller; mirror sessionIds are
  // stashed in ~/.origin/mirrors/<primaryId>.json and consulted by the
  // other endpoints below.
  startSession: async (data: {
    machineId: string;
    prompt: string;
    model: string;
    repoPath: string;
    repoUrl?: string;
    agentSlug?: string;
    branch?: string;
    hostname?: string;
    additionalRepoPaths?: string[];
    agentSessionId?: string;
    importedFromPreviousAccount?: boolean;
    // Recent HEAD SHAs (newest first) — lets the server's basename-fallback
    // repo gate corroborate a moved local-only checkout by SHA overlap, the
    // same proof /commits/ingest offers via commits[] + its advertisement.
    recentShas?: string[];
  }) => {
    // Single-key world: server federates session writes across the user's
    // memberships on read (see /api/me/* on the API). No client-side
    // mirroring needed — one POST, one session id, server handles the rest.
    const res = await request('/api/mcp/session/start', { method: 'POST', body: JSON.stringify(data) });
    assertFields(res, 'startSession', ['sessionId']);
    return res;
  },
  updateSession: async (id: string, data: any) => {
    const res = await request(`/api/mcp/session/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    assertObj(res, 'updateSession');
    return res;
  },
  resumeSession: async (id: string) => {
    const res = await request(`/api/mcp/session/${id}/resume`, { method: 'POST' });
    assertObj(res, 'resumeSession');
    return res;
  },
  endSession: async (data: any) => {
    const res = await request('/api/mcp/session/end', { method: 'POST', body: JSON.stringify(data) });
    assertObj(res, 'endSession');
    return res;
  },
  pingSession: (id: string) =>
    request(`/api/mcp/session/${id}/ping`, { method: 'POST' }),
  // Live, scope-filtered policy set for a running session — lets pre-tool-use
  // pick up a policy created AFTER the session started (the heartbeat refreshes
  // the same data from its ping, but isn't always running for Codex/Cursor).
  refreshSessionPolicies: async (id: string): Promise<{
    activePolicies: string[];
    enforcementRules: Array<{ type: string; condition: string; action: string; severity: string; policyId?: string; ruleId?: string; policyName?: string }>;
  }> => {
    const res = await request(`/api/mcp/session/${id}/policies`);
    assertObj(res, 'refreshSessionPolicies');
    return res as { activePolicies: string[]; enforcementRules: any[] };
  },
  // Lockout re-check — called by hooks only while a session is budget-
  // blocked, so the block lifts as soon as the period resets or an admin
  // raises the cap.
  getBudgetStatus: async (sessionId?: string): Promise<{ blocked: boolean; level?: string; message: string }> => {
    // Pass the locked session's id so the server re-checks the SAME scope
    // that blocked it (agent/user/repo/model cap), not just the org-wide
    // cap — otherwise a scoped hard lock would lift the moment the org cap
    // is under limit. Omitted for local-only sessions (no server row).
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const res = await request(`/api/mcp/budget-status${qs}`);
    assertObj(res, 'getBudgetStatus');
    return res as { blocked: boolean; level?: string; message: string };
  },
  ingestCommits: async (data: {
    repoPath: string;
    repoUrl?: string;
    // SHAs reachable from HEAD (newest first). Server replies with
    // `unknownShas` — the subset it has no Commit row for — which the
    // post-commit hook then backfills. See history-backfill.ts.
    recentShas?: string[];
    commits: Array<{
      sha: string;
      message?: string;
      author?: string;
      branch?: string | null;
      filesChanged?: string[];
      additions?: number;
      deletions?: number;
      committedAt?: string;
      // Per-commit unified diff (`git diff <sha>~1..<sha>` output).
      // Stored on Commit.patch so the dashboard can render this commit's
      // changes instead of the session aggregate.
      diff?: string;
    }>;
  }, reqOpts?: { timeoutMs?: number }) => {
    const res = await request('/api/mcp/commits/ingest', { method: 'POST', body: JSON.stringify(data) }, reqOpts?.timeoutMs);
    assertObj(res, 'ingestCommits');
    return res;
  },
  attachRepo: async (id: string, repoPath: string) => {
    const res = await request(`/api/mcp/session/${id}/attach-repo`, {
      method: 'POST',
      body: JSON.stringify({ repoPath }),
    });
    assertObj(res, 'attachRepo');
    return res;
  },
  uploadSnapshot: async (id: string, snapshot: {
    snapshotId: string;
    type: string;
    takenAt: string;
    promptIndex?: number | null;
    commitSha?: string | null;
    treeSha?: string | null;
    filesChanged?: string[];
    linesAdded?: number;
    linesRemoved?: number;
  }) => {
    const res = await request(`/api/mcp/session/${id}/snapshot`, {
      method: 'POST',
      body: JSON.stringify(snapshot),
    });
    assertObj(res, 'uploadSnapshot');
    return res;
  },

  // Sessions (web API)
  getSessions: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/sessions${q ? `?${q}` : ''}`);
  },
  // Feature Trails live server-side (single source of truth). The CLI reads
  // them; creation/management happens in the dashboard.
  getTrails: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/trails${q ? `?${q}` : ''}`);
  },
  getSession: async (id: string) => {
    const res = await request(`/api/sessions/${id}`);
    assertObj(res, 'getSession');
    return res;
  },
  reviewSession: (id: string, status: string, note?: string) =>
    request(`/api/sessions/${id}/review`, { method: 'POST', body: JSON.stringify({ status, note }) }),
  shareSession: (id: string) =>
    request(`/api/sessions/${id}/share`, { method: 'POST' }),
  endSessionById: (id: string) =>
    request(`/api/sessions/${id}/end`, { method: 'POST' }),

  // Agents
  getMyAgents: () => request('/api/agents/my'),
  getAgents: () => request('/api/agents'),
  getAgent: (id: string) => request(`/api/agents/${id}`),
  createAgent: (data: any) => request('/api/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: any) => request(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => request(`/api/agents/${id}`, { method: 'DELETE' }),

  // Repos
  createRepo: (data: any) => request('/api/repos', { method: 'POST', body: JSON.stringify(data) }),
  deleteRepo: (id: string) => request(`/api/repos/${id}`, { method: 'DELETE' }),

  // Policies (CRUD)
  createPolicy: (data: any) => request('/api/policies', { method: 'POST', body: JSON.stringify(data) }),
  deletePolicy: (id: string) => request(`/api/policies/${id}`, { method: 'DELETE' }),

  // PR Review (CLI)
  reviewPR: (url: string) => request(`/api/pull-requests/review?url=${encodeURIComponent(url)}`),

  // Audit
  getAuditLogs: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/audit${q ? `?${q}` : ''}`);
  },

  // Stats
  getStats: async (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    const res = await request(`/api/stats${q ? `?${q}` : ''}`);
    assertObj(res, 'getStats');
    return res;
  },

  // Versioning
  getPolicyVersions: (id: string) => request(`/api/policies/${id}/versions`),
  getAgentVersions: (id: string) => request(`/api/agents/${id}/versions`),

  // Notifications
  getNotifications: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/notifications${q ? `?${q}` : ''}`);
  },
  getUnreadCount: () => request('/api/notifications/unread-count'),
  markAllRead: () => request('/api/notifications/read-all', { method: 'PUT' }),

  // Users / Team
  getUsers: () => request('/api/users'),
  getUser: (id: string) => request(`/api/users/${id}`),

  // Pricing
  getPricing: async () => {
    const res = await request('/api/pricing');
    assertObj(res, 'getPricing');
    return res;
  },

  // Secret findings (pre-commit hook)
  reportSecrets: (sessionId: string, findings: any[]) =>
    request(`/api/sessions/${sessionId}/secrets`, {
      method: 'POST',
      body: JSON.stringify({ findings, source: 'pre-commit' }),
    }),

  // policyId identifies a dashboard policy; policyType covers enforcement
  // without a Policy row (e.g. BUDGET_CAP) and feeds the stats
  // violations-by-type histogram. At least one of the two is required.
  reportViolation: (data: {
    machineId: string;
    policyId?: string;
    policyType?: string;
    policyName?: string;
    description: string;
    filepath?: string;
    sessionId?: string;
  }) =>
    request('/api/mcp/violations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Mirror a locally-written git note up to Origin so commits in local-
  // only repos (where the API can't pull refs/notes/origin from any
  // remote) still surface agent/model attribution on the commit detail
  // and per-file blame pages. Session-scoped: server resolves repo via
  // the session row. Fire-and-forget: never blocks session-end.
  importGitNote: (sessionId: string, sha: string, note: Record<string, unknown>) =>
    request(`/api/sessions/${sessionId}/import-note`, {
      method: 'POST',
      body: JSON.stringify({ sha, note }),
    }),

  // Upload a single image attachment for a prompt. Server caps at 5 MB
  // per image / 50 MB per session and gates on the user's
  // `captureImages` opt-in flag — a 403 means "user has image capture
  // disabled," and we should stop trying for the rest of the session.
  // Returns the stable attachment id which the caller splices into the
  // prompt text as `[image:<id>]`.
  uploadAttachment: (
    sessionId: string,
    payload: { promptIndex: number; mediaType: string; base64: string },
  ): Promise<{ id: string; deduped?: boolean }> =>
    request(`/api/sessions/${sessionId}/attachments`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
