import chalk from 'chalk';
import { execSync } from 'child_process';
import { isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { getGitRoot, listActiveSessions, listAllActiveSessions } from '../session-state.js';

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
          costUsd: metadata.cost?.usd || 0,
          tokensUsed: metadata.tokens?.total || 0,
          durationMs: metadata.durationMs || 0,
          filesChanged: metadata.filesChanged || [],
          linesAdded: metadata.lines?.added || 0,
          linesRemoved: metadata.lines?.removed || 0,
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

export async function sessionsCommand(opts: { status?: string; model?: string; limit?: string; all?: boolean; global?: boolean }) {
  // --global is alias for --all
  if (opts.global) opts.all = true;
  const repoPath = getGitRoot(process.cwd());
  const limit = parseInt(opts.limit || '20', 10);

  // Always read local sessions from origin-sessions git branch
  let localSessions: LocalSession[] = [];
  if (repoPath) {
    localSessions = listLocalSessions(repoPath);

    // Also include active sessions from state files for current repo
    if (!opts.all) {
      try {
        const activeStates = listActiveSessions(repoPath);
        const existingIds = new Set(localSessions.map(s => s.sessionId));
        for (const state of activeStates) {
          if (!existingIds.has(state.sessionId)) {
            localSessions.push({
              sessionId: state.sessionId,
              model: state.model || 'unknown',
              status: (state as any).status === 'ENDED' ? 'ENDED' : 'RUNNING',
              filesChanged: (state as any).filesChanged || [],
              costUsd: 0,
              tokensUsed: 0,
              durationMs: Date.now() - new Date(state.startedAt).getTime(),
              linesAdded: 0,
              linesRemoved: 0,
              startedAt: state.startedAt,
              agentName: undefined,
            } as LocalSession);
          }
        }
      } catch { /* ignore */ }
    }

    // Apply filters
    if (opts.model) {
      const m = opts.model.toLowerCase();
      localSessions = localSessions.filter(s => s.model.toLowerCase().includes(m));
    }
    if (opts.status) {
      const st = opts.status.toLowerCase();
      localSessions = localSessions.filter(s => s.status.toLowerCase() === st);
    }
  }

  // For --all/--global: scan ALL repos' state files from ~/.origin/sessions/
  if (opts.all) {
    try {
      const allStates = listAllActiveSessions();
      const existingIds = new Set(localSessions.map(s => s.sessionId));
      for (const state of allStates) {
        if (!existingIds.has(state.sessionId)) {
          localSessions.push({
            sessionId: state.sessionId,
            model: state.model || 'unknown',
            status: (state as any).status === 'ENDED' ? 'ENDED' : 'RUNNING',
            filesChanged: (state as any).filesChanged || [],
            costUsd: 0,
            tokensUsed: 0,
            durationMs: Date.now() - new Date(state.startedAt).getTime(),
            linesAdded: 0,
            linesRemoved: 0,
            startedAt: state.startedAt,
            agentName: undefined,
          } as LocalSession);
        }
      }
    } catch { /* ignore */ }
  }

  // In connected mode, also fetch user's platform sessions and merge
  let platformSessions: any[] = [];
  if (isConnectedMode()) {
    try {
      const params: Record<string, string> = { limit: String(limit) };
      if (opts.status) params.status = opts.status;
      if (opts.model) params.model = opts.model;

      // Scope to current repo unless --all flag is passed
      if (!opts.all && repoPath) {
        try {
          const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8', cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          // Extract repo name from URL: git@github.com:org/repo.git → org/repo
          const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
          if (match) params.repoName = match[1];
        } catch {
          // No remote — skip repo filter
        }
      }

      const data = await api.getSessions(params) as any;
      platformSessions = data.sessions || [];
    } catch {
      // Platform unavailable — fall back to local only
    }
  }

  // Merge: local sessions first, then platform sessions not already in local
  const localIds = new Set(localSessions.map(s => s.sessionId.slice(0, 8)));
  const merged: Array<{ type: 'local'; data: LocalSession } | { type: 'platform'; data: any }> = [];

  for (const s of localSessions) {
    merged.push({ type: 'local', data: s });
  }
  for (const s of platformSessions) {
    if (!localIds.has(s.id.slice(0, 8))) {
      merged.push({ type: 'platform', data: s });
    }
  }

  // Sort by time descending
  merged.sort((a, b) => {
    const ta = a.type === 'local' ? a.data.startedAt : (a.data.createdAt || a.data.startedAt);
    const tb = b.type === 'local' ? b.data.startedAt : (b.data.createdAt || b.data.startedAt);
    return new Date(tb).getTime() - new Date(ta).getTime();
  });

  const display = merged.slice(0, limit);

  if (display.length === 0) {
    console.log(chalk.gray('No sessions found. Start an AI coding session to begin tracking.'));
    return;
  }

  // Show header with repo context
  if (!opts.all && repoPath) {
    let repoName = '';
    try {
      const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8', cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) repoName = match[1];
    } catch {}
    console.log(chalk.bold(`\nSessions${repoName ? ` — ${repoName}` : ''} (${display.length} total)\n`));
  } else {
    console.log(chalk.bold(`\nSessions — all repos (${display.length} total)\n`));
  }

  for (const entry of display) {
    if (entry.type === 'local') {
      const s = entry.data;
      const isRunning = s.status?.toLowerCase() === 'running';
      const statusColor = isRunning ? chalk.green : chalk.gray;
      const statusLabel = isRunning ? 'RUNNING' : 'ENDED';
      const files = s.filesChanged.length;
      const age = s.startedAt ? timeAgo(s.startedAt) : '—';

      console.log(
        `  ${chalk.dim(s.sessionId.slice(0, 8))}  ${chalk.cyan(s.model.padEnd(25))}  ${statusColor(statusLabel.padEnd(12))}  ${chalk.white(String(files).padStart(3))} files  ${chalk.dim('$' + s.costUsd.toFixed(2).padStart(6))}  ${chalk.dim(age)}`
      );
    } else {
      const s = entry.data;
      let status: string;
      let statusColor: (s: string) => string;
      if (s.status === 'RUNNING') {
        status = 'RUNNING';
        statusColor = chalk.green;
      } else if (s.review?.status === 'APPROVED') {
        status = 'APPROVED';
        statusColor = chalk.green;
      } else if (s.review?.status === 'REJECTED') {
        status = 'REJECTED';
        statusColor = chalk.red;
      } else if (s.review?.status === 'FLAGGED') {
        status = 'FLAGGED';
        statusColor = chalk.yellow;
      } else {
        status = 'UNREVIEWED';
        statusColor = chalk.gray;
      }

      const files = (() => { try { const f = JSON.parse(s.filesChanged); return Array.isArray(f) ? f.length : 0; } catch { return 0; } })();
      const fileDisplay = files > 0 ? `${String(files).padStart(3)} files` : `  0 files`;
      const age = timeAgo(s.createdAt || s.startedAt);

      // Clean up model display — replace "default"/"cursor" with agent name if available
      let displayModel = s.model || 'unknown';
      if (/^(default|unknown|cursor)$/i.test(displayModel) && s.agentName) {
        displayModel = s.agentName;
      }

      console.log(
        `  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.cyan(displayModel.padEnd(25))}  ${statusColor(status.padEnd(12))}  ${fileDisplay.padEnd(12)}  ${chalk.dim('$' + s.costUsd.toFixed(2).padStart(6))}  ${chalk.dim(age)}`
      );
      if (s.commitMessage) {
        console.log(`           ${chalk.gray(s.commitMessage.slice(0, 60))}`);
      }
    }
  }
  console.log('');
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
    let session = sessions.find(s => s.sessionId.startsWith(id));

    // Fallback: check ~/.origin/sessions/ state files
    if (!session) {
      const allStates = listAllActiveSessions();
      const stateMatch = allStates.find(s => s.sessionId.startsWith(id));
      if (stateMatch) {
        session = {
          sessionId: stateMatch.sessionId,
          model: stateMatch.model || 'unknown',
          status: (stateMatch as any).status === 'ENDED' ? 'ENDED' : 'RUNNING',
          filesChanged: (stateMatch as any).filesChanged || [],
          costUsd: 0,
          tokensUsed: 0,
          durationMs: Date.now() - new Date(stateMatch.startedAt).getTime(),
          linesAdded: 0,
          linesRemoved: 0,
          startedAt: stateMatch.startedAt,
          agentName: undefined,
          prompts: stateMatch.prompts,
        } as any;
      }
    }

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

export async function sessionEndCommand(id: string) {
  if (!isConnectedMode()) {
    console.error(chalk.red('Error: End session requires connected mode. Run: origin login'));
    return;
  }

  try {
    await api.endSessionById(id);
    console.log(chalk.green(`Session ${id} ended successfully.`));
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
