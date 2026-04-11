// ── Safe URL Rendering ─────────────────────────────────────────────────
// Wrap any URL that originates from server data (PR URLs, repo links,
// integration baseUrls, share links) before rendering it in an href.
// Without this, a `javascript:alert(1)` pulled from a malicious webhook
// payload or compromised integration would execute on click.
//
// Rule: only http(s) URLs are returned as-is; everything else is replaced
// with `#` so the link becomes inert.

export function safeHref(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '#';
  const trimmed = raw.trim();
  if (!trimmed) return '#';
  // Reject javascript:, data:, vbscript:, file: protocols before URL parsing
  // so we catch whitespace-prefixed or case-variant attacks.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    const lower = trimmed.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      return '#';
    }
  }
  try {
    // Absolute URL — require http(s) scheme.
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return '#';
  } catch {
    // Relative URLs (start with / or ./ or ../) are fine — pass through.
    if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
      return trimmed;
    }
    return '#';
  }
}
