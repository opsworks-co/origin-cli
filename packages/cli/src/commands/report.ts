import chalk from 'chalk';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { getGitRoot } from '../session-state.js';

// ─── Types ───────────────────────────────────────────────────────────────

interface ReportData {
  repoName: string;
  dateRange: { from: string; to: string };
  summary: {
    totalSessions: number;
    totalCost: number;
    totalTokens: number;
    uniqueAgents: string[];
    uniqueUsers: string[];
    filesChanged: number;
  };
  costByModel: Array<{ model: string; sessions: number; tokens: number; cost: number }>;
  costByUser: Array<{ user: string; sessions: number; cost: number; pct: number }>;
  agentUsage: Array<{ agent: string; sessions: number; avgDuration: string }>;
  topFiles: Array<{ file: string; sessions: number }>;
  policyViolations: number;
  dailyActivity: Array<{ date: string; sessions: number }>;
  aiVsHuman: { aiCommits: number; humanCommits: number; aiPct: number; humanPct: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const execOpts = (cwd: string) => ({
  encoding: 'utf-8' as const,
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  maxBuffer: 10 * 1024 * 1024,
});

function parseDaysFromRange(range: string): number {
  const match = range.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : 7;
}

function getRepoName(repoPath: string): string {
  try {
    const remoteUrl = execSync('git remote get-url origin', execOpts(repoPath)).trim();
    const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch { /* ignore */ }
  // Fallback to directory name
  return repoPath.split('/').filter(Boolean).pop() || 'unknown';
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function readOriginNote(repoPath: string, sha: string): Record<string, any> | null {
  try {
    const note = execSync(`git notes --ref=origin show ${sha}`, execOpts(repoPath)).trim();
    return JSON.parse(note);
  } catch {
    return null;
  }
}

// ─── Data Collection: Connected Mode ─────────────────────────────────────

async function collectConnectedData(repoPath: string | null, days: number): Promise<ReportData> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const repoName = repoPath ? getRepoName(repoPath) : 'all repos';

  const params: Record<string, string> = {
    from: formatDate(from),
    to: formatDate(now),
    days: String(days),
  };
  if (repoPath) {
    const name = getRepoName(repoPath);
    if (name.includes('/')) params.repoName = name;
  }

  const s = await api.getStats(params) as any;

  // Build cost-by-model
  const costByModel = (s.costByModel || []).map((m: any) => ({
    model: m.model,
    sessions: m.count || 0,
    tokens: m.tokens || 0,
    cost: m.cost || 0,
  }));

  // Build cost-by-user
  const totalCost = s.estimatedCostThisMonth || 0;
  const costByUser = (s.costByUser || []).map((u: any) => ({
    user: u.name || u.email || 'unknown',
    sessions: u.sessions || 0,
    cost: u.cost || 0,
    pct: totalCost > 0 ? Math.round((u.cost / totalCost) * 100) : 0,
  }));

  // Build agent usage
  const agentUsage = (s.topAgents || []).map((a: any) => ({
    agent: a.name || a.model || 'unknown',
    sessions: a.count || 0,
    avgDuration: a.avgDuration || '—',
  }));

  // Build daily activity from API or git
  const dailyActivity: Array<{ date: string; sessions: number }> = [];
  if (s.dailyActivity) {
    for (const d of s.dailyActivity) {
      dailyActivity.push({ date: d.date, sessions: d.sessions || d.count || 0 });
    }
  }

  // AI vs Human from local git if available
  const aiVsHuman = { aiCommits: 0, humanCommits: 0, aiPct: 0, humanPct: 0 };
  if (repoPath) {
    const local = collectLocalGitData(repoPath, days);
    aiVsHuman.aiCommits = local.aiVsHuman.aiCommits;
    aiVsHuman.humanCommits = local.aiVsHuman.humanCommits;
    aiVsHuman.aiPct = local.aiVsHuman.aiPct;
    aiVsHuman.humanPct = local.aiVsHuman.humanPct;
    if (dailyActivity.length === 0) {
      dailyActivity.push(...local.dailyActivity);
    }
  }

  return {
    repoName,
    dateRange: { from: formatDate(from), to: formatDate(now) },
    summary: {
      totalSessions: s.sessionsThisWeek || 0,
      totalCost: totalCost,
      totalTokens: s.tokensUsed || 0,
      uniqueAgents: (s.topAgents || []).map((a: any) => a.name || a.model),
      uniqueUsers: (s.costByUser || []).map((u: any) => u.name || u.email),
      filesChanged: s.filesChanged || 0,
    },
    costByModel,
    costByUser,
    agentUsage,
    topFiles: (s.topFiles || []).slice(0, 10).map((f: any) => ({
      file: f.file || f.path || f.name,
      sessions: f.sessions || f.count || 0,
    })),
    policyViolations: s.policyViolations || 0,
    dailyActivity,
    aiVsHuman,
  };
}

// ─── Data Collection: Standalone (Git) Mode ──────────────────────────────

function collectLocalGitData(repoPath: string, days: number): ReportData {
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const repoName = getRepoName(repoPath);
  const sinceStr = `${days} days ago`;

  // Get commits in range
  let commits: Array<{ sha: string; email: string; date: string; subject: string }> = [];
  try {
    const log = execSync(
      `git log --since="${sinceStr}" --format="%H %ae %ai %s"`,
      execOpts(repoPath),
    ).trim();
    if (log) {
      commits = log.split('\n').filter(Boolean).map(line => {
        const parts = line.split(' ');
        const sha = parts[0];
        const email = parts[1];
        const date = parts[2]; // YYYY-MM-DD
        const subject = parts.slice(4).join(' ');
        return { sha, email, date, subject };
      });
    }
  } catch { /* no commits */ }

  // Analyze each commit
  let aiCommits = 0;
  let humanCommits = 0;
  const userSessions = new Map<string, number>();
  const modelSessions = new Map<string, { sessions: number; tokens: number; cost: number }>();
  const agentMap = new Map<string, { sessions: number; durations: number[] }>();
  const fileHits = new Map<string, number>();
  const dailyMap = new Map<string, number>();
  const agents = new Set<string>();
  const users = new Set<string>();
  const allFiles = new Set<string>();

  for (const commit of commits) {
    users.add(commit.email);
    userSessions.set(commit.email, (userSessions.get(commit.email) || 0) + 1);

    // Daily count
    dailyMap.set(commit.date, (dailyMap.get(commit.date) || 0) + 1);

    // Read origin note
    const rawNote = readOriginNote(repoPath, commit.sha);
    const note = rawNote?.origin || rawNote;
    const isAi = !!note?.sessionId && note.sessionId !== 'unknown';

    if (isAi) {
      aiCommits++;
      const model = note?.model || 'unknown';
      const agent = note?.agent || model;
      agents.add(agent);

      const entry = modelSessions.get(model) || { sessions: 0, tokens: 0, cost: 0 };
      entry.sessions++;
      entry.tokens += note?.tokensUsed || note?.totalTokens || 0;
      entry.cost += note?.costUsd || note?.cost || 0;
      modelSessions.set(model, entry);

      const agentEntry = agentMap.get(agent) || { sessions: 0, durations: [] };
      agentEntry.sessions++;
      if (note?.durationMs) agentEntry.durations.push(note.durationMs);
      agentMap.set(agent, agentEntry);
    } else {
      humanCommits++;
    }

    // Files changed
    try {
      const files = execSync(
        `git diff-tree --no-commit-id --name-only -r ${commit.sha}`,
        execOpts(repoPath),
      ).trim().split('\n').filter(Boolean);
      for (const f of files) {
        allFiles.add(f);
        if (isAi) {
          fileHits.set(f, (fileHits.get(f) || 0) + 1);
        }
      }
    } catch { /* skip */ }
  }

  // Build cost-by-model
  const costByModel = Array.from(modelSessions.entries()).map(([model, data]) => ({
    model,
    sessions: data.sessions,
    tokens: data.tokens,
    cost: data.cost,
  })).sort((a, b) => b.cost - a.cost);

  // Build cost-by-user
  const totalCost = costByModel.reduce((s, m) => s + m.cost, 0);
  const costByUser = Array.from(userSessions.entries()).map(([user, sessions]) => ({
    user,
    sessions,
    cost: 0,
    pct: 0,
  }));

  // Build agent usage
  const agentUsage = Array.from(agentMap.entries()).map(([agent, data]) => {
    const avgMs = data.durations.length > 0
      ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length
      : 0;
    const avgMin = avgMs > 0 ? `${Math.round(avgMs / 60000)}m` : '—';
    return { agent, sessions: data.sessions, avgDuration: avgMin };
  }).sort((a, b) => b.sessions - a.sessions);

  // Top files
  const topFiles = Array.from(fileHits.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, sessions]) => ({ file, sessions }));

  // Daily activity
  const dailyActivity = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, sessions]) => ({ date, sessions }));

  const total = aiCommits + humanCommits;
  const aiPct = total > 0 ? Math.round((aiCommits / total) * 100) : 0;

  return {
    repoName,
    dateRange: { from: formatDate(from), to: formatDate(now) },
    summary: {
      totalSessions: aiCommits,
      totalCost: totalCost,
      totalTokens: costByModel.reduce((s, m) => s + m.tokens, 0),
      uniqueAgents: Array.from(agents),
      uniqueUsers: Array.from(users),
      filesChanged: allFiles.size,
    },
    costByModel,
    costByUser,
    agentUsage,
    topFiles,
    policyViolations: 0,
    dailyActivity,
    aiVsHuman: {
      aiCommits,
      humanCommits,
      aiPct,
      humanPct: total > 0 ? 100 - aiPct : 0,
    },
  };
}

