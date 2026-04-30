// ── Shared HTTP client ──────────────────────────────────────────────────
// Single source of truth for the request helper used by all domain modules
// in this directory. Imported by api/auth.ts, api/repos.ts, api/sessions.ts,
// and the legacy apps/web/src/api.ts barrel.

const BASE = '';

// Legacy localStorage token fallback: honoured for one transition window so
// users who logged in BEFORE the cookie rollout don't get signed out. New
// logins never write to localStorage (see AuthContext), so this branch will
// fade out naturally and can be deleted in a later sweep.
function legacyAuthHeaders(): Record<string, string> {
  let token: string | null = null;
  try { token = localStorage.getItem('origin_token'); } catch { token = null; }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// X-Origin-Org pin: the dashboard reads it from localStorage on every
// request so the backend's resolveOrgContext middleware locks the response
// to the org the user is currently viewing. Falls back silently when not
// set (server uses lastOrgId / first membership).
const ACTIVE_ORG_KEY = 'origin:activeOrgId';
export function getActiveOrgId(): string | null {
  try { return localStorage.getItem(ACTIVE_ORG_KEY); } catch { return null; }
}
export function setActiveOrgId(orgId: string | null) {
  try {
    if (orgId) localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    else localStorage.removeItem(ACTIVE_ORG_KEY);
  } catch { /* storage unavailable — fall through */ }
}
function activeOrgHeader(): Record<string, string> {
  const id = getActiveOrgId();
  return id ? { 'X-Origin-Org': id } : {};
}

export async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    // Auth is carried by the httpOnly `origin_auth` cookie. 'same-origin' is
    // sufficient because the API is served from the same origin as the web
    // app (apps/api/public), and SameSite=Strict on the cookie keeps it from
    // ever leaking cross-origin anyway.
    credentials: opts.credentials ?? 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...legacyAuthHeaders(),
      ...activeOrgHeader(),
      ...(opts.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as any)?.error ?? (body as any)?.message ?? res.statusText;
    throw new Error(msg);
  }

  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}
