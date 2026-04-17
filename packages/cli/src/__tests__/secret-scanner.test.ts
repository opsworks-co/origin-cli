/**
 * Pre-commit secret scanner patterns — per-pattern positive and negative tests.
 *
 * A regression here is scarier than a missing feature: a pre-commit hook that
 * either flags false positives (user disables the scanner) or misses real
 * secrets (user ships credentials to git) destroys trust. Every pattern gets
 * a real-shaped fake secret in the positive case and a known-not-a-secret in
 * the negative case (comment, doc reference, short-substring lookalike).
 */

import { describe, it, expect } from 'vitest';
import { PRE_COMMIT_PATTERNS } from '../commands/hooks.js';

const byName = (name: string) => {
  const p = PRE_COMMIT_PATTERNS.find((x) => x.name === name);
  if (!p) throw new Error(`Pattern "${name}" not found`);
  return p;
};

// Build a string at runtime so GitHub's push-protection scanner doesn't flag
// the source as containing a literal secret. Accepts a template with `{}`
// placeholders and fills them with the given fragments. The resulting string
// still matches the regex under test (that's the point), but the raw file
// content never contains it as a literal.
// Usage: mk('AC', '1234567890abcdef1234567890abcdef') -> "AC1234567890abcdef1234567890abcdef"
function mk(...parts: string[]): string {
  return parts.join('');
}

