import chalk from 'chalk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { getGitRoot } from '../session-state.js';
import { computeAttributionStats, isAiCommit } from '../attribution.js';

// ─── Types ───────────────────────────────────────────────────────────────

interface AuditSession {
  id: string;
  date: string;
  user: string;
  agent: string;
  model: string;
  durationMs: number;
  filesChanged: number;
  tokensUsed: number;
  costUsd: number;
  policyStatus: 'pass' | 'fail' | 'flagged';
  reviewStatus?: string;
  reviewerName?: string;
  linesAdded: number;
  linesRemoved: number;
}

interface PolicyEvent {
  date: string;
  policyName: string;
  action: 'ALLOW' | 'BLOCK' | 'FLAG';
  sessionId: string;
  details: string;
}

interface FileAttribution {
  filePath: string;
  aiPercentage: number;
  agents: string[];
  lastModified: string;
}

interface AuditData {
  repoName: string;
  from: string;
  to: string;
  sessions: AuditSession[];
  policyEvents: PolicyEvent[];
  fileAttributions: FileAttribution[];
  summary: {
    totalAiCommits: number;
    totalHumanCommits: number;
    aiPercentage: number;
    policiesEnforced: number;
    violationsDetected: number;
  };
}

// ─── Git Helpers ─────────────────────────────────────────────────────────

const execOpts = (cwd: string) => ({
  encoding: 'utf-8' as const,
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  maxBuffer: 10 * 1024 * 1024,
});

