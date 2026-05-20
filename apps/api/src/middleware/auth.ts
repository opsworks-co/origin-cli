import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`FATAL: ${name} environment variable is required.`);
  return val;
}
const JWT_SECRET = requireEnv('JWT_SECRET');

// Header used by the dashboard to pin a request to a specific org. Resolved
// against the user's memberships in `resolveOrgContext`. Lower-case because
// Express normalizes header names that way before lookup.
export const ORG_CONTEXT_HEADER = 'x-origin-org';

export interface AuthRequest extends Request {
  user?: { id: string; accountType: string };
  activeOrgId?: string;
  activeRole?: string;
  apiKeyRepoScopes?: string[]; // Repo IDs this API key is scoped to (empty = unrestricted)
  apiKeyId?: string;           // ID of the API key used for auth
  apiKeyName?: string;         // Display name of the API key
  // Set when an API key authenticated the request — pins the active org to
  // that key's org regardless of the X-Origin-Org header. Multi-org users
  // with several keys get one key per org.
  apiKeyOrgId?: string;
  apiKeyRole?: string | null;
}

/**
 * Name of the httpOnly session cookie. Kept short + prefixed so ops can grep
 * quickly in access logs.
 */
export const AUTH_COOKIE_NAME = 'origin_auth';

/** Parse a single cookie by name from the Cookie header. Minimal + allocation-free. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Set the session cookie. httpOnly blocks XSS from reading the token,
 * SameSite=Lax allows the cookie on top-level navigation (so clicking a
 * link to getorigin.io from Slack / email / a bookmark on another domain
 * still authenticates the first request — Strict would drop the cookie
 * and bounce the user to /login, presenting as a random logout). Lax
 * still withholds the cookie on cross-site POSTs, and the API runs its
 * own CSRF middleware on top, so we don't lose protection. Secure forces
 * HTTPS in production.
 */
export function setAuthCookie(res: Response, token: string) {
  const isProd = process.env.NODE_ENV === 'production';
  const maxAge = 30 * 24 * 60 * 60; // 30 days, must match JWT exp
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ── Short-lived SSE tokens ──────────────────────────────────────────────────
// EventSource can't set Authorization headers or custom headers, so we issue
// an opaque one-time token (NOT the JWT) that's valid for 30 seconds and
// deleted on first use.
const SSE_TOKEN_TTL_MS = 30_000;
interface SseTokenEntry {
  // Stored payload is post-multi-org: just userId. The active org for an
  // SSE-authenticated request comes from the X-Origin-Org header on the
  // initial GET (forwarded into the EventSource URL by the dashboard).
  payload: { id: string };
  expiresAt: number;
}
export const sseTokenStore = new Map<string, SseTokenEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sseTokenStore) {
    if (now >= entry.expiresAt) sseTokenStore.delete(key);
  }
}, 60_000).unref();

export function generateSseToken(payload: { id: string }): string {
  const token = crypto.randomBytes(32).toString('hex');
  sseTokenStore.set(token, { payload, expiresAt: Date.now() + SSE_TOKEN_TTL_MS });
  return token;
}

