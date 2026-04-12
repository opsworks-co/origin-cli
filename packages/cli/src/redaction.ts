// ─── Secret Redaction Engine ──────────────────────────────────────────────
//
// Pattern-based + entropy-based secret detection.
// Used to redact sensitive data before writing to git objects or sending to API.

const REDACTED = '[REDACTED]';

// ─── Pattern Definitions ──────────────────────────────────────────────────

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // AWS
  { name: 'AWS Access Key', regex: /\b(AKIA[0-9A-Z]{16})\b/g },
  // AWS Secret Key: only match 40-char base64 strings on lines with AWS context keywords
  { name: 'AWS Secret Key', regex: /(?:aws.?secret.?access.?key|aws.?secret.?key|secret.?access.?key|AWS_SECRET_ACCESS_KEY|aws_secret|SecretAccessKey)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi },
  // GitHub
  { name: 'GitHub Token', regex: /\b(ghp_[A-Za-z0-9]{36,})\b/g },
  { name: 'GitHub OAuth', regex: /\b(gho_[A-Za-z0-9]{36,})\b/g },
  { name: 'GitHub App Token', regex: /\b(ghu_[A-Za-z0-9]{36,})\b/g },
  { name: 'GitHub App Install', regex: /\b(ghs_[A-Za-z0-9]{36,})\b/g },
  { name: 'GitHub PAT Fine', regex: /\b(github_pat_[A-Za-z0-9_]{50,})\b/g },
  // API keys — specific prefixes first (order matters: most specific before general)
  { name: 'Anthropic Key', regex: /\b(sk-ant-[A-Za-z0-9-]{32,})\b/g },
  { name: 'Stripe Secret Key', regex: /\b(sk_(?:live|test)_[A-Za-z0-9]{24,})\b/g },
  { name: 'Stripe Publishable Key', regex: /\b(pk_(?:live|test)_[A-Za-z0-9]{24,})\b/g },
  // OpenAI key: sk- prefix but NOT sk-ant- (Anthropic) or sk_live_/sk_test_ (Stripe)
  { name: 'OpenAI Key', regex: /\b(sk-(?!ant-)[A-Za-z0-9]{32,})\b/g },
  { name: 'Slack Token', regex: /\b(xoxb-[0-9]{10,}-[A-Za-z0-9]{24,})\b/g },
  { name: 'Slack Webhook', regex: /\b(xoxp-[0-9]{10,}-[A-Za-z0-9]{24,})\b/g },
  // Private keys
  { name: 'Private Key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  // JWTs
  { name: 'JWT', regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g },
  // Connection strings
  { name: 'DB Connection', regex: /\b((?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+)\b/g },
  // Generic high-entropy secrets
  { name: 'Bearer Token', regex: /\b(Bearer\s+[A-Za-z0-9_\-.]{20,})\b/g },
  // npm tokens
  { name: 'npm Token', regex: /\b(npm_[A-Za-z0-9]{36,})\b/g },
  // Heroku: only match UUIDs on lines with Heroku context
  { name: 'Heroku API Key', regex: /(?:HEROKU_API_KEY|heroku.?api.?key|heroku.?token|heroku.?auth)\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/gi },
];

// ─── Entropy Detection ───────────────────────────────────────────────────

/**
 * Calculate Shannon entropy of a string.
 * High entropy (>4.5) on long strings often indicates secrets/API keys.
 */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) {
    freq.set(c, (freq.get(c) || 0) + 1);
  }
  let entropy = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Check if a token looks like a high-entropy secret.
 */
function isHighEntropySecret(token: string): boolean {
  if (token.length < 15 || token.length > 90) return false;
  // Skip common non-secrets
  if (/^[a-z]+$/i.test(token)) return false;  // all letters
  if (/^[0-9]+$/.test(token)) return false;     // all numbers
  if (/^[a-f0-9]+$/i.test(token) && token.length <= 40) return false; // hex up to 40 chars (git SHA, short hashes)
  // Must have mixed character classes
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  const hasSpecial = /[^A-Za-z0-9]/.test(token);
  const classCount = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
  if (classCount < 3) return false;
  return shannonEntropy(token) > 4.5;
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface RedactionResult {
  redacted: string;
  foundCount: number;
  findings: Array<{ type: string; position: number }>;
}

/**
 * Redact secrets from text using pattern matching and entropy analysis.
 */
export function redactSecrets(text: string): RedactionResult {
  let result = text;
  const findings: Array<{ type: string; position: number }> = [];

  // 1. Pattern-based redaction
  for (const pattern of SECRET_PATTERNS) {
    // Reset regex state
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(result)) !== null) {
      findings.push({ type: pattern.name, position: match.index });
      const replacement = match[1]
        ? match[0].replace(match[1], REDACTED)
        : REDACTED;
      result = result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
      pattern.regex.lastIndex = match.index + replacement.length;
    }
  }

  // 2. Entropy-based detection on remaining tokens
  // Split on whitespace and common delimiters, check each token
  const tokenRegex = /\b([A-Za-z0-9_\-/.+=]{15,90})\b/g;
  let tokenMatch: RegExpExecArray | null;
  const entropyRedactions: Array<[number, number, string]> = [];

  while ((tokenMatch = tokenRegex.exec(result)) !== null) {
    const token = tokenMatch[1];
    if (token.includes(REDACTED)) continue; // Already redacted
    if (isHighEntropySecret(token)) {
      entropyRedactions.push([tokenMatch.index, tokenMatch[0].length, token]);
      findings.push({ type: 'High-entropy secret', position: tokenMatch.index });
    }
  }

  // Apply entropy redactions in reverse order to preserve positions
  for (let i = entropyRedactions.length - 1; i >= 0; i--) {
    const [pos, len] = entropyRedactions[i];
    result = result.slice(0, pos) + REDACTED + result.slice(pos + len);
  }

  return {
    redacted: result,
    foundCount: findings.length,
    findings,
  };
}

/**
 * Quick check if text likely contains secrets.
 */
export function containsSecrets(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) return true;
  }
  return false;
}