function getRepoName(repoPath: string): string {
  try {
    const remoteUrl = execSync('git remote get-url origin', execOpts(repoPath)).trim();
    const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {}
  return path.basename(repoPath);
}

function readOriginNote(repoPath: string, sha: string): Record<string, any> | null {
  try {
    const note = execSync(`git notes --ref=origin show ${sha}`, execOpts(repoPath)).trim();
    return JSON.parse(note);
  } catch {
    return null;
  }
}

// ─── Local Session Reader ────────────────────────────────────────────────

interface LocalSessionMetadata {
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  cost?: { usd: number };
  tokens?: { total: number };
  durationMs: number;
  filesChanged: string[];
  lines?: { added: number; removed: number };
  git?: { branch?: string; commitShas?: string[] };
  user?: string;
  agent?: string;
  agentSlug?: string;
}

function listLocalSessionsForAudit(repoPath: string, from: string, to: string): LocalSessionMetadata[] {
  const sessions: LocalSessionMetadata[] = [];
  const fromDate = new Date(from).getTime();
  const toDate = new Date(to).getTime();

  try {
    execSync('git rev-parse refs/heads/origin-sessions', execOpts(repoPath));
  } catch {
    return sessions;
  }

  try {
    const raw = execSync('git ls-tree --name-only origin-sessions sessions/', execOpts(repoPath)).trim();
    if (!raw) return sessions;

    const dirs = raw.split('\n').filter(Boolean).map(d => d.replace('sessions/', ''));

    for (const dir of dirs) {
      try {
        const metadataJson = execSync(`git show origin-sessions:sessions/${dir}/metadata.json`, execOpts(repoPath)).trim();
        const metadata = JSON.parse(metadataJson);
        const startedAt = metadata.startedAt || '';
        const sessionTime = new Date(startedAt).getTime();

        if (sessionTime >= fromDate && sessionTime <= toDate) {
          sessions.push({
            sessionId: metadata.sessionId || dir,
            model: metadata.model || 'unknown',
            startedAt,
            endedAt: metadata.endedAt || undefined,
            status: metadata.status || 'ended',
            cost: metadata.cost,
            tokens: metadata.tokens,
            durationMs: metadata.durationMs || 0,
            filesChanged: metadata.filesChanged || [],
            lines: metadata.lines,
            git: metadata.git,
            user: metadata.user || metadata.author,
            agent: metadata.agent || metadata.agentSlug,
          });
        }
      } catch {
        // Skip sessions with invalid metadata
      }
    }
  } catch {}

  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sessions;
}

// ─── Standalone Audit Data ───────────────────────────────────────────────

function collectStandaloneData(repoPath: string, from: string, to: string, authorFilter?: string, agentFilter?: string): AuditData {
  const repoName = getRepoName(repoPath);
  const sessions: AuditSession[] = [];
  const policyEvents: PolicyEvent[] = [];
  const fileAttributionMap = new Map<string, FileAttribution>();

  // Collect sessions from origin-sessions branch
  const localSessions = listLocalSessionsForAudit(repoPath, from, to);
  for (const s of localSessions) {
    if (authorFilter && !(s.user || '').toLowerCase().includes(authorFilter.toLowerCase())) continue;
    if (agentFilter && !(s.agent || s.model || '').toLowerCase().includes(agentFilter.toLowerCase())) continue;

    sessions.push({
      id: s.sessionId,
      date: s.startedAt,
      user: s.user || 'unknown',
      agent: s.agent || 'unknown',
      model: s.model,
      durationMs: s.durationMs,
      filesChanged: s.filesChanged.length,
      tokensUsed: s.tokens?.total || 0,
      costUsd: s.cost?.usd || 0,
      policyStatus: 'pass',
      linesAdded: s.lines?.added || 0,
      linesRemoved: s.lines?.removed || 0,
    });

    // Track file attributions
    for (const f of s.filesChanged) {
      const existing = fileAttributionMap.get(f);
      if (existing) {
        if (!existing.agents.includes(s.agent || s.model)) {
          existing.agents.push(s.agent || s.model);
        }
        existing.lastModified = s.startedAt;
      } else {
        fileAttributionMap.set(f, {
          filePath: f,
          aiPercentage: 0,
          agents: [s.agent || s.model],
          lastModified: s.startedAt,
        });
      }
    }
  }

  // Collect commit-level stats from git log
  let totalAiCommits = 0;
  let totalHumanCommits = 0;
  try {
    const logOutput = execSync(
      `git log --since="${from}" --until="${to}" --format="%H %ae %ai %s"`,
      execOpts(repoPath),
    ).trim();

    if (logOutput) {
      for (const line of logOutput.split('\n')) {
        const parts = line.split(' ');
        const sha = parts[0];
        if (!sha) continue;

        if (isAiCommit(repoPath, sha)) {
          totalAiCommits++;

          // Read note for policy data
          const rawNote = readOriginNote(repoPath, sha);
          const note = rawNote?.origin || rawNote;
          if (note?.policyResults) {
            for (const pr of note.policyResults) {
              policyEvents.push({
                date: note.timestamp || from,
                policyName: pr.policyName || pr.policy || 'unknown',
                action: pr.action || (pr.passed ? 'ALLOW' : 'BLOCK'),
                sessionId: note.sessionId || sha.slice(0, 8),
                details: pr.details || pr.message || '',
              });
            }
          }
        } else {
          totalHumanCommits++;
        }
      }
    }
  } catch {}

  const totalCommits = totalAiCommits + totalHumanCommits;
  const aiPercentage = totalCommits > 0 ? Math.round((totalAiCommits / totalCommits) * 100) : 0;

  // Try to compute file-level AI % using attribution
  try {
    const stats = computeAttributionStats(repoPath, `HEAD~50..HEAD`);
    // We already have the aggregate data
  } catch {}

  return {
    repoName,
    from,
    to,
    sessions,
    policyEvents,
    fileAttributions: Array.from(fileAttributionMap.values()),
    summary: {
      totalAiCommits,
      totalHumanCommits,
      aiPercentage,
      policiesEnforced: policyEvents.filter(e => e.action === 'ALLOW' || e.action === 'BLOCK').length,
      violationsDetected: policyEvents.filter(e => e.action === 'BLOCK').length,
    },
  };
}

// ─── Connected Mode Audit Data ───────────────────────────────────────────

async function collectConnectedData(repoPath: string | null, from: string, to: string, authorFilter?: string, agentFilter?: string): Promise<AuditData> {
  const repoName = repoPath ? getRepoName(repoPath) : 'unknown';
  const params: Record<string, string> = {
    from,
    to,
  };

  if (repoPath) {
    try {
      const remoteUrl = execSync('git remote get-url origin', execOpts(repoPath)).trim();
      const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) params.repoName = match[1];
    } catch {}
  }

  if (authorFilter) params.author = authorFilter;
  if (agentFilter) params.agent = agentFilter;

  // Fetch sessions
  const sessionsData = await api.getSessions({ ...params, limit: '500' }) as any;
  const platformSessions = sessionsData.sessions || [];

  // Fetch stats
  const statsData = await api.getStats(params) as any;

  // Fetch audit log for policy events
  const auditData = await api.getAuditLogs({ ...params, limit: '500' }) as any;
  const auditEntries = auditData.entries || [];

  const sessions: AuditSession[] = platformSessions.map((s: any) => {
    let policyStatus: 'pass' | 'fail' | 'flagged' = 'pass';
    if (s.review?.status === 'REJECTED') policyStatus = 'fail';
    else if (s.review?.status === 'FLAGGED') policyStatus = 'flagged';

    const files = (() => { try { const f = JSON.parse(s.filesChanged); return Array.isArray(f) ? f.length : 0; } catch { return 0; } })();

    return {
      id: s.id,
      date: s.createdAt || s.startedAt,
      user: s.commitAuthor || s.userName || 'unknown',
      agent: s.agentName || 'unknown',
      model: s.model || 'unknown',
      durationMs: s.durationMs || 0,
      filesChanged: files,
      tokensUsed: s.tokensUsed || 0,
      costUsd: s.costUsd || 0,
      policyStatus,
      reviewStatus: s.review?.status,
      reviewerName: s.review?.reviewerName,
      linesAdded: s.linesAdded || 0,
      linesRemoved: s.linesRemoved || 0,
    };
  });

  const policyEvents: PolicyEvent[] = auditEntries
    .filter((e: any) => e.action?.includes('POLICY') || e.action?.includes('VIOLATION'))
    .map((e: any) => ({
      date: e.createdAt,
      policyName: e.details?.policyName || e.resource || 'unknown',
      action: e.action?.includes('VIOLATION') ? 'BLOCK' as const :
              e.action?.includes('FLAG') ? 'FLAG' as const : 'ALLOW' as const,
      sessionId: e.details?.sessionId || e.resource?.slice(0, 8) || '—',
      details: e.details?.description || e.message || '',
    }));

  // Build file attributions from sessions
  const fileAttributionMap = new Map<string, FileAttribution>();
  for (const s of platformSessions) {
    let files: string[] = [];
    try { files = JSON.parse(s.filesChanged); } catch {}
    for (const f of files) {
      const existing = fileAttributionMap.get(f);
      const agentName = s.agentName || s.model || 'unknown';
      if (existing) {
        if (!existing.agents.includes(agentName)) existing.agents.push(agentName);
        existing.lastModified = s.createdAt || s.startedAt;
      } else {
        fileAttributionMap.set(f, {
          filePath: f,
          aiPercentage: 0,
          agents: [agentName],
          lastModified: s.createdAt || s.startedAt,
        });
      }
    }
  }

  const totalAiCommits = sessions.length;
  const totalHumanCommits = (statsData.sessionsThisWeek || 0) > totalAiCommits ? 0 : 0; // best effort
  const totalCommits = totalAiCommits + totalHumanCommits;

  return {
    repoName,
    from,
    to,
    sessions,
    policyEvents,
    fileAttributions: Array.from(fileAttributionMap.values()),
    summary: {
      totalAiCommits,
      totalHumanCommits: statsData.humanCommits || 0,
      aiPercentage: statsData.aiPercentage || (totalCommits > 0 ? Math.round((totalAiCommits / totalCommits) * 100) : 0),
      policiesEnforced: policyEvents.length,
      violationsDetected: statsData.policyViolations || policyEvents.filter(e => e.action === 'BLOCK').length,
    },
  };
}

