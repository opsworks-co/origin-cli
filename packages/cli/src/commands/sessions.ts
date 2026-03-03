import chalk from 'chalk';
import { api } from '../api.js';

export async function sessionsCommand(opts: { status?: string; model?: string; limit?: string }) {
  try {
    const params: Record<string, string> = {};
    if (opts.status) params.status = opts.status;
    if (opts.model) params.model = opts.model;
    if (opts.limit) params.limit = opts.limit;
    else params.limit = '20';

    const data = await api.getSessions(params) as any;
    const sessions = data.sessions || [];

    if (sessions.length === 0) {
      console.log(chalk.gray('No sessions found.'));
      return;
    }

    console.log(chalk.bold(`\nSessions (${data.total} total)\n`));

    for (const s of sessions) {
      const statusColor = s.review?.status === 'APPROVED' ? chalk.green : s.review?.status === 'REJECTED' ? chalk.red : s.review?.status === 'FLAGGED' ? chalk.yellow : chalk.gray;
      const status = s.review?.status || 'UNREVIEWED';
      const files = (() => { try { return JSON.parse(s.filesChanged).length; } catch { return 0; } })();
      const age = timeAgo(s.createdAt);

      console.log(
        `  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.cyan(s.model.padEnd(25))}  ${statusColor(status.padEnd(12))}  ${chalk.white(String(files).padStart(3))} files  ${chalk.dim('$' + s.costUsd.toFixed(2).padStart(6))}  ${chalk.dim(age)}`
      );
      if (s.commitMessage) {
        console.log(`           ${chalk.gray(s.commitMessage.slice(0, 60))}`);
      }
    }
    console.log('');
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}

export async function sessionDetailCommand(id: string) {
  try {
    const s = await api.getSession(id) as any;

    console.log(chalk.bold('\nSession Detail\n'));
    console.log(`  ${chalk.gray('ID:')}          ${s.id}`);
    console.log(`  ${chalk.gray('Model:')}       ${chalk.cyan(s.model)}`);
    console.log(`  ${chalk.gray('Repo:')}        ${s.repoName || '—'}`);
    console.log(`  ${chalk.gray('Commit:')}      ${s.commitMessage || '—'}`);
    console.log(`  ${chalk.gray('SHA:')}         ${s.commitSha?.slice(0, 8) || '—'}`);
    console.log(`  ${chalk.gray('Author:')}      ${s.commitAuthor || '—'}`);
    console.log(`  ${chalk.gray('Agent:')}       ${s.agentName || '—'}`);
    console.log(`  ${chalk.gray('Tokens:')}      ${s.tokensUsed.toLocaleString()}`);
    console.log(`  ${chalk.gray('Cost:')}        $${s.costUsd.toFixed(2)}`);
    console.log(`  ${chalk.gray('Duration:')}    ${formatDuration(s.durationMs)}`);
    console.log(`  ${chalk.gray('Tool calls:')}  ${s.toolCalls}`);
    console.log(`  ${chalk.gray('Lines:')}       ${chalk.green('+' + s.linesAdded)} ${chalk.red('-' + s.linesRemoved)}`);

    const files = (() => { try { return JSON.parse(s.filesChanged); } catch { return []; } })();
    if (files.length > 0) {
      console.log(`  ${chalk.gray('Files:')}`);
      files.forEach((f: string) => console.log(`    ${chalk.dim('•')} ${f}`));
    }

    if (s.review) {
      const c = s.review.status === 'APPROVED' ? chalk.green : s.review.status === 'REJECTED' ? chalk.red : chalk.yellow;
      console.log(`\n  ${chalk.gray('Review:')}      ${c(s.review.status)} by ${s.review.reviewerName || 'unknown'}`);
      if (s.review.note) console.log(`  ${chalk.gray('Note:')}        ${s.review.note}`);
    } else {
      console.log(`\n  ${chalk.gray('Review:')}      ${chalk.dim('Not reviewed')}`);
    }
    console.log('');
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
