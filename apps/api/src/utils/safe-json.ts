// ── Safe JSON Parsing ────────────────────────────────────────────────────
// Drop-in replacements for JSON.parse that log instead of swallowing errors.
// Use these instead of `try { JSON.parse(...) } catch {}` patterns.

export function safeParseArray<T = unknown>(raw: string | null | undefined, ctx: string): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    console.warn(`[safe-json] failed to parse array (${ctx}):`, (err as Error).message);
    return [];
  }
}

export function safeParseObject<T extends Record<string, any> = Record<string, any>>(
  raw: string | null | undefined,
  ctx: string,
  fallback: T = {} as T
): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch (err) {
    console.warn(`[safe-json] failed to parse object (${ctx}):`, (err as Error).message);
    return fallback;
  }
}