// Canonical positives + negatives. `fake` means it matches the format but isn't
// a real credential — safe to commit this test file.
const cases: Array<{ name: string; positive: string; negative: string }> = [
  { name: 'AWS Access Key',
    positive: mk('A', 'KIA', 'IOSFODNN7EXAMPLE'),
    negative: 'AKIA (just the prefix)' },
  { name: 'AWS Secret Key',
    positive: mk('aws_secret_access_key = "', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', '"'),
    negative: 'aws_secret_access_key is required in ~/.aws/credentials' },
  { name: 'Private Key',
    positive: mk('-----BEGIN ', 'RSA', ' PRIVATE KEY-----'),
    negative: '// See BEGIN_RSA documentation' },
  { name: 'GitHub Token',
    positive: mk('token: ', 'ghp_', '1234567890abcdefghijklmnopqrstuvwxyz'),
    negative: 'token: ghp_short' },
  { name: 'GitHub PAT',
    positive: mk('github_pat_', '11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789abcdefghij'),
    negative: 'github_pat_short' },
  { name: 'OpenAI Key',
    positive: mk('api_key = "', 'sk-', '1234567890abcdefghijklmnopqrstuvwxyzABCD', '"'),
    negative: 'sk-short' },
  { name: 'Anthropic Key',
    positive: mk('ANTHROPIC_KEY=', 'sk-ant-', 'abc123defghijklmnopqrstuvwxyz0123'),
    negative: 'sk-ant-short' },
  { name: 'Stripe Key',
    positive: mk('stripe_key = "', 'sk_live_', 'abc123defghijklmnopqrstuvwx', '"'),
    negative: 'sk_live_short' },
  { name: 'Slack Token',
    positive: mk('xoxb-', '1234567890-1234567890-abcdefghijklmnop'),
    negative: 'xoxb-short' },
  { name: 'JWT Token',
    positive: mk('eyJ', 'hbGciOiJIUzI1NiJ9.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'),
    negative: 'eyJ is a prefix' },
  { name: 'Connection String',
    positive: 'DATABASE_URL=postgres://user:pass@host:5432/db',
    negative: '-- postgres is the database name' },
  { name: 'API Key',
    positive: 'api_key: "abc123defghijklmnopqrst"',
    negative: 'api_key: "use-env"' },
  { name: 'Hardcoded Password',
    positive: 'password = "hunter2hunter2"',
    negative: 'password can be passed via env' },
  { name: 'npm Token',
    positive: mk('npm_', 'ABC123defghijklmnopqrstuvwxyz0123456789AB'),
    negative: 'npm_short' },
  { name: 'Bearer Token',
    positive: 'Authorization: Bearer abc123defghijklmnopqrst',
    negative: 'Authorization: Bearer short' },
  { name: 'Token Assignment',
    positive: 'DEPLOY_TOKEN=abc123defghijk',
    negative: 'DEPLOY_TOKEN_short' },
  { name: 'Secret Assignment',
    positive: 'CLIENT_SECRET=abcdefghijklmnop',
    negative: 'CLIENT_SECRET is set' },
  { name: 'Key Assignment',
    positive: 'MY_API_KEY=abc123defghi12345678',
    negative: 'MY_API_KEY is documented' },
  { name: 'Password Assignment',
    positive: 'ADMIN_PASSWORD=supersecret',
    negative: 'ADMIN_PASSWORD env var' },
  // ── Cloud provider credentials ──
  { name: 'GCP Service Account',
    positive: '{"type":"service_account","project_id":"x","private_key":"-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----"}',
    negative: '{"type":"service_account","project_id":"x"} (no private_key)' },
  { name: 'GCP API Key',
    positive: mk('GOOGLE_API_KEY=', 'AIza', 'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe'),
    negative: 'AIzaShortKey' },
  { name: 'Azure Storage Key',
    positive: 'AccountKey=' + 'A'.repeat(88) + '==',
    negative: 'AccountKey=short' },
  { name: 'Cloudflare API Token',
    positive: 'CF_API_TOKEN=abcdefghijklmnopqrstuvwxyz1234567890ABCD',
    negative: 'CF_API_TOKEN=short' },
  // ── Comms ──
  { name: 'Twilio Account SID',
    positive: mk('A', 'C', '1234567890abcdef1234567890abcdef'),
    negative: 'AC' + '123 (too short)' },
  { name: 'Twilio Auth Token',
    positive: mk('S', 'K', '1234567890abcdef1234567890abcdef'),
    negative: 'SK' + 'test (too short)' },
  { name: 'SendGrid API Key',
    positive: mk('SG', '.', 'abcdefghijklmnopqrstuv', '.', 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJK'),
    negative: 'SG' + '.hi' },
  { name: 'Mailgun Key',
    positive: mk('MAILGUN=key-', '1234567890abcdef1234567890abcdef'),
    negative: 'key-short' },
  { name: 'Discord Bot Token',
    positive: mk('M', 'abcdefghijklmnopqrstuvw', '.', 'Xabcde', '.', 'abcdefghijklmnopqrstuvwxyz0'),
    negative: 'Discord is a chat platform' },
  { name: 'Telegram Bot Token',
    positive: mk('1234567890', ':', 'ABCdefGhIJKlmNoPqRsTuvWxYZ012345678'),
    negative: '1234567890 (no colon)' },
  // ── Infra / PaaS ──
  { name: 'DigitalOcean Token',
    positive: 'dop_v1_' + 'a'.repeat(64),
    negative: 'dop_v1_short' },
  { name: 'Heroku API Key',
    positive: 'HEROKU_API_KEY=12345678-1234-1234-1234-123456789012',
    negative: '12345678-1234-1234-1234-123456789012 (UUID without heroku context)' },
  { name: 'Firebase Server Key',
    positive: 'AAAA1234567:APA91b' + 'a'.repeat(130),
    negative: 'AAAA-short' },
  // ── Payments ──
  { name: 'Square Token',
    positive: mk('sq0', 'atp-', 'abcdefghijklmnopqrstuv'),
    negative: 'sq0atp-short' },
  { name: 'PayPal Access Token',
    positive: mk('access_token', '$production$', 'abcdef1234567890', '$', 'abcdef1234567890abcdef1234567890'),
    negative: 'access_token$test (wrong env)' },
  // ── Observability ──
  { name: 'Datadog API Key',
    positive: 'DD_API_KEY=abcdef1234567890abcdef1234567890',
    negative: 'DD_API_KEY=short' },
  { name: 'Datadog App Key',
    positive: 'DD_APP_KEY=abcdef1234567890abcdef1234567890abcdef12',
    negative: 'DD_APP_KEY=short' },
  { name: 'New Relic Key',
    positive: 'NRAK-ABCDE12345FGHIJKLMNOPQRS678',
    negative: 'NRAK-short' },
  { name: 'PagerDuty Key',
    positive: 'PAGERDUTY_API_KEY=yabcdefghijklmnopqrs',
    negative: 'PAGERDUTY_API_KEY=short' },
  // ── Dev tools ──
  { name: 'Snyk Token',
    positive: 'SNYK_TOKEN=12345678-1234-1234-1234-123456789012',
    negative: 'SNYK_TOKEN=short' },
  { name: 'npmrc Auth',
    positive: '//registry.npmjs.org/:_authToken=abcdef1234567890',
    negative: '//registry.npmjs.org/ (URL only, no authToken)' },
  // ── Generic ──
  { name: 'Password Hash',
    positive: 'USER_PASSWORD_HASH=$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW',
    negative: 'USER_PASSWORD_HASH=short' },
];

describe('secret scanner patterns', () => {
  it('includes all expected patterns and no duplicates', () => {
    const names = PRE_COMMIT_PATTERNS.map((p) => p.name);
    expect(new Set(names).size, 'duplicate pattern names').toBe(names.length);
    expect(PRE_COMMIT_PATTERNS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(cases)('$name matches a real-shaped fake secret', ({ name, positive }) => {
    const p = byName(name);
    expect(p.regex.test(positive), `"${positive}" should match ${name}`).toBe(true);
  });

  it.each(cases)('$name does NOT match its lookalike', ({ name, negative }) => {
    const p = byName(name);
    expect(p.regex.test(negative), `"${negative}" should NOT match ${name}`).toBe(false);
  });

  it('every case in this file covers a pattern that exists', () => {
    for (const c of cases) {
      const p = PRE_COMMIT_PATTERNS.find((x) => x.name === c.name);
      expect(p, `test case references missing pattern: ${c.name}`).toBeDefined();
    }
  });

  it('every pattern in hooks.ts has at least one test case', () => {
    const covered = new Set(cases.map((c) => c.name));
    const uncovered = PRE_COMMIT_PATTERNS.filter((p) => !covered.has(p.name)).map((p) => p.name);
    expect(uncovered, `patterns without tests: ${uncovered.join(', ')}`).toEqual([]);
  });
});