export function clearAuthCookie(res: Response) {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

interface JwtPayload {
  id: string;
}

/**
 * Resolve the calling user from JWT (Bearer or cookie), short-lived SSE
 * token, or X-API-Key, and stash a minimal `{ id, accountType }` on
 * `req.user`. Active-org resolution is a separate middleware
 * (`resolveOrgContext`) that runs only on org-scoped routes — auth here
 * does not assume an org.
 */
export async function authMiddleware(req: AuthRequest, _res: Response, next: NextFunction) {
  let userId: string | null = null;

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
      userId = payload.id;
    } catch { /* ignore invalid tokens */ }
  }

  if (!userId) {
    const cookieToken = readCookie(req, AUTH_COOKIE_NAME);
    if (cookieToken) {
      try {
        const payload = jwt.verify(cookieToken, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
        userId = payload.id;
      } catch { /* ignore invalid cookie */ }
    }
  }

  if (!userId && req.query.sseToken) {
    const entry = sseTokenStore.get(req.query.sseToken as string);
    if (entry && Date.now() < entry.expiresAt) {
      sseTokenStore.delete(req.query.sseToken as string);
      userId = entry.payload.id;
    } else {
      sseTokenStore.delete(req.query.sseToken as string);
    }
  }

  if (userId) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, accountType: true },
      });
      if (user) {
        req.user = { id: user.id, accountType: user.accountType };
      }
    } catch { /* DB hiccup — treat as unauthenticated */ }
  }

  // X-API-Key path. API keys carry their own org binding; we record both
  // the user identity (so audits link to a person where available) and the
  // pinned org so `resolveOrgContext` knows to ignore the header.
  if (!req.user) {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      try {
        const found = await prisma.apiKey.findFirst({
          where: { keyHash },
          include: {
            user: { select: { id: true, accountType: true } },
            org: {
              include: {
                memberships: {
                  where: { role: 'OWNER' },
                  take: 1,
                  select: { userId: true, role: true },
                },
              },
            },
            repoScopes: { select: { repoId: true } },
          },
        });
        if (found) {
          // Linked key: identity = the linked user.
          // Standalone key: identity = first OWNER membership of the key's
          // org (so audit trails attribute to a real person; sessions
          // created via the key still link sanely on the userId filter).
          const ownerMembership = found.org.memberships[0];
          const identityId = found.user?.id ?? ownerMembership?.userId ?? null;
          if (identityId) {
            req.user = {
              id: identityId,
              accountType: found.user?.accountType ?? 'org',
            };
            req.apiKeyRepoScopes = found.repoScopes.map((s: { repoId: string }) => s.repoId);
            req.apiKeyId = found.id;
            req.apiKeyName = found.name;
            req.apiKeyOrgId = found.orgId;
            req.apiKeyRole = found.role ?? null;
          }
        }
      } catch { /* API key lookup failed — continue unauthenticated */ }
    }
  }

  next();
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/**
 * Resolve the caller's active org for this request. Mounted on every
 * org-scoped route. Order of precedence:
 *
 *   1. API-key request — pin to `apiKey.orgId` (header is ignored; one key,
 *      one org).
 *   2. `X-Origin-Org` header — explicit choice from the dashboard.
 *   3. `User.lastOrgId` — sticky preference from a prior request.
 *   4. The user's first membership (any).
 *
 * In all cases we look up `Membership(userId, orgId)` and 403 if no row
 * exists. Authorization is *never* taken from the header alone — the
 * header is a hint, the membership row is the proof.
 */
export async function resolveOrgContext(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  // API-key path: the key is org-pinned. Look up the membership in that
  // org if the user has one, otherwise fall back to the standalone key's
  // declared role (this is the path standalone keys with no linked user
  // hit, where identity was synthesized from the OWNER membership).
  if (req.apiKeyOrgId) {
    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: req.user.id, orgId: req.apiKeyOrgId } },
      select: { role: true },
    });
    req.activeOrgId = req.apiKeyOrgId;
    req.activeRole = req.apiKeyRole || membership?.role || 'MEMBER';
    return next();
  }

  // Header → lastOrgId → first membership. Each is a *hint*; if the user
  // has no membership in the hinted org we silently fall through to the
  // next source rather than 403ing. This matches /me's behavior and keeps
  // a stale `X-Origin-Org` value (e.g. left over in localStorage from a
  // prior session, or pointing to an org the user was removed from) from
  // bricking every API call until the user clears storage.
  const headerOrgId = (req.headers[ORG_CONTEXT_HEADER] as string | undefined)?.trim() || null;

  let lastOrgId: string | null = null;
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { lastOrgId: true },
    });
    lastOrgId = u?.lastOrgId || null;
  } catch { /* ignore — fall through */ }

  const tryOrg = async (orgId: string | null) => {
    if (!orgId) return null;
    return prisma.membership.findUnique({
      where: { userId_orgId: { userId: req.user!.id, orgId } },
      select: { role: true, orgId: true },
    });
  };

  let membership = await tryOrg(headerOrgId);
  if (!membership) membership = await tryOrg(lastOrgId);
  if (!membership) {
    membership = await prisma.membership.findFirst({
      where: { userId: req.user.id },
      orderBy: { joinedAt: 'asc' },
      select: { role: true, orgId: true },
    });
  }
  if (!membership) {
    return res.status(403).json({ error: 'User has no org memberships' });
  }

  req.activeOrgId = membership.orgId;
  req.activeRole = membership.role;

  // Lazy-update lastOrgId when the user explicitly switched (header set
  // AND it matched a real membership). Fire-and-forget.
  if (headerOrgId && headerOrgId === membership.orgId && lastOrgId !== membership.orgId) {
    prisma.user.update({
      where: { id: req.user.id },
      data: { lastOrgId: membership.orgId },
    }).catch(() => { /* non-fatal */ });
  }
  next();
}

