// ── Input Validation Helpers ─────────────────────────────────────────────
// Shared length-cap helpers for route handlers. Without these a client can
// pass multi-MB strings and bloat DB rows + every response that lists the
// resource. These caps are generous — they only reject pathological payloads,
// not legitimate input.

export type FieldLimits = Record<string, number>;

/**
 * Validate that every string field in `fields` is under its configured
 * length cap (in chars, not bytes). Returns a user-facing error message
 * on failure, or null when valid.
 *
 * null/undefined values are skipped (treated as "not provided"). Non-string
 * values where a string was expected return a type error.
 */
export function validateFieldLengths(
  fields: Record<string, unknown>,
  limits: FieldLimits,
): string | null {
  for (const [key, limit] of Object.entries(limits)) {
    const val = fields[key];
    if (val == null) continue;
    if (typeof val !== 'string') {
      return `Field ${key} must be a string`;
    }
    if (val.length > limit) {
      return `Field ${key} exceeds max length of ${limit} characters`;
    }
  }
  return null;
}

/**
 * Common limits shared across routes. Per-route overrides are fine — these
 * are just sensible defaults for frequently-written fields.
 */
/**
 * Parse a pagination offset from query string. Clamps NaN/negative to 0 and
 * caps at a configurable max to prevent deep-skip abuse.
 */
export function parseOffset(raw: unknown, max = 100_000): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : 0;
  if (!Number.isFinite(n) || Number.isNaN(n) || n < 0) return 0;
  return Math.min(n, max);
}

/**
 * Parse a pagination limit from query string. Clamps NaN/negative to fallback
 * and caps at max. Prevents ?limit=9999999 queries.
 */
export function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : fallback;
  if (!Number.isFinite(n) || Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * Pick a value from an allowlist or return a fallback. Use for sort fields,
 * enum filters, period selectors — anything where user input must map to a
 * fixed set of known-safe values before reaching Prisma.
 */
export function pickAllowed<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Read a required string field from req.body with a length cap. Throws a
 * RouteError (400) on missing/wrong-type/too-long. Use in route handlers
 * that currently do `const { foo } = req.body as any` to get stronger
 * guarantees without adding a full validator dependency.
 */
export class RouteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'RouteError';
  }
}

export function requireString(obj: unknown, field: string, maxLen = 10_000): string {
  if (!obj || typeof obj !== 'object') {
    throw new RouteError(400, `Body must be an object`);
  }
  const v = (obj as Record<string, unknown>)[field];
  if (typeof v !== 'string') {
    throw new RouteError(400, `Field ${field} is required and must be a string`);
  }
  if (v.length === 0) {
    throw new RouteError(400, `Field ${field} must not be empty`);
  }
  if (v.length > maxLen) {
    throw new RouteError(400, `Field ${field} exceeds max length of ${maxLen}`);
  }
  return v;
}

export function optionalString(obj: unknown, field: string, maxLen = 10_000): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new RouteError(400, `Field ${field} must be a string`);
  }
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

export function optionalBool(obj: unknown, field: string): boolean | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') {
    throw new RouteError(400, `Field ${field} must be a boolean`);
  }
  return v;
}

export const COMMON_LIMITS = {
  name: 200,
  slug: 100,
  description: 2_000,
  path: 500,
  hostname: 255,
  url: 2_000,
  note: 10_000,
  prompt: 10_000,
  condition: 5_000,
  action: 200,
  severity: 50,
  title: 200,
  message: 2_000,
  settings: 10_000,
} as const;
