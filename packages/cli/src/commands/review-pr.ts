import chalk from 'chalk';
import { requirePlatform } from '../config.js';
import { api } from '../api.js';

interface SessionData {
  id: string;
  model: string;
  agentName: string | null;
  costUsd: number;
  tokensUsed: number;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  toolCalls: number;
  reviewStatus: string | null;
  reviewNote: string | null;
  promptCount: number;
  branch: string | null;
  violations: Array<{ policyName: string; message: string }>;
}

interface ReviewResponse {
  pr: { number: number; title: string; state: string; author: string };
  sessions: SessionData[];
  summary: {
    totalSessions: number;
    totalCost: number;
    totalTokens: number;
    totalTurns: number;
    flaggedCount: number;
    overallStatus: string;
  };
}

function formatDuration(ms: number): string {
  if (ms === 0) return '—';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function statusColor(status: string | null): (s: string) => string {
  if (!status) return chalk.gray;
  switch (status.toUpperCase()) {
    case 'APPROVED': return chalk.green;
    case 'REJECTED': return chalk.red;
    case 'FLAGGED': return chalk.yellow;
    default: return chalk.gray;
  }
}

function overallStatusColor(status: string): (s: string) => string {
  switch (status) {
    case 'approved': return chalk.green;
    case 'rejected': return chalk.red;
    case 'flagged': return chalk.yellow;
    default: return chalk.gray;
  }
}

export async function reviewPRCommand(url: string) {
  if (!requirePlatform('review-pr')) return;

  try {
    const data: ReviewResponse = await api.reviewPR(url);
    const { pr, sessions, summary } = data;

    // PR header
    const stateColor = pr.state === 'open' ? chalk.green : pr.state === 'merged' ? chalk.magenta : chalk.red;
    console.log();
    console.log(`  ${chalk.bold(pr.title)} ${chalk.gray(`#${pr.number}`)}`);
    console.log(`  ${stateColor(pr.state.toUpperCase())} by ${chalk.cyan(pr.author)}`);
    console.log();

    if (sessions.length === 0) {
      console.log(chalk.gray('  No AI sessions linked to this PR.'));
      console.log();
      return;
    }

    // Session table header
    const hdr = [
      'Agent'.padEnd(16),
      'Model'.padEnd(22),
      'Turns'.padStart(5),
      'Cost'.padStart(8),
      'Tokens'.padStart(8),
      'Duration'.padStart(9),
      'Status'.padStart(10),
    ].join('  ');
    console.log(chalk.gray(`  ${hdr}`));
    console.log(chalk.gray(`  ${'─'.repeat(hdr.length)}`));

    // Session rows
    for (const s of sessions) {
      const agent = (s.agentName || '—').slice(0, 16).padEnd(16);
      const model = s.model.slice(0, 22).padEnd(22);
      const turns = String(s.promptCount).padStart(5);
      const cost = `$${s.costUsd.toFixed(2)}`.padStart(8);
      const tokens = formatTokens(s.tokensUsed).padStart(8);
      const duration = formatDuration(s.durationMs).padStart(9);
      const status = (s.reviewStatus || 'pending').padStart(10);
      const colorFn = statusColor(s.reviewStatus);

      console.log(`  ${agent}  ${model}  ${turns}  ${cost}  ${tokens}  ${duration}  ${colorFn(status)}`);
    }

    console.log();

    // Summary line
    const summaryLine = [
      `${summary.totalSessions} session${summary.totalSessions !== 1 ? 's' : ''}`,
      `${summary.totalTurns} turn${summary.totalTurns !== 1 ? 's' : ''}`,
      `$${summary.totalCost.toFixed(2)} cost`,
      summary.flaggedCount > 0
        ? chalk.yellow(`${summary.flaggedCount} flagged`)
        : chalk.green('0 flagged'),
    ].join(', ');
    console.log(`  ${summaryLine}`);

    // Overall status
    const statusFn = overallStatusColor(summary.overallStatus);
    console.log(`  Overall: ${statusFn(chalk.bold(summary.overallStatus.toUpperCase()))}`);
    console.log();

    // Flagged/rejected session details
    const flagged = sessions.filter(
      s => s.reviewStatus?.toUpperCase() === 'FLAGGED' || s.reviewStatus?.toUpperCase() === 'REJECTED',
    );

    if (flagged.length > 0) {
      console.log(chalk.yellow.bold('  Flagged / Rejected Sessions:'));
      console.log();

      for (const s of flagged) {
        const colorFn = statusColor(s.reviewStatus);
        const label = s.reviewStatus?.toUpperCase() || 'UNKNOWN';
        console.log(`  ${colorFn(label)} — ${s.agentName || s.model} (${s.id.slice(0, 8)}...)`);

        if (s.reviewNote) {
          console.log(chalk.gray(`    Note: ${s.reviewNote}`));
        }

        if (s.violations.length > 0) {
          for (const v of s.violations) {
            console.log(chalk.red(`    Violation: ${v.policyName} — ${v.message}`));
          }
        }

        // If rejected, frame it as a reversal
        if (s.reviewStatus?.toUpperCase() === 'REJECTED') {
          const what = s.agentName || s.model;
          const reason = s.reviewNote || (s.violations[0]?.message ?? 'policy violation');
          console.log(chalk.red(`    Agent considered ${what}'s changes but rejected: ${reason}`));
        }

        console.log();
      }
    }
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}
