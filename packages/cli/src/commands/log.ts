import chalk from 'chalk';
import { execSync, execFileSync } from 'child_process';
import { getGitRoot } from '../session-state.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

interface OriginNote {
  sessionId: string;
  model?: string;
  agent?: string;
  promptCount?: number;
  promptSummary?: string;
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
  linesAdded?: number;
  linesRemoved?: number;
  originUrl?: string;
}

function readOriginNote(repoPath: string, sha: string): OriginNote | null {
  try {
    const note = execFileSync('git', ['notes', '--ref=origin', 'show', sha], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const parsed = JSON.parse(note);
    return parsed?.origin || null;
  } catch {
    return null;
  }
}

function agentLabel(note: OriginNote): string {
  if (note.agent) {
    const map: Record<string, string> = {
      'claude': 'Claude Code',
      'claude-code': 'Claude Code',
      'cursor': 'Cursor',
      'gemini': 'Gemini CLI',
      'codex': 'Codex',
      'windsurf': 'Windsurf',
      'aider': 'Aider',
      'copilot': 'Copilot',
      'amp': 'Amp',
      'junie': 'Junie',
      'opencode': 'Opencode',
      'rovo': 'Rovo',
      'droid': 'Droid',
    };
    return map[note.agent] || note.agent;
  }
  // Infer from model
  const m = (note.model || '').toLowerCase();
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus')) return 'Claude Code';
  if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-')) return 'Cursor';
  if (m.includes('gemini')) return 'Gemini CLI';
  if (m.includes('codex')) return 'Codex';
  return 'AI';
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

// ─── Command ──────────────────────────────────────────────────────────────

export async function logCommand(options: { limit?: string; all?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.log(chalk.red('Not a git repository'));
    process.exit(1);
  }

  const limit = parseInt(options.limit || '20', 10);
  const execOpts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

  // Get recent commits
  let logOutput: string;
  try {
    logOutput = execFileSync('git', [
      'log',
      `--max-count=${limit}`,
      '--format=%H|%s|%aI',
    ], execOpts).trim();
  } catch {
    console.log(chalk.red('Failed to read git log'));
    return;
  }

  if (!logOutput) {
    console.log(chalk.gray('No commits found'));
    return;
  }

  const lines = logOutput.split('\n').filter(Boolean);
  const aiCount = { total: 0, cost: 0 };

  console.log('');

  for (const line of lines) {
    const [sha, message, date] = line.split('|');
    const shortSha = sha.slice(0, 7);
    const note = readOriginNote(repoPath, sha);
    const dateStr = formatDate(date);

    if (note) {
      aiCount.total++;
      aiCount.cost += note.costUsd || 0;

      const agent = agentLabel(note);
      const cost = formatCost(note.costUsd || 0);
      const prompts = note.promptCount || 0;
      const promptLabel = prompts === 1 ? '1 prompt' : `${prompts} prompts`;

      console.log(
        `  ${chalk.yellow(shortSha)} ${chalk.white(message)} ${chalk.gray('—')} ` +
        `${chalk.cyan(agent)} ${chalk.gray('·')} ${chalk.green(cost)} ${chalk.gray('·')} ` +
        `${chalk.gray(promptLabel)} ${chalk.gray('·')} ${chalk.gray(dateStr)}`
      );
    } else {
      console.log(
        `  ${chalk.yellow(shortSha)} ${chalk.white(message)} ${chalk.gray('—')} ` +
        `${chalk.gray('(no session)')} ${chalk.gray('·')} ${chalk.gray(dateStr)}`
      );
    }
  }

  // Summary footer
  console.log('');
  if (aiCount.total > 0) {
    const pct = Math.round((aiCount.total / lines.length) * 100);
    console.log(
      chalk.gray(`  ${aiCount.total}/${lines.length} commits AI-generated (${pct}%) · `) +
      chalk.green(`${formatCost(aiCount.cost)} total cost`)
    );
  } else {
    console.log(chalk.gray(`  ${lines.length} commits · no AI sessions detected`));
  }
  console.log('');
}
