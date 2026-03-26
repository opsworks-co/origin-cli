import chalk from 'chalk';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { getGitRoot } from '../session-state.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface SessionGroup {
  sessionId: string;
  agent: string;
  model: string;
  intent: string;
  files: string[];
  commits: CommitInfo[];
  tokens: number;
  cost: number;
  timestamp: Date;
  risk: 'HIGH' | 'MEDIUM' | 'LOW';
  riskReason: string;
}

interface CommitInfo {
  sha: string;
  subject: string;
  date: string;
  files: string[];
  note: Record<string, any> | null;
}

interface IntentReviewData {
  branch: string;
  baseBranch: string;
  sessions: SessionGroup[];
  totalCommits: number;
  totalTokens: number;
  totalCost: number;
  uniqueAgents: string[];
  aiCommits: number;
  humanCommits: number;
  aiPct: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const execOpts = (cwd: string) => ({
  encoding: 'utf-8' as const,
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  maxBuffer: 10 * 1024 * 1024,
});

function readOriginNote(repoPath: string, sha: string): Record<string, any> | null {
  try {
    const note = execSync(`git notes --ref=origin show ${sha}`, execOpts(repoPath)).trim();
    return JSON.parse(note);
  } catch {
    return null;
  }
}

function getCommitTrailer(repoPath: string, sha: string, trailer: string): string | null {
  try {
    const value = execSync(
      `git log -1 --format="%(trailers:key=${trailer},valueonly)" ${sha}`,
      execOpts(repoPath),
    ).trim();
    return value || null;
  } catch {
    return null;
  }
}

function detectBaseBranch(repoPath: string): string {
  for (const candidate of ['main', 'master']) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, execOpts(repoPath));
      return candidate;
    } catch { /* try next */ }
  }
  return 'main';
}

function getCurrentBranch(repoPath: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', execOpts(repoPath)).trim();
  } catch {
    return 'unknown';
  }
}

