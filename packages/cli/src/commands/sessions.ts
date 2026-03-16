import chalk from 'chalk';
import { execSync } from 'child_process';
import { isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { getGitRoot } from '../session-state.js';

interface LocalSession {
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  costUsd: number;
  tokensUsed: number;
  durationMs: number;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  git?: { branch?: string; commitShas?: string[] };
  prompts?: Array<{ index: number; text: string }>;
}

function listLocalSessions(repoPath: string): LocalSession[] {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  const sessions: LocalSession[] = [];

  try {
    // Check if origin-sessions branch exists
    execSync('git rev-parse refs/heads/origin-sessions', execOpts);
  } catch {
    return sessions;
  }

  try {
    // List session directories on the origin-sessions branch
    const raw = execSync('git ls-tree --name-only origin-sessions sessions/', execOpts).trim();
    if (!raw) return sessions;

    const dirs = raw.split('\n').filter(Boolean).map(d => d.replace('sessions/', ''));

    for (const dir of dirs) {
      try {
        const metadataJson = execSync(`git show origin-sessions:sessions/${dir}/metadata.json`, execOpts).trim();
        const metadata = JSON.parse(metadataJson);
        sessions.push({
          sessionId: metadata.sessionId || dir,
          model: metadata.model || 'unknown',
          startedAt: metadata.startedAt || '',
          endedAt: metadata.endedAt || undefined,
          status: metadata.status || 'ended',
          costUsd: metadata.costUsd || 0,
          tokensUsed: metadata.tokensUsed || 0,
          durationMs: metadata.durationMs || 0,
          filesChanged: metadata.filesChanged || [],
          linesAdded: metadata.linesAdded || 0,
          linesRemoved: metadata.linesRemoved || 0,
          git: metadata.git,
          prompts: metadata.prompts,
        });
      } catch {
        // Skip sessions with invalid metadata
      }
    }
  } catch {
    // origin-sessions branch might not have sessions/ dir
  }

  // Sort by startedAt descending
  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sessions;
}

export async function sessionsCommand(opts: { status?: string; model?: string; limit?: string }) {
  if (isConnectedMode()) {
    // ── Connected mode: use API ──
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
  } else {
    // ── Standalone mode: read from origin-sessions git branch ──
    const repoPath = getGitRoot(process.cwd());
    if (!repoPath) {
      console.log(chalk.gray('Not in a git repository.'));
      return;
    }

    let sessions = listLocalSessions(repoPath);
    const limit = parseInt(opts.limit || '20', 10);

    // Apply filters
    if (opts.model) {
      const m = opts.model.toLowerCase();
      sessions = sessions.filter(s => s.model.toLowerCase().includes(m));
    }
    if (opts.status) {
      const st = opts.status.toLowerCase();
      sessions = sessions.filter(s => s.status.toLowerCase() === st);
    }

    sessions = sessions.slice(0, limit);

    if (sessions.length === 0) {
      console.log(chalk.gray('No local sessions found. Start an AI coding session to begin tracking.'));
      return;
    }

    console.log(chalk.bold(`\nLocal Sessions (${sessions.length})\n`));

    for (const s of sessions) {
      const statusColor = s.status === 'ended' ? chalk.gray : chalk.green;
      const files = s.filesChanged.length;
      const age = s.startedAt ? timeAgo(s.startedAt) : '—';
      const branch = s.git?.branch || '';

      console.log(
        `  ${chalk.dim(s.sessionId.slice(0, 8))}  ${chalk.cyan(s.model.padEnd(20))}  ${statusColor(s.status.padEnd(10))}  ${chalk.white(String(files).padStart(3))} files  ${chalk.dim('$' + s.costUsd.toFixed(2).padStart(6))}  ${chalk.dim(age)}${branch ? '  ' + chalk.dim(branch) : ''}`
      );
    }
    console.log('');
  }
}

export async function sessionDetailCommand(id: string) {
  if (isConnectedMode()) {
    // ── Connected mode: use API ──
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
  } else {
    // ── Standalone mode: read from origin-sessions branch ──
    const repoPath = getGitRoot(process.cwd());
    if (!repoPath) {
      console.log(chalk.gray('Not in a git repository.'));
      return;
    }

    const sessions = listLocalSessions(repoPath);
    const session = sessions.find(s => s.sessionId.startsWith(id));

    if (!session) {
      console.log(chalk.red(`Session not found: ${id}`));
      return;
    }

    console.log(chalk.bold('\nSession Detail (local)\n'));
    console.log(`  ${chalk.gray('ID:')}          ${session.sessionId}`);
    console.log(`  ${chalk.gray('Model:')}       ${chalk.cyan(session.model)}`);
    console.log(`  ${chalk.gray('Status:')}      ${session.status}`);
    console.log(`  ${chalk.gray('Started:')}     ${session.startedAt}`);
    if (session.endedAt) console.log(`  ${chalk.gray('Ended:')}       ${session.endedAt}`);
    console.log(`  ${chalk.gray('Tokens:')}      ${session.tokensUsed.toLocaleString()}`);
    console.log(`  ${chalk.gray('Cost:')}        $${session.costUsd.toFixed(2)}`);
    console.log(`  ${chalk.gray('Duration:')}    ${formatDuration(session.durationMs)}`);
    console.log(`  ${chalk.gray('Lines:')}       ${chalk.green('+' + session.linesAdded)} ${chalk.red('-' + session.linesRemoved)}`);
    if (session.git?.branch) console.log(`  ${chalk.gray('Branch:')}      ${session.git.branch}`);

    if (session.filesChanged.length > 0) {
      console.log(`  ${chalk.gray('Files:')}`);
      session.filesChanged.forEach(f => console.log(`    ${chalk.dim('•')} ${f}`));
    }

    // Try to read prompts.md
    try {
      const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
      const prompts = execSync(`git show origin-sessions:sessions/${session.sessionId}/prompts.md`, execOpts).trim();
      if (prompts) {
        console.log(chalk.bold('\n  Prompts:\n'));
        console.log(prompts.split('\n').map(l => '    ' + l).join('\n'));
      }
    } catch {
      // No prompts file
    }
    console.log('');
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