// ─── Markdown Formatter ──────────────────────────────────────────────────

function renderAsciiChart(daily: Array<{ date: string; sessions: number }>): string {
  if (daily.length === 0) return '_No activity data._\n';
  const max = Math.max(...daily.map(d => d.sessions), 1);
  const barWidth = 30;
  const lines: string[] = [];
  for (const d of daily) {
    const filled = Math.round((d.sessions / max) * barWidth);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    lines.push(`${d.date}  ${bar}  ${d.sessions}`);
  }
  return '```\n' + lines.join('\n') + '\n```\n';
}

function formatMarkdown(data: ReportData): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Origin Sprint Report \u2014 ${data.repoName} \u2014 ${data.dateRange.from} to ${data.dateRange.to}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Total sessions | ${data.summary.totalSessions} |`);
  lines.push(`| Total cost | $${data.summary.totalCost.toFixed(2)} |`);
  lines.push(`| Total tokens | ${data.summary.totalTokens.toLocaleString()} |`);
  lines.push(`| Unique agents | ${data.summary.uniqueAgents.length} |`);
  lines.push(`| Unique users | ${data.summary.uniqueUsers.length} |`);
  lines.push(`| Files changed | ${data.summary.filesChanged} |`);
  lines.push('');

  // Cost by model
  if (data.costByModel.length > 0) {
    lines.push('## Cost Breakdown by Model');
    lines.push('');
    lines.push('| Model | Sessions | Tokens | Cost |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const m of data.costByModel) {
      lines.push(`| ${m.model} | ${m.sessions} | ${m.tokens.toLocaleString()} | $${m.cost.toFixed(2)} |`);
    }
    lines.push('');
  }

  // Cost by user
  if (data.costByUser.length > 0) {
    lines.push('## Cost Breakdown by User');
    lines.push('');
    lines.push('| User | Sessions | Cost | % of Total |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const u of data.costByUser) {
      lines.push(`| ${u.user} | ${u.sessions} | $${u.cost.toFixed(2)} | ${u.pct}% |`);
    }
    lines.push('');
  }

  // Agent usage
  if (data.agentUsage.length > 0) {
    lines.push('## Agent Usage');
    lines.push('');
    lines.push('| Agent | Sessions | Avg Duration |');
    lines.push('| --- | ---: | --- |');
    for (const a of data.agentUsage) {
      lines.push(`| ${a.agent} | ${a.sessions} | ${a.avgDuration} |`);
    }
    lines.push('');
  }

  // Top 10 modified files
  if (data.topFiles.length > 0) {
    lines.push('## Top 10 Modified Files');
    lines.push('');
    lines.push('| File | AI Sessions |');
    lines.push('| --- | ---: |');
    for (const f of data.topFiles) {
      lines.push(`| ${f.file} | ${f.sessions} |`);
    }
    lines.push('');
  }

  // Policy violations
  lines.push('## Policy Violations');
  lines.push('');
  lines.push(`${data.policyViolations > 0 ? data.policyViolations + ' violations detected.' : 'No violations.'}`);
  lines.push('');

  // Daily activity
  lines.push('## Daily Activity');
  lines.push('');
  lines.push(renderAsciiChart(data.dailyActivity));

  // AI vs Human
  lines.push('## AI vs Human Ratio');
  lines.push('');
  lines.push(`| | Commits | % |`);
  lines.push(`| --- | ---: | ---: |`);
  lines.push(`| AI | ${data.aiVsHuman.aiCommits} | ${data.aiVsHuman.aiPct}% |`);
  lines.push(`| Human | ${data.aiVsHuman.humanCommits} | ${data.aiVsHuman.humanPct}% |`);
  lines.push('');

  // ROI Estimate
  const hourlyRate = 75;
  const totalSessions = data.summary.totalSessions;
  // Parse avg duration from agent usage data (fallback 8 min)
  let avgDurationMin = 8;
  if (data.agentUsage.length > 0) {
    const parsed = data.agentUsage
      .map(a => parseInt(a.avgDuration, 10))
      .filter(n => !isNaN(n) && n > 0);
    if (parsed.length > 0) {
      avgDurationMin = parsed.reduce((a, b) => a + b, 0) / parsed.length;
    }
  }
  const timeSavedHours = (totalSessions * avgDurationMin * 2) / 60;
  const costSaved = timeSavedHours * hourlyRate;
  const aiSpend = data.summary.totalCost;
  const roi = aiSpend > 0 ? costSaved / aiSpend : 0;
  const netSavings = costSaved - aiSpend;

  lines.push('## ROI Estimate');
  lines.push('');
  lines.push(`_Based on $${hourlyRate}/hr developer rate, ${totalSessions} sessions, ~${avgDurationMin.toFixed(0)}min avg duration, 3x AI speed multiplier._`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | ---: |');
  lines.push(`| AI Spend | $${aiSpend.toFixed(2)} |`);
  lines.push(`| Time Saved | ${timeSavedHours.toFixed(1)} hrs |`);
  lines.push(`| Developer Cost Saved | $${costSaved.toFixed(0)} |`);
  lines.push(`| Net Savings | $${netSavings.toFixed(0)} |`);
  lines.push(`| ROI | ${roi.toFixed(0)}x |`);
  lines.push('');

  return lines.join('\n');
}

// ─── JSON Formatter ──────────────────────────────────────────────────────

function formatJson(data: ReportData): string {
  return JSON.stringify(data, null, 2);
}

// ─── CSV Formatter ───────────────────────────────────────────────────────

function formatCsv(data: ReportData): string {
  const rows: string[] = [];
  rows.push('date,model,agent,user,sessions,tokens,cost');
  // Flatten daily + model data into rows
  for (const m of data.costByModel) {
    rows.push(`${data.dateRange.from} to ${data.dateRange.to},${m.model},,${m.sessions},${m.tokens},${m.cost.toFixed(2)}`);
  }
  for (const u of data.costByUser) {
    rows.push(`${data.dateRange.from} to ${data.dateRange.to},,${u.user},${u.sessions},,${u.cost.toFixed(2)}`);
  }
  if (rows.length === 1) {
    // At minimum output daily activity
    for (const d of data.dailyActivity) {
      rows.push(`${d.date},,,,${d.sessions},,`);
    }
  }
  return rows.join('\n');
}

// ─── Command ─────────────────────────────────────────────────────────────

export async function reportCommand(opts?: { range?: string; output?: string; format?: string }) {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  const days = parseDaysFromRange(opts?.range || '7d');
  const format = opts?.format || 'md';

  let data: ReportData;

  try {
    if (isConnectedMode()) {
      data = await collectConnectedData(repoPath, days);
    } else if (repoPath) {
      data = collectLocalGitData(repoPath, days);
    } else {
      console.error(chalk.red('Error: Not in a git repository and not logged in.'));
      return;
    }
  } catch (err: any) {
    console.error(chalk.red('Error collecting report data:'), err.message);
    return;
  }

  let output: string;
  switch (format) {
    case 'json':
      output = formatJson(data);
      break;
    case 'csv':
      output = formatCsv(data);
      break;
    case 'md':
    default:
      output = formatMarkdown(data);
      break;
  }

  if (opts?.output) {
    try {
      writeFileSync(opts.output, output, 'utf-8');
      console.log(chalk.green(`Report written to ${opts.output}`));
    } catch (err: any) {
      console.error(chalk.red(`Error writing file: ${err.message}`));
    }
  } else {
    console.log(output);
  }
}
