/**
 * Secret & PII Scanner
 *
 * Scans unified diffs for hardcoded secrets, API keys, credentials, and PII.
 * Runs automatically at session end when a diff is available.
 */

import { prisma } from '../db.js';
import { notifyOrgAdmins } from './notifications.js';

// ── Types ─────────────────────────────────────────────────────────

interface ScanRule {
  name: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  pattern: RegExp;
}

interface RawFinding {
  type: string;
  severity: string;
  filePath: string;
  lineNumber: number;
  match: string;
  ruleName: string;
}

// ── Detection Rules ───────────────────────────────────────────────

const SCAN_RULES: ScanRule[] = [
  // AWS Access Key
  {
    name: 'AWS Access Key',
    type: 'AWS_SECRET',
    severity: 'critical',
    pattern: /AKIA[0-9A-Z]{16}/,
  },
  // AWS Secret Key (in assignment)
  {
    name: 'AWS Secret Key',
    type: 'AWS_SECRET',
    severity: 'critical',
    pattern: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})/i,
  },
  // Private Keys
  {
    name: 'Private Key',
    type: 'PRIVATE_KEY',
    severity: 'critical',
    pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/,
  },
  // Generic API Key assignment
  {
    name: 'API Key Assignment',
    type: 'API_KEY',
    severity: 'high',
    pattern: /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*['"]([a-zA-Z0-9_\-]{20,})['"]/i,
  },
  // Connection Strings
  {
    name: 'Connection String',
    type: 'CONNECTION_STRING',
    severity: 'critical',
    pattern: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s'"]{10,}/i,
  },
  // JWT Tokens
  {
    name: 'JWT Token',
    type: 'JWT_TOKEN',
    severity: 'high',
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
  },
  // Passwords in code
  {
    name: 'Hardcoded Password',
    type: 'PASSWORD',
    severity: 'high',
    pattern: /(?:password|passwd|pwd|secret)\s*[:=]\s*['"]([^'"]{8,})['"]/i,
  },
  // GitHub / GitLab tokens
  {
    name: 'GitHub Token',
    type: 'API_KEY',
    severity: 'critical',
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/,
  },
  // Slack tokens
  {
    name: 'Slack Token',
    type: 'API_KEY',
    severity: 'high',
    pattern: /xox[bpors]-[0-9]{10,}-[a-zA-Z0-9-]+/,
  },
  // Generic secret/token assignment
  {
    name: 'Generic Secret',
    type: 'GENERIC_SECRET',
    severity: 'medium',
    pattern: /(?:secret|token|auth[_-]?key|access[_-]?key)\s*[:=]\s*['"]([a-zA-Z0-9_\-/+=]{20,})['"]/i,
  },
  // PII: Email addresses (only flag when they look hardcoded, not in comments/imports)
  {
    name: 'Hardcoded Email',
    type: 'PII_EMAIL',
    severity: 'low',
    pattern: /['"][a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}['"]/,
  },
];

// ── Diff Parser ───────────────────────────────────────────────────

interface DiffLine {
  filePath: string;
  lineNumber: number;
  content: string;
}

function parseDiffAddedLines(diff: string): DiffLine[] {
  const lines = diff.split('\n');
  const addedLines: DiffLine[] = [];
  let currentFile = '';
  let currentLine = 0;

  for (const line of lines) {
    // Detect file path from diff header: +++ b/path/to/file
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    // Also handle +++ a/path (for renames) — just skip
    if (line.startsWith('+++ ')) continue;
    if (line.startsWith('--- ')) continue;

    // Parse hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Skip binary file markers, diff headers
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('Binary ')) {
      continue;
    }

    // Added line (starts with +, not ++)
    if (line.startsWith('+') && !line.startsWith('++')) {
      addedLines.push({
        filePath: currentFile,
        lineNumber: currentLine,
        content: line.slice(1), // Remove the leading +
      });
      currentLine++;
      continue;
    }

    // Context line (no prefix) — increment line counter
    if (!line.startsWith('-')) {
      currentLine++;
    }
    // Removed lines (starts with -) — don't increment new line counter
  }

  return addedLines;
}

// ── Redaction ─────────────────────────────────────────────────────

function redact(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

// ── Main Scanner ──────────────────────────────────────────────────

export async function scanForSecrets(
  sessionId: string,
  diff: string,
  orgId: string,
): Promise<void> {
  if (!diff || diff.length === 0) return;

  const addedLines = parseDiffAddedLines(diff);
  if (addedLines.length === 0) return;

  const findings: RawFinding[] = [];
  const seen = new Set<string>(); // Deduplicate

  for (const line of addedLines) {
    // Skip obviously non-code lines (empty, very short)
    if (line.content.trim().length < 5) continue;

    // Skip comment-only lines
    const trimmed = line.content.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) {
      continue;
    }

    for (const rule of SCAN_RULES) {
      const match = line.content.match(rule.pattern);
      if (match) {
        // Deduplicate by type + file + matched value
        const matchedValue = match[1] || match[0];
        const dedupeKey = `${rule.type}:${line.filePath}:${matchedValue}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        findings.push({
          type: rule.type,
          severity: rule.severity,
          filePath: line.filePath,
          lineNumber: line.lineNumber,
          match: redact(matchedValue),
          ruleName: rule.name,
        });
      }
    }
  }

  if (findings.length === 0) return;

  // Store findings in database
  for (const f of findings) {
    await prisma.secretFinding.create({
      data: {
        sessionId,
        type: f.type,
        severity: f.severity,
        filePath: f.filePath,
        lineNumber: f.lineNumber,
        match: f.match,
        ruleName: f.ruleName,
      },
    });
  }

  // Log audit event
  await prisma.auditLog.create({
    data: {
      orgId,
      action: 'SECRET_DETECTED',
      resource: sessionId,
      metadata: JSON.stringify({
        sessionId,
        findingsCount: findings.length,
        types: [...new Set(findings.map((f) => f.type))],
        severities: [...new Set(findings.map((f) => f.severity))],
      }),
    },
  });

  // Notify admins for high/critical findings
  const criticalFindings = findings.filter(
    (f) => f.severity === 'high' || f.severity === 'critical',
  );

  if (criticalFindings.length > 0) {
    const typesSummary = [...new Set(criticalFindings.map((f) => f.ruleName))].join(', ');
    await notifyOrgAdmins(
      orgId,
      'SECRET_DETECTED',
      `Secret/PII Detected: ${criticalFindings.length} finding${criticalFindings.length !== 1 ? 's' : ''}`,
      `${typesSummary} found in session`,
      `/sessions/${sessionId}`,
      {
        sessionId,
        findingsCount: criticalFindings.length,
        types: [...new Set(criticalFindings.map((f) => f.type))],
      },
    );
  }

  console.log(`[secret-scanner] Session ${sessionId}: ${findings.length} finding(s)`);
}
