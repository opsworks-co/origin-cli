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

export interface AuthRequest extends Request {
  user?: { id: string; orgId: string; role: string };
  apiKeyRepoScopes?: string[]; // Repo IDs this API key is scoped to (empty = unrestricted)
  apiKeyId?: string;           // ID of the API key used for auth
  apiKeyName?: string;         // Display name of the API key
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
  // Cookie header format: "k1=v1; k2=v2"
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
 * SameSite=Strict blocks CSRF (the browser won't attach it on cross-site nav
 * or subrequests), Secure forces HTTPS in production.
 */
export function setAuthCookie(res: Response, token: string) {
  const isProd = process.env.NODE_ENV === 'production';
  const maxAge = 7 * 24 * 60 * 60; // 7 days, must match JWT exp
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ── Short-lived SSE tokens ──────────────────────────────────────────────────
// EventSource can't set Authorization headers or custom headers, so we issue
// an opaque one-time token (NOT the JWT) that's valid for 30 seconds and
// deleted on first use. This avoids leaking the real JWT in query strings
// (which end up in server access logs, CDN logs, browser history, etc.).
const SSE_TOKEN_TTL_MS = 30_000; // 30 seconds
interface SseTokenEntry {
  payload: { id: string; orgId: string; role: string };
  expiresAt: number;
}
export const sseTokenStore = new Map<string, SseTokenEntry>();

// Periodic cleanup of expired SSE tokens (every 60s)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sseTokenStore) {
    if (now >= entry.expiresAt) sseTokenStore.delete(key);
  }
}, 60_000).unref();

/** Generate a short-lived SSE token for the given user payload. */
export function generateSseToken(payload: { id: string; orgId: string; role: string }): string {
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
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export async function authMiddleware(req: AuthRequest, _res: Response, next: NextFunction) {
  // Support Bearer token in Authorization header
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      // Pin the algorithm to HS256. Without an explicit allowlist,
      // jsonwebtoken will honor whatever `alg` header the attacker
      // sets — including `none` (pre-defaults) and, more practically,
      // asymmetric-to-symmetric key confusion. Locking to HS256 matches
      // how we sign and closes the alg=none / key-confusion attack.
      const payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as { id: string; orgId: string; role: string };
      req.user = payload;
    } catch { /* ignore invalid tokens */ }
  }
  // Support httpOnly session cookie for the web UI. SameSite=Strict on the
  // cookie is our CSRF defense — the browser will only attach it on
  // same-origin requests, so forged cross-site POSTs can't authenticate.
  if (!req.user) {
    const cookieToken = readCookie(req, AUTH_COOKIE_NAME);
    if (cookieToken) {
      try {
        const payload = jwt.verify(cookieToken, JWT_SECRET, { algorithms: ['HS256'] }) as { id: string; orgId: string; role: string };
        req.user = payload;
      } catch { /* ignore invalid cookie */ }
    }
  }
  // Support short-lived SSE tokens for EventSource (which can't set headers).
  // These are one-time tokens generated via POST /auth/sse-token, stored in
  // memory with 30s expiry, and deleted on first use — so the JWT never
  // appears in server access logs or browser history.
  if (!req.user && req.query.sseToken) {
    const entry = sseTokenStore.get(req.query.sseToken as string);
    if (entry && Date.now() < entry.expiresAt) {
      sseTokenStore.delete(req.query.sseToken as string);
      req.user = entry.payload;
    } else {
      sseTokenStore.delete(req.query.sseToken as string); // clean up expired
    }
  }
  // Support X-API-Key header (used by CLI)
  if (!req.user) {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      try {
        const found = await prisma.apiKey.findFirst({
          where: { keyHash },
          include: {
            user: true,
            org: { include: { users: { where: { role: 'OWNER' }, take: 1 } } },
            repoScopes: { select: { repoId: true } },
          },
        });
        if (found) {
          // Linked key (has userId): use the linked user's identity + role
          // Standalone key (no userId): use org owner's id so sessions created by
          // this key (via mcpUserId) match the userId filter when listing.
          req.user = {
            id: found.user?.id ?? found.org.users[0]?.id ?? found.id,
            orgId: found.orgId,
            role: found.user?.role ?? found.role ?? 'MEMBER',
          };
          req.apiKeyRepoScopes = found.repoScopes.map((s: { repoId: string }) => s.repoId);
          req.apiKeyId = found.id;
          req.apiKeyName = found.name;
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
 * RBAC middleware — restricts route to specific roles.
 * Roles hierarchy: OWNER > ADMIN > MEMBER > VIEWER
 * Usage: router.post('/', requireAuth, requireRole('ADMIN'), handler)
 */
const ROLE_LEVELS: Record<string, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const userRole = req.user.role.toUpperCase();
    // Allow if user's role is in the list, or if user's level >= highest required level
    const maxRequired = Math.max(...roles.map((r) => ROLE_LEVELS[r.toUpperCase()] ?? 0));
    const userLevel = ROLE_LEVELS[userRole] ?? 0;
    if (userLevel >= maxRequired) return next();
    res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  };
}