// ─── Formatters ──────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().split('T')[0];
}

// ─── Markdown Output ─────────────────────────────────────────────────────

function renderMarkdown(data: AuditData): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Origin Audit Trail — ${data.repoName} — ${formatDate(data.from)} to ${formatDate(data.to)}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Compliance Summary
  lines.push('## Compliance Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total AI-generated commits | ${data.summary.totalAiCommits} |`);
  lines.push(`| Total human commits | ${data.summary.totalHumanCommits} |`);
  lines.push(`| AI authorship % | ${data.summary.aiPercentage}% |`);
  lines.push(`| Policies enforced | ${data.summary.policiesEnforced} |`);
  lines.push(`| Violations detected | ${data.summary.violationsDetected} |`);
  lines.push(`| Total sessions audited | ${data.sessions.length} |`);
  lines.push('');

  // Session Log Table
  lines.push('## Session Log');
  lines.push('');
  if (data.sessions.length === 0) {
    lines.push('No sessions in this date range.');
  } else {
    lines.push('| Date | User | Agent | Model | Duration | Files | Tokens | Cost | Policy Status |');
    lines.push('|------|------|-------|-------|----------|-------|--------|------|---------------|');
    for (const s of data.sessions) {
      const status = s.policyStatus === 'pass' ? 'PASS' :
                     s.policyStatus === 'fail' ? 'FAIL' : 'FLAGGED';
      lines.push(`| ${formatDate(s.date)} | ${s.user} | ${s.agent} | ${s.model} | ${formatDuration(s.durationMs)} | ${s.filesChanged} | ${s.tokensUsed.toLocaleString()} | $${s.costUsd.toFixed(2)} | ${status} |`);
    }
  }
  lines.push('');

  // Policy Enforcement Log
  lines.push('## Policy Enforcement Log');
  lines.push('');
  if (data.policyEvents.length === 0) {
    lines.push('No policy events in this date range.');
  } else {
    lines.push('| Date | Policy | Action | Session | Details |');
    lines.push('|------|--------|--------|---------|---------|');
    for (const e of data.policyEvents) {
      lines.push(`| ${formatDate(e.date)} | ${e.policyName} | ${e.action} | ${e.sessionId.slice(0, 8)} | ${e.details} |`);
    }
  }
  lines.push('');

  // File Attribution Summary
  lines.push('## File Attribution Summary');
  lines.push('');
  if (data.fileAttributions.length === 0) {
    lines.push('No AI-touched files in this date range.');
  } else {
    lines.push('| File | AI % | Agents | Last Modified |');
    lines.push('|------|------|--------|---------------|');
    for (const f of data.fileAttributions.slice(0, 100)) {
      lines.push(`| ${f.filePath} | ${f.aiPercentage}% | ${f.agents.join(', ')} | ${formatDate(f.lastModified)} |`);
    }
    if (data.fileAttributions.length > 100) {
      lines.push(`| ... and ${data.fileAttributions.length - 100} more files | | | |`);
    }
  }
  lines.push('');

  // Approval Chain
  lines.push('## Approval Chain');
  lines.push('');
  const reviewed = data.sessions.filter(s => s.reviewStatus);
  if (reviewed.length === 0) {
    lines.push('No review data available.');
  } else {
    lines.push('| Session | Date | Review Status | Reviewer |');
    lines.push('|---------|------|---------------|----------|');
    for (const s of reviewed) {
      lines.push(`| ${s.id.slice(0, 8)} | ${formatDate(s.date)} | ${s.reviewStatus} | ${s.reviewerName || '—'} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ─── JSON Output ─────────────────────────────────────────────────────────

function renderJson(data: AuditData): string {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    repository: data.repoName,
    dateRange: { from: data.from, to: data.to },
    complianceSummary: data.summary,
    sessions: data.sessions,
    policyEnforcement: data.policyEvents,
    fileAttribution: data.fileAttributions,
    approvalChain: data.sessions
      .filter(s => s.reviewStatus)
      .map(s => ({
        sessionId: s.id,
        date: s.date,
        reviewStatus: s.reviewStatus,
        reviewer: s.reviewerName,
      })),
  }, null, 2);
}

// ─── CSV Output ──────────────────────────────────────────────────────────

function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function renderCsv(data: AuditData): string {
  const headers = [
    'session_id', 'date', 'user', 'agent', 'model', 'duration_ms',
    'files_changed', 'tokens_used', 'cost_usd', 'lines_added',
    'lines_removed', 'policy_status', 'review_status', 'reviewer',
  ];
  const rows = [headers.join(',')];

  for (const s of data.sessions) {
    rows.push([
      escapeCsv(s.id),
      escapeCsv(s.date),
      escapeCsv(s.user),
      escapeCsv(s.agent),
      escapeCsv(s.model),
      String(s.durationMs),
      String(s.filesChanged),
      String(s.tokensUsed),
      s.costUsd.toFixed(2),
      String(s.linesAdded),
      String(s.linesRemoved),
      s.policyStatus,
      s.reviewStatus || '',
      escapeCsv(s.reviewerName || ''),
    ].join(','));
  }

  return rows.join('\n');
}

// ─── Command ─────────────────────────────────────────────────────────────

export interface AuditCommandOpts {
  from?: string;
  to?: string;
  author?: string;
  agent?: string;
  format?: 'md' | 'json' | 'csv';
  output?: string;
  // Legacy options from old audit command
  action?: string;
  limit?: string;
}

export async function auditCommand(opts: AuditCommandOpts) {
  const format = opts.format || 'md';
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = opts.from || thirtyDaysAgo.toISOString().split('T')[0];
  const to = opts.to || now.toISOString().split('T')[0];
  const repoPath = getGitRoot(process.cwd());

  let data: AuditData;

  if (isConnectedMode()) {
    try {
      data = await collectConnectedData(repoPath, from, to, opts.author, opts.agent);

      // If we also have a local repo, merge in local standalone data
      if (repoPath) {
        try {
          const localData = collectStandaloneData(repoPath, from, to, opts.author, opts.agent);
          // Merge file attributions from local git analysis
          if (localData.fileAttributions.length > data.fileAttributions.length) {
            data.fileAttributions = localData.fileAttributions;
          }
          // Use local commit stats if platform doesn't have them
          if (data.summary.totalHumanCommits === 0 && localData.summary.totalHumanCommits > 0) {
            data.summary.totalHumanCommits = localData.summary.totalHumanCommits;
            data.summary.aiPercentage = localData.summary.aiPercentage;
          }
        } catch {}
      }
    } catch (err: any) {
      // Fall back to standalone if API fails
      if (!repoPath) {
        console.error(chalk.red('Error:'), err.message);
        return;
      }
      console.error(chalk.yellow('Warning: API unavailable, using local data only.'));
      data = collectStandaloneData(repoPath, from, to, opts.author, opts.agent);
    }
  } else {
    if (!repoPath) {
      console.error(chalk.red('Error: Not in a git repository. Run from a repo or use origin login for remote data.'));
      return;
    }
    data = collectStandaloneData(repoPath, from, to, opts.author, opts.agent);
  }

  // Render output
  let output: string;
  switch (format) {
    case 'json':
      output = renderJson(data);
      break;
    case 'csv':
      output = renderCsv(data);
      break;
    default:
      output = renderMarkdown(data);
      break;
  }

  // Write to file or stdout
  if (opts.output) {
    const outPath = path.resolve(opts.output);
    fs.writeFileSync(outPath, output, 'utf-8');
    console.log(chalk.green(`Audit trail written to ${outPath}`));
  } else {
    console.log(output);
  }
}
