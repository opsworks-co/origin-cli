import chalk from 'chalk';
import fs from 'fs';
import { execSync } from 'child_process';
import { getGitRoot } from '../session-state.js';

interface ExportSession {
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  status: string;
  durationMs: number;
  costUsd: number;
  tokensUsed: number;
  linesAdded: number;
  linesRemoved: number;
  filesCount: number;
  filesChanged: string[];
  branch: string;
}

function listLocalSessions(repoPath: string): ExportSession[] {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  const sessions: ExportSession[] = [];

  try {
    execSync('git rev-parse refs/heads/origin-sessions', execOpts);
  } catch {
    return sessions;
  }

  try {
    const raw = execSync('git ls-tree --name-only origin-sessions sessions/', execOpts).trim();
    if (!raw) return sessions;

    const dirs = raw.split('\n').filter(Boolean).map(d => d.replace('sessions/', ''));

    for (const dir of dirs) {
      try {
        const metadataJson = execSync(`git show origin-sessions:sessions/${dir}/metadata.json`, execOpts).trim();
        const m = JSON.parse(metadataJson);
        sessions.push({
          sessionId: m.sessionId || dir,
          model: m.model || 'unknown',
          startedAt: m.startedAt || '',
          endedAt: m.endedAt || '',
          status: m.status || 'ended',
          durationMs: m.durationMs || 0,
          costUsd: m.cost?.usd || 0,
          tokensUsed: m.tokens?.total || 0,
          linesAdded: m.lines?.added || 0,
          linesRemoved: m.lines?.removed || 0,
          filesCount: (m.filesChanged || []).length,
          filesChanged: m.filesChanged || [],
          branch: m.git?.branch || '',
        });
      } catch { /* skip */ }
    }
  } catch { /* no sessions */ }

  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sessions;
}

function toCsv(sessions: ExportSession[]): string {
  const headers = ['sessionId', 'model', 'startedAt', 'endedAt', 'status', 'durationMs', 'costUsd', 'tokensUsed', 'linesAdded', 'linesRemoved', 'filesCount', 'branch'];
  const lines = [headers.join(',')];

  for (const s of sessions) {
    const row = [
      s.sessionId,
      csvEscape(s.model),
      s.startedAt,
      s.endedAt,
      s.status,
      String(s.durationMs),
      s.costUsd.toFixed(4),
      String(s.tokensUsed),
      String(s.linesAdded),
      String(s.linesRemoved),
      String(s.filesCount),
      csvEscape(s.branch),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n') + '\n';
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export async function exportCommand(opts?: { format?: string; output?: string; limit?: string; model?: string }) {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  let sessions = listLocalSessions(repoPath);

  if (sessions.length === 0) {
    console.error(chalk.gray('No sessions found. Start an AI coding session to begin tracking.'));
    return;
  }

  // Apply filters
  if (opts?.model) {
    const m = opts.model.toLowerCase();
    sessions = sessions.filter(s => s.model.toLowerCase().includes(m));
  }
  if (opts?.limit) {
    const n = parseInt(opts.limit, 10);
    if (n > 0) sessions = sessions.slice(0, n);
  }

  // Format output
  const format = (opts?.format || 'json').toLowerCase();
  let output: string;

  if (format === 'csv') {
    output = toCsv(sessions);
  } else {
    output = JSON.stringify(sessions, null, 2) + '\n';
  }

  // Write to file or stdout
  if (opts?.output) {
    fs.writeFileSync(opts.output, output);
    console.error(chalk.green(`  ✓ Exported ${sessions.length} session${sessions.length !== 1 ? 's' : ''} to ${opts.output}`));
  } else {
    process.stdout.write(output);
  }
}
