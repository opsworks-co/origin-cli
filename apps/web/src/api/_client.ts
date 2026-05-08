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

// Cleared on a 401 response so a stale legacy Bearer in localStorage
// doesn't poison every subsequent request. (Cookie auth doesn't need
// this — the browser stops sending an expired cookie on its own.)
function clearLegacyAuthToken() {
  try { localStorage.removeItem('origin_token'); } catch { /* ignore */ }
}

export async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const doFetch = (extraHeaders: Record<string, string> = {}) => fetch(`${BASE}${path}`, {
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
      ...extraHeaders,
      ...(opts.headers as Record<string, string> | undefined),
    },
  });

  let res = await doFetch();

  // If a stale legacy Bearer token is the reason auth failed, drop it
  // and retry with cookie-only. The auth middleware prefers Bearer over
  // cookie — so a bogus Bearer (e.g. signed with a previous JWT_SECRET,
  // or pointing at a deleted user) shorts out the cookie path entirely.
  // One-shot retry: if cookie auth ALSO fails, the second 401 stands.
  if (res.status === 401) {
    let hadLegacy = false;
    try { hadLegacy = !!localStorage.getItem('origin_token'); } catch { /* ignore */ }
    if (hadLegacy) {
      clearLegacyAuthToken();
      res = await doFetch();
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Prefer `message` over `error` — by convention server returns
    // `error` as a short tag and `message` as the human-readable
    // explanation. Most endpoints only set `error`, so the fallback
    // chain still works there.
    const msg = (body as any)?.message ?? (body as any)?.error ?? res.statusText;
    throw new Error(msg);
  }

  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}
