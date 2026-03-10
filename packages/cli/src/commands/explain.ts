import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { api } from '../api.js';
import { loadSessionState, getGitRoot, getHeadSha } from '../session-state.js';
import { execSync } from 'child_process';

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * origin explain [sessionId|commitSha]
 *
 * Shows a detailed explanation of a coding session — similar to Entire's `explain`.
 * If no argument given, explains the active session or latest session in this repo.
 *
 * Uses the Origin API to fetch session data (including transcript,
 * prompt changes, and diff) and renders a human-readable summary.
 */
export async function explainCommand(target?: string, opts?: { short?: boolean; commit?: string }) {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Not logged in. Run: origin login'));
    return;
  }

  let sessionId = target;

  // If --commit flag, look up session by commit SHA
  if (opts?.commit) {
    const cwd = process.cwd();
    const repoPath = getGitRoot(cwd);
    if (repoPath) {
      try {
        const noteContent = execSync(
          `git notes --ref=origin show ${opts.commit} 2>/dev/null`,
          { encoding: 'utf-8', cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        const noteData = JSON.parse(noteContent);
        sessionId = noteData?.origin?.sessionId;
        if (sessionId) {
          console.log(chalk.gray(`Found session ${sessionId} linked to commit ${opts.commit.slice(0, 8)}`));
        }
      } catch {
        console.log(chalk.yellow(`No Origin session linked to commit ${opts.commit.slice(0, 8)}`));
        return;
      }
    }
  }

  // If no target, use active session
  if (!sessionId) {
    const state = loadSessionState();
    if (state) {
      sessionId = state.sessionId;
      console.log(chalk.gray(`Using active session: ${sessionId}`));
    } else {
      console.log(chalk.red('No session ID provided and no active session found.'));
      console.log(chalk.gray('Usage: origin explain <sessionId>'));
      console.log(chalk.gray('       origin explain --commit <sha>'));
      return;
    }
  }

  try {
    const session: any = await api.getSession(sessionId!);

    console.log(chalk.bold('\n  Session Explanation\n'));

    // Header
    console.log(chalk.gray(`  Session:     ${chalk.white(session.id)}`));
    console.log(chalk.gray(`  Model:       ${chalk.cyan(session.model)}`));
    if (session.agentName) {
      console.log(chalk.gray(`  Agent:       ${chalk.white(session.agentName)}`));
    }
    if (session.userName) {
      console.log(chalk.gray(`  User:        ${chalk.white(session.userName)}`));
    }
    if (session.repoName) {
      console.log(chalk.gray(`  Repo:        ${chalk.white(session.repoName)}`));
    }
    if (session.branch) {
      console.log(chalk.gray(`  Branch:      ${chalk.yellow(session.branch)}`));
    }
    console.log(chalk.gray(`  Duration:    ${chalk.white(formatDuration(session.durationMs))}`));
    console.log(chalk.gray(`  Tokens:      ${chalk.white(session.tokensUsed.toLocaleString())} (${(session.inputTokens || 0).toLocaleString()} in / ${(session.outputTokens || 0).toLocaleString()} out)`));

    const cost = session.costUsd;
    const costStr = cost < 0.01 && cost > 0 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
    console.log(chalk.gray(`  Cost:        ${chalk.white(costStr)}`));
    console.log(chalk.gray(`  Tool calls:  ${chalk.white(String(session.toolCalls))}`));
    console.log(chalk.gray(`  Lines:       ${chalk.green(`+${session.linesAdded}`)} ${chalk.red(`-${session.linesRemoved}`)}`));

    // Files changed
    try {
      const files = JSON.parse(session.filesChanged);
      if (files.length > 0) {
        console.log(chalk.bold('\n  Files Changed'));
        for (const f of files.slice(0, 30)) {
          console.log(chalk.gray(`    ${chalk.white(f)}`));
        }
        if (files.length > 30) {
          console.log(chalk.gray(`    ... and ${files.length - 30} more`));
        }
      }
    } catch { /* ignore */ }

    // Prompt changes (what was asked → what files changed)
    if (session.promptChanges && session.promptChanges.length > 0 && !opts?.short) {
      console.log(chalk.bold('\n  Prompt → Change Mapping'));
      for (const pc of session.promptChanges) {
        const promptPreview = pc.promptText.slice(0, 100).replace(/\n/g, ' ');
        console.log(chalk.gray(`\n    Prompt #${pc.promptIndex + 1}: ${chalk.white(promptPreview)}${pc.promptText.length > 100 ? '...' : ''}`));
        if (pc.filesChanged && pc.filesChanged.length > 0) {
          for (const f of pc.filesChanged) {
            console.log(chalk.gray(`      → ${chalk.green(f)}`));
          }
        }
      }
    }

    // Review status
    if (session.review) {
      const statusColors: Record<string, (s: string) => string> = {
        approved: chalk.green,
        rejected: chalk.red,
        flagged: chalk.yellow,
      };
      const colorFn = statusColors[session.review.status?.toLowerCase()] || chalk.gray;
      console.log(chalk.bold('\n  Review'));
      console.log(chalk.gray(`    Status: ${colorFn(session.review.status)}`));
      if (session.review.note) {
        console.log(chalk.gray(`    Note:   ${session.review.note.slice(0, 200)}`));
      }
    }

    // Status
    console.log(chalk.bold('\n  Status'));
    const statusStr = session.status === 'RUNNING'
      ? chalk.magenta('● Running')
      : session.status === 'COMPLETED'
        ? chalk.blue('● Completed')
        : chalk.gray(`● ${session.status}`);
    console.log(chalk.gray(`    ${statusStr}`));
    if (session.startedAt) {
      console.log(chalk.gray(`    Started: ${new Date(session.startedAt).toLocaleString()}`));
    }
    if (session.endedAt) {
      console.log(chalk.gray(`    Ended:   ${new Date(session.endedAt).toLocaleString()}`));
    }

    // Dashboard link
    const apiUrl = config.apiUrl || 'https://origin-platform.fly.dev';
    console.log(chalk.gray(`\n    ${chalk.blue(`${apiUrl}/sessions/${session.id}`)}`));

    console.log('');
  } catch (err: any) {
    console.log(chalk.red(`Failed to load session: ${err.message}`));
  }
}
