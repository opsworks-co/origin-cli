import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from './config.js';

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

async function request(path: string, opts: RequestInit = {}) {
  const config = getConfig();
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
        ...opts.headers as Record<string, string>,
      },
    });
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
  ingestCommits: async (data: {
    repoPath: string;
    repoUrl?: string;
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
  }) => {
    const res = await request('/api/mcp/commits/ingest', { method: 'POST', body: JSON.stringify(data) });
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

  reportViolation: (data: { machineId: string; policyId: string; description: string; filepath?: string }) =>
    request('/api/mcp/violations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
