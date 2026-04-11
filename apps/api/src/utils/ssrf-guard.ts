// ── SSRF Guard ───────────────────────────────────────────────────────────
// IntegrationConfig.baseUrl is settable by any org admin (self-hosted
// GitHub Enterprise and GitLab Self-Managed are legitimate use cases, so
// we cannot hard-allowlist github.com / gitlab.com). That means a
// malicious or compromised admin could set baseUrl to an internal host
// (localhost, 169.254.169.254, 10.0.0.0/8, etc.) and the Origin server
// would happily forward OAuth secrets, PATs, and user metadata to that
// host on every test/callback/sync.
//
// This module enforces two simple rules on any URL we fetch based on
// admin-supplied baseUrl:
//   1. Protocol must be https (no http, file, gopher, etc.).
//   2. Hostname must not resolve to a private, loopback, link-local, or
//      unspecified address literal. For non-literal hostnames we can't
//      do DNS rebinding protection here without a resolver hook, so we
//      also reject a hard-coded list of suspicious names (localhost,
//      *.local, *.internal).
//
// Call `assertSafeExternalUrl(url, ctx)` anywhere we're about to fetch
// a URL derived from IntegrationConfig.baseUrl or user input. Throws
// on rejection so callers get a loud failure instead of silent SSRF.

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
]);

const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.intranet'];

/**
 * Returns true if the given hostname is an IPv4 address literal that falls
 * inside a private, loopback, link-local, or reserved range.
 */
function isBlockedIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return true; // malformed
  const [a, b] = parts;
  // 0.0.0.0/8 — unspecified / current network
  if (a === 0) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes 169.254.169.254 AWS metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 198.18.0.0/15 — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return true;
  return false;
}

/**
 * Returns true if the given hostname is an IPv6 address literal that falls
 * inside a loopback, link-local, unique-local, or unspecified range.
 */
function isBlockedIPv6(host: string): boolean {
  // URL.hostname strips brackets for us.
  const h = host.toLowerCase();
  if (!h.includes(':')) return false;
  // ::, ::1
  if (h === '::' || h === '::1') return true;
  // fe80::/10 link-local
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
  // fc00::/7 unique local
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  // ff00::/8 multicast
  if (h.startsWith('ff')) return true;
  // IPv4-mapped: ::ffff:a.b.c.d — check the embedded v4
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && isBlockedIPv4(mapped[1])) return true;
  return false;
}

export interface SafeUrlCheck {
  ok: boolean;
  reason?: string;
}

export function checkSafeExternalUrl(raw: string | null | undefined): SafeUrlCheck {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'URL is empty' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL is not parseable' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `protocol ${parsed.protocol} is not allowed (https only)` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    return { ok: false, reason: 'URL has no hostname' };
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `hostname ${host} is blocked` };
  }
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { ok: false, reason: `hostname ${host} uses blocked suffix ${suffix}` };
    }
  }
  if (isBlockedIPv4(host)) {
    return { ok: false, reason: `hostname ${host} is a blocked IPv4 literal` };
  }
  if (isBlockedIPv6(host)) {
    return { ok: false, reason: `hostname ${host} is a blocked IPv6 literal` };
  }
  return { ok: true };
}

/**
 * Throws if the URL is unsafe. Use this in fetch-before-use paths where we
 * want to loudly fail rather than silently redirect to an internal host.
 */
export function assertSafeExternalUrl(raw: string | null | undefined, ctx: string): void {
  const check = checkSafeExternalUrl(raw);
  if (!check.ok) {
    throw new Error(`[ssrf-guard:${ctx}] rejected URL: ${check.reason}`);
  }
}
