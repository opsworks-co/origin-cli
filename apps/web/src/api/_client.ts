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