/**
 * RBAC middleware — gates a route on the user's role *in the active org*.
 * Roles hierarchy: OWNER > ADMIN > MEMBER > VIEWER. (REVIEWER is treated
 * as MEMBER for level comparisons; routes that need REVIEWER specifically
 * should match by name.)
 */
const ROLE_LEVELS: Record<string, number> = {
  VIEWER: 0,
  REVIEWER: 1,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.activeRole) return res.status(403).json({ error: 'No active org' });
    const userRole = req.activeRole.toUpperCase();
    const maxRequired = Math.max(...roles.map((r) => ROLE_LEVELS[r.toUpperCase()] ?? 0));
    const userLevel = ROLE_LEVELS[userRole] ?? 0;
    if (userLevel >= maxRequired) return next();
    res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  };
}

/**
 * Repo-level access middleware. Mounted on routes whose path includes
 * `:id` matching a Repo id (e.g. /repos/:id/...). Reads the active org
 * from `resolveOrgContext` (must run first), looks up the user's
 * effective level on the repo, and 403s if it's below `need`.
 *
 * Org OWNER/ADMIN bypass — they're always treated as 'admin' on every
 * repo. API-key requests run through the same gate using the linked
 * user's repo membership, so a key with a broad org scope can still be
 * narrowed by the user's per-repo grants.
 */
export function requireRepoAccess(need: 'read' | 'write' | 'admin') {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.activeOrgId) return res.status(403).json({ error: 'No active org' });
    const repoId = (req.params as Record<string, string | undefined>).id
      || (req.params as Record<string, string | undefined>).repoId;
    if (!repoId) return res.status(400).json({ error: 'Missing repo id' });

    // Lazy-import so middleware/auth.ts doesn't pull in services on cold
    // start. Avoids a circular dependency where services/access.ts wants
    // to import prisma which imports back through middleware.
    const { resolveRepoAccess, repoLevelMeets } = await import('../services/access.js');
    const level = await resolveRepoAccess(req.user.id, req.activeOrgId, repoId, req.activeRole);
    if (!repoLevelMeets(level, need)) {
      return res.status(403).json({ error: `Need '${need}' on this repo` });
    }
    (req as any).repoAccessLevel = level;
    next();
  };
}

export function requireAgentAccess(need: 'use' | 'admin') {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.activeOrgId) return res.status(403).json({ error: 'No active org' });
    const agentId = (req.params as Record<string, string | undefined>).id
      || (req.params as Record<string, string | undefined>).agentId;
    if (!agentId) return res.status(400).json({ error: 'Missing agent id' });

    const { resolveAgentAccess, agentLevelMeets } = await import('../services/access.js');
    const level = await resolveAgentAccess(req.user.id, req.activeOrgId, agentId, req.activeRole);
    if (!agentLevelMeets(level, need)) {
      return res.status(403).json({ error: `Need '${need}' on this agent` });
    }
    (req as any).agentAccessLevel = level;
    next();
  };
}
