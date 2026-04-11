// ── Rate Limiting ──────────────────────────────────────────────────────────
// Tiered rate limits to prevent brute force, DDoS, and ghost session spam.
// Keys requests by API key (for authed) or IP (for unauthed).

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

// Helper: key by user/org if authenticated, else by IP.
// IPv6-safe via ipKeyGenerator helper from express-rate-limit.
function keyByUserOrIp(req: Request): string {
  const user = (req as any).user;
  if (user?.id) return `user:${user.id}`;
  if (user?.orgId) return `org:${user.orgId}`;
  return `ip:${ipKeyGenerator(req.ip || '0.0.0.0')}`;
}

// Skip rate-limit responses with structured JSON instead of plaintext.
const handler = (req: Request, res: any) => {
  res.status(429).json({
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please slow down and try again later.',
    retryAfter: res.getHeader('Retry-After'),
  });
};

const baseConfig = {
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  handler,
};

// ── Auth endpoints ───────────────────────────────────────────────────────
// Brute-force defense for login/signup. Strict by IP.
export const authLimiter = rateLimit({
  ...baseConfig,
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,                  // 20 attempts per IP per 15 min
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || '0.0.0.0')}`,
  message: 'Too many auth attempts',
});

// ── Session ingestion endpoints ──────────────────────────────────────────
// Generous but bounded — prevents ghost session spam from runaway scripts.
// Keyed by user so a noisy CLI doesn't block other users on the same IP.
export const sessionLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,      // 1 min
  max: 120,                 // 120 session ops/min/user (≈2/sec sustained)
});

// ── MCP endpoints ────────────────────────────────────────────────────────
// MCP can be chatty (heartbeats, prompt logs). Higher ceiling.
export const mcpLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,
  max: 300,                 // 300 ops/min/user
});

// ── Webhook ingestion ────────────────────────────────────────────────────
// GitHub/GitLab can burst. Key by IP since webhooks are unauthenticated
// (HMAC verified at the route level).
export const webhookLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,
  max: 600,                 // 600 webhook deliveries/min/IP
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || '0.0.0.0')}`,
});

// ── General API ──────────────────────────────────────────────────────────
// Catch-all sanity limit on every other authenticated endpoint.
export const apiLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,
  max: 600,                 // 600 req/min/user
});

// ── Password reset (extra-strict) ────────────────────────────────────────
// Prevents email bombing / token brute force. Applied on top of authLimiter.
export const passwordResetLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                   // 5 reset requests per IP per hour
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || '0.0.0.0')}`,
});

// ── Strict (expensive operations) ────────────────────────────────────────
// For sync, scan, AI rescan — operations that hit external APIs or DBs hard.
export const expensiveLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,
  max: 10,                  // 10 expensive ops/min/user
});