function getCommitFiles(repoPath: string, sha: string): string[] {
  try {
    return execSync(
      `git diff-tree --no-commit-id --name-only -r ${sha}`,
      execOpts(repoPath),
    ).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function timeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Security / Risk Patterns ─────────────────────────────────────────────

const SECURITY_PATTERNS = [
  /auth/i, /crypto/i, /secret/i, /password/i, /token/i,
  /\.env/, /credentials/i, /permission/i, /oauth/i, /jwt/i,
  /session/i, /cookie/i, /csrf/i, /xss/i, /sanitiz/i,
  /encrypt/i, /decrypt/i, /hash/i, /sign/i, /verify/i,
  /key/i, /cert/i, /ssl/i, /tls/i,
];

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /\/__tests__\//,
  /test\//, /tests\//, /\.stories\.[jt]sx?$/,
];

const DOC_PATTERNS = [
  /\.md$/, /\.txt$/, /\.rst$/, /docs\//, /README/i,
  /CHANGELOG/i, /LICENSE/i,
];

const CONFIG_PATTERNS = [
  /\.json$/, /\.ya?ml$/, /\.toml$/, /\.ini$/, /\.cfg$/,
  /\.config\.[jt]s$/, /tsconfig/, /eslint/, /prettier/,
  /package\.json$/, /Dockerfile/, /docker-compose/,
];

function isSecurity(file: string): boolean {
  return SECURITY_PATTERNS.some(p => p.test(file));
}

function isTest(file: string): boolean {
  return TEST_PATTERNS.some(p => p.test(file));
}

function isDoc(file: string): boolean {
  return DOC_PATTERNS.some(p => p.test(file));
}

function isConfig(file: string): boolean {
  return CONFIG_PATTERNS.some(p => p.test(file));
}

function assessRisk(files: string[], allSessionFiles: Map<string, string[]>): { risk: 'HIGH' | 'MEDIUM' | 'LOW'; reason: string } {
  const hasSecurityFiles = files.some(f => isSecurity(f));
  const hasTestFiles = files.some(f => isTest(f));
  const allTests = files.every(f => isTest(f));
  const allDocs = files.every(f => isDoc(f));
  const allConfig = files.every(f => isConfig(f));

  // HIGH: security files without corresponding test changes
  if (hasSecurityFiles && !hasTestFiles) {
    return { risk: 'HIGH', reason: 'touches security files without test changes' };
  }

  // HIGH: large number of files changed
  if (files.length > 20) {
    return { risk: 'HIGH', reason: `large change (${files.length} files)` };
  }

  // LOW: test-only changes
  if (allTests) {
    return { risk: 'LOW', reason: 'test-only changes' };
  }

  // LOW: docs-only changes
  if (allDocs) {
    return { risk: 'LOW', reason: 'docs-only changes' };
  }

  // LOW: config-only changes
  if (allConfig) {
    return { risk: 'LOW', reason: 'config-only changes' };
  }

  // MEDIUM: core logic with partial test coverage
  if (hasSecurityFiles && hasTestFiles) {
    return { risk: 'MEDIUM', reason: 'touches auth logic with test coverage' };
  }

  // MEDIUM: non-trivial changes without tests
  const srcFiles = files.filter(f => !isTest(f) && !isDoc(f) && !isConfig(f));
  if (srcFiles.length > 0 && !hasTestFiles) {
    return { risk: 'MEDIUM', reason: 'source changes without test coverage' };
  }

  // LOW: everything else
  return { risk: 'LOW', reason: 'standard changes with tests' };
}

// ─── Data Collection ──────────────────────────────────────────────────────

function collectIntentData(repoPath: string, branch: string, baseBranch: string): IntentReviewData {
  // Get commits on branch not in base
  let commitLines: string[] = [];
  try {
    const log = execSync(
      `git log ${baseBranch}..${branch} --format="%H %ae %ai %s" --reverse`,
      execOpts(repoPath),
    ).trim();
    if (log) commitLines = log.split('\n').filter(Boolean);
  } catch {
    // Maybe baseBranch doesn't exist remotely, try origin/
    try {
      const log = execSync(
        `git log origin/${baseBranch}..${branch} --format="%H %ae %ai %s" --reverse`,
        execOpts(repoPath),
      ).trim();
      if (log) commitLines = log.split('\n').filter(Boolean);
    } catch { /* no commits */ }
  }

  if (commitLines.length === 0) {
    return {
      branch,
      baseBranch,
      sessions: [],
      totalCommits: 0,
      totalTokens: 0,
      totalCost: 0,
      uniqueAgents: [],
      aiCommits: 0,
      humanCommits: 0,
      aiPct: 0,
    };
  }

  // Parse commits
  const commits: CommitInfo[] = commitLines.map(line => {
    const parts = line.split(' ');
    const sha = parts[0];
    const date = parts[2] + ' ' + parts[3];
    const subject = parts.slice(4).join(' ');
    const files = getCommitFiles(repoPath, sha);
    const rawNote = readOriginNote(repoPath, sha);
    const note = rawNote?.origin || rawNote;
    return { sha, subject, date, files, note };
  });

  // Group by session
  const sessionMap = new Map<string, CommitInfo[]>();
  const humanCommits: CommitInfo[] = [];

  for (const commit of commits) {
    // Check for Origin-Session trailer
    const trailerSession = getCommitTrailer(repoPath, commit.sha, 'Origin-Session');
    const sessionId = commit.note?.sessionId || trailerSession || null;

    if (sessionId && sessionId !== 'unknown') {
      const existing = sessionMap.get(sessionId) || [];
      existing.push(commit);
      sessionMap.set(sessionId, existing);
    } else {
      humanCommits.push(commit);
    }
  }

  // Build session groups
  const allSessionFiles = new Map<string, string[]>();
  const sessions: SessionGroup[] = [];
  const agentSet = new Set<string>();

  for (const [sessionId, sessionCommits] of sessionMap) {
    const firstNote = sessionCommits.find(c => c.note)?.note;
    const agent = firstNote?.agent || firstNote?.model || 'unknown';
    const model = firstNote?.model || agent;
    agentSet.add(agent);

    // Collect all files for this session
    const fileSet = new Set<string>();
    for (const c of sessionCommits) {
      for (const f of c.files) fileSet.add(f);
    }
    const files = Array.from(fileSet);
    allSessionFiles.set(sessionId, files);

    // Extract intent from first prompt or commit subject
    const intent = firstNote?.prompt
      || firstNote?.firstPrompt
      || firstNote?.description
      || sessionCommits[0].subject
      || 'No intent recorded';

    // Aggregate tokens and cost
    let tokens = 0;
    let cost = 0;
    for (const c of sessionCommits) {
      if (c.note) {
        tokens += c.note.tokensUsed || c.note.totalTokens || 0;
        cost += c.note.costUsd || c.note.cost || 0;
      }
    }

    const timestamp = new Date(sessionCommits[0].date);
    const { risk, reason } = assessRisk(files, allSessionFiles);

    sessions.push({
      sessionId,
      agent,
      model,
      intent: intent.length > 120 ? intent.slice(0, 117) + '...' : intent,
      files,
      commits: sessionCommits,
      tokens,
      cost,
      timestamp,
      risk,
      riskReason: reason,
    });
  }

  // If there are human commits, add them as a pseudo-session
  if (humanCommits.length > 0) {
    const fileSet = new Set<string>();
    for (const c of humanCommits) {
      for (const f of c.files) fileSet.add(f);
    }
    const files = Array.from(fileSet);
    const { risk, reason } = assessRisk(files, allSessionFiles);

    sessions.push({
      sessionId: 'human',
      agent: 'Human',
      model: 'n/a',
      intent: `${humanCommits.length} manual commit(s)`,
      files,
      commits: humanCommits,
      tokens: 0,
      cost: 0,
      timestamp: new Date(humanCommits[0].date),
      risk,
      riskReason: reason,
    });
  }

  // Sort sessions by timestamp
  sessions.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const totalTokens = sessions.reduce((s, g) => s + g.tokens, 0);
  const totalCost = sessions.reduce((s, g) => s + g.cost, 0);
  const aiCommits = commits.filter(c => {
    const note = c.note;
    return note?.sessionId && note.sessionId !== 'unknown';
  }).length;
  const total = commits.length;

  return {
    branch,
    baseBranch,
    sessions,
    totalCommits: total,
    totalTokens,
    totalCost,
    uniqueAgents: Array.from(agentSet),
    aiCommits,
    humanCommits: total - aiCommits,
    aiPct: total > 0 ? Math.round((aiCommits / total) * 100) : 0,
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────

function riskColor(risk: 'HIGH' | 'MEDIUM' | 'LOW'): (text: string) => string {
  switch (risk) {
    case 'HIGH': return chalk.red;
    case 'MEDIUM': return chalk.yellow;
    case 'LOW': return chalk.green;
  }
}

function formatTerminal(data: IntentReviewData): string {
  const lines: string[] = [];
  const aiSessions = data.sessions.filter(s => s.sessionId !== 'human');

  lines.push('');
  lines.push(chalk.bold(`  Intent Review — ${data.branch} (${aiSessions.length} session${aiSessions.length !== 1 ? 's' : ''}, ${data.totalCommits} commit${data.totalCommits !== 1 ? 's' : ''})`));
  lines.push('');

  for (let i = 0; i < data.sessions.length; i++) {
    const s = data.sessions[i];
    const idx = i + 1;
    const isHuman = s.sessionId === 'human';
    const idLabel = isHuman ? 'Human' : s.sessionId.slice(0, 8);
    const agentLabel = isHuman ? '' : ` (${s.agent}, ${timeAgo(s.timestamp)})`;

    lines.push(chalk.bold(`  Session ${idx}: ${idLabel}${agentLabel}`));
    lines.push(`  Intent: ${chalk.cyan(`"${s.intent}"`)}`);
    lines.push(`  Files: ${chalk.gray(s.files.slice(0, 5).join(', '))}${s.files.length > 5 ? chalk.gray(` +${s.files.length - 5} more`) : ''}`);

    if (!isHuman) {
      lines.push(`  Tokens: ${formatTokens(s.tokens)} | Cost: $${s.cost.toFixed(2)}`);
    }

    const rc = riskColor(s.risk);
    lines.push(`  Risk: ${rc(s.risk)} — ${s.riskReason}`);
    lines.push('');
  }

  // Summary
  lines.push(chalk.bold('  Summary:'));
  if (data.uniqueAgents.length > 0) {
    lines.push(`  - ${data.uniqueAgents.length} agent${data.uniqueAgents.length !== 1 ? 's' : ''} used (${data.uniqueAgents.join(', ')})`);
  }
  lines.push(`  - ${data.aiPct}% AI-generated code`);

  const highRiskSessions = data.sessions.filter(s => s.risk === 'HIGH');
  if (highRiskSessions.length > 0) {
    lines.push(chalk.red(`  - ${highRiskSessions.length} HIGH risk session(s) — review recommended`));
  }

  const securitySessions = data.sessions.filter(s =>
    s.files.some(f => isSecurity(f)),
  );
  if (securitySessions.length > 0) {
    lines.push(chalk.yellow(`  - Auth/security logic modified — careful review needed`));
  }

  const untested = data.sessions.filter(s =>
    s.files.some(f => !isTest(f) && !isDoc(f) && !isConfig(f)) &&
    !s.files.some(f => isTest(f)),
  );
  if (untested.length > 0) {
    lines.push(`  - ${untested.length} session(s) without test coverage`);
  }

  if (data.totalCost > 0) {
    lines.push(`  - Total cost: $${data.totalCost.toFixed(2)} (${formatTokens(data.totalTokens)} tokens)`);
  }

  lines.push('');
  return lines.join('\n');
}

function formatMarkdown(data: IntentReviewData): string {
  const lines: string[] = [];
  const aiSessions = data.sessions.filter(s => s.sessionId !== 'human');

  lines.push(`# Intent Review — ${data.branch} (${aiSessions.length} sessions, ${data.totalCommits} commits)`);
  lines.push('');

  for (let i = 0; i < data.sessions.length; i++) {
    const s = data.sessions[i];
    const idx = i + 1;
    const isHuman = s.sessionId === 'human';
    const idLabel = isHuman ? 'Human' : s.sessionId.slice(0, 8);
    const agentLabel = isHuman ? '' : ` (${s.agent}, ${timeAgo(s.timestamp)})`;

    lines.push(`## Session ${idx}: ${idLabel}${agentLabel}`);
    lines.push('');
    lines.push(`**Intent:** "${s.intent}"`);
    lines.push(`**Files:** ${s.files.join(', ')}`);
    if (!isHuman) {
      lines.push(`**Tokens:** ${formatTokens(s.tokens)} | **Cost:** $${s.cost.toFixed(2)}`);
    }
    lines.push(`**Risk:** ${s.risk} — ${s.riskReason}`);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  if (data.uniqueAgents.length > 0) {
    lines.push(`- ${data.uniqueAgents.length} agent(s) used (${data.uniqueAgents.join(', ')})`);
  }
  lines.push(`- ${data.aiPct}% AI-generated code`);
  if (data.totalCost > 0) {
    lines.push(`- Total cost: $${data.totalCost.toFixed(2)} (${formatTokens(data.totalTokens)} tokens)`);
  }
  lines.push('');

  return lines.join('\n');
}

function formatJson(data: IntentReviewData): string {
  return JSON.stringify({
    branch: data.branch,
    baseBranch: data.baseBranch,
    totalCommits: data.totalCommits,
    totalTokens: data.totalTokens,
    totalCost: data.totalCost,
    uniqueAgents: data.uniqueAgents,
    aiCommits: data.aiCommits,
    humanCommits: data.humanCommits,
    aiPct: data.aiPct,
    sessions: data.sessions.map(s => ({
      sessionId: s.sessionId,
      agent: s.agent,
      model: s.model,
      intent: s.intent,
      files: s.files,
      commitCount: s.commits.length,
      commits: s.commits.map(c => c.sha),
      tokens: s.tokens,
      cost: s.cost,
      timestamp: s.timestamp.toISOString(),
      risk: s.risk,
      riskReason: s.riskReason,
    })),
  }, null, 2);
}

// ─── Command ──────────────────────────────────────────────────────────────

export async function intentReviewCommand(
  branch?: string,
  opts?: { format?: string; output?: string },
): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  const targetBranch = branch || getCurrentBranch(repoPath);
  const baseBranch = detectBaseBranch(repoPath);

  if (targetBranch === baseBranch) {
    console.error(chalk.yellow(`Already on ${baseBranch} — switch to a feature branch or specify one: origin intent-review <branch>`));
    return;
  }

  const data = collectIntentData(repoPath, targetBranch, baseBranch);

  if (data.totalCommits === 0) {
    console.log(chalk.gray(`No commits found on ${targetBranch} beyond ${baseBranch}.`));
    return;
  }

  const format = opts?.format || 'terminal';
  let output: string;

  switch (format) {
    case 'json':
      output = formatJson(data);
      break;
    case 'md':
      output = formatMarkdown(data);
      break;
    default:
      output = formatTerminal(data);
      break;
  }

  if (opts?.output) {
    try {
      writeFileSync(opts.output, output, 'utf-8');
      console.log(chalk.green(`Intent review written to ${opts.output}`));
    } catch (err: any) {
      console.error(chalk.red(`Error writing file: ${err.message}`));
    }
  } else {
    console.log(output);
  }
}
