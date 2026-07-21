import chalk from 'chalk';
import { gitOrNull } from '../utils/exec.js';
import { getAllPrompts } from '../local-db.js';
import { getOpenTodos } from '../todo.js';
import { isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { getGitRoot } from '../session-state.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function isoStartOfDay(daysAgo: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (daysAgo - 1));
  return d.toISOString();
}

function row(label: string, value: string): void {
  const padded = label.padEnd(12);
  console.log(`  ${chalk.gray(padded)}  ${value}`);
}

// ─── Git helpers ──────────────────────────────────────────────────────────

interface GitRecap {
  commits: number;
  aiCommits: number;
  filesChanged: number;
}

// All git access goes through the safe exec wrapper (array args, no shell), so
// this works under native-Windows cmd/PowerShell too — the old shell strings
// used `-C`, `2>/dev/null`, `$(…)` command substitution and `|| ` fallback,
// none of which are cmd syntax. gitOrNull returns null on any non-zero exit
// (missing ref, not-a-repo), which drives the same graceful fallbacks.
export function getGitRecap(repoPath: string, since: string): GitRecap {
  const result: GitRecap = { commits: 0, aiCommits: 0, filesChanged: 0 };
  try {
    const sinceDate = new Date(since).toISOString();
    const logOut = gitOrNull(['log', '--oneline', `--after=${sinceDate}`], { cwd: repoPath }) || '';
    const lines = logOut ? logOut.split('\n').filter(Boolean) : [];
    result.commits = lines.length;

    // Count AI-attributed commits (those with Co-Authored-By: or [ai] or origin session notes)
    let aiCount = 0;
    for (const line of lines) {
      const sha = line.split(' ')[0];
      if (!sha) continue;
      const msg = gitOrNull(['show', '--format=%B', '--no-patch', sha], { cwd: repoPath });
      if (msg && /co-authored-by|claude|cursor|gemini|devin|windsurf|aider|\[ai\]/i.test(msg)) {
        aiCount++;
      }
    }
    result.aiCommits = aiCount;

    // Count unique files changed. Prefer the reflog-relative diff (HEAD as of
    // the window start); if the reflog doesn't reach that far, fall back to the
    // oldest commit in range — replacing the old `git … || $(rev-list … | tail -1)`
    // shell one-liner with two plain calls.
    let diffOut = gitOrNull(['diff', '--name-only', `HEAD@{${sinceDate}}`, 'HEAD'], { cwd: repoPath });
    if (diffOut == null) {
      const revs = gitOrNull(['rev-list', `--after=${sinceDate}`, 'HEAD'], { cwd: repoPath });
      const oldest = revs ? revs.split('\n').filter(Boolean).pop() : undefined;
      if (oldest) {
        diffOut = gitOrNull(['diff', '--name-only', `${oldest}^`, 'HEAD'], { cwd: repoPath });
      }
    }
    result.filesChanged = diffOut ? diffOut.split('\n').filter(Boolean).length : 0;
  } catch { /* ignore git errors */ }
  return result;
}

// ─── Local data aggregation ────────────────────────────────────────────────

interface LocalRecap {
  sessions: number;
  uniqueSessions: number;
  models: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  filesChanged: Set<string>;
}

function getLocalRecap(since: string): LocalRecap {
  const prompts = getAllPrompts({ since });
  const sessionIds = new Set<string>();
  const models: Record<string, number> = {};
  const filesChanged = new Set<string>();

  // Approximate token counts from local prompt DB.
  // The local DB only stores prompts (not completions), so we do a rough
  // estimate: ~4 chars per token for input, and output = 25% of input.
  let totalInputTokens = 0;

  for (const p of prompts) {
    sessionIds.add(p.sessionId);
    models[p.model] = (models[p.model] || 0) + 1;
    for (const f of p.filesChanged) filesChanged.add(f);
    totalInputTokens += Math.round(p.promptText.length / 4);
  }

  return {
    sessions: sessionIds.size,
    uniqueSessions: sessionIds.size,
    models,
    totalInputTokens,
    totalOutputTokens: Math.round(totalInputTokens * 0.25),
    filesChanged,
  };
}

// ─── Command ──────────────────────────────────────────────────────────────

export async function recapCommand(opts?: { days?: string }): Promise<void> {
  const days = Math.max(1, parseInt(opts?.days || '1', 10));
  const since = isoStartOfDay(days);
  const repoPath = getGitRoot(process.cwd());

  // Date label
  const now = new Date();
  const rangeLabel = days === 1
    ? formatDate(now)
    : `${formatDate(new Date(since))} – ${formatDate(now)}`;

  console.log('');
  console.log(chalk.bold(`  Today's Recap`) + chalk.gray(` (${rangeLabel})`));
  console.log('  ' + chalk.gray('─'.repeat(43)));

  // ── Try API first in connected mode ─────────────────────────────────────
  let usedApi = false;

  if (isConnectedMode()) {
    try {
      const params: Record<string, string> = { days: String(days) };
      const s = await api.getStats(params) as any;

      // Sessions
      const total = s.totalSessions ?? s.sessionsThisWeek ?? '—';
      const running = s.runningSessions ?? 0;
      const completed = typeof total === 'number' ? total - running : '—';
      const sessionStr = running > 0
        ? `${total} sessions (${completed} completed, ${chalk.green(running + ' running')})`
        : `${total} sessions`;
      row('Sessions', chalk.white(sessionStr));

      // Cost
      const cost = s.estimatedCostToday ?? s.estimatedCostThisMonth;
      row('Cost', cost != null ? chalk.yellow(`$${Number(cost).toFixed(2)}`) : chalk.gray('—'));

      // Tokens
      const inp = s.inputTokensToday ?? s.tokensUsed;
      const out = s.outputTokensToday;
      if (inp != null) {
        const tokenStr = out != null
          ? `${formatTokens(inp)} input · ${formatTokens(out)} output`
          : formatTokens(inp);
        row('Tokens', chalk.white(tokenStr));
      } else {
        row('Tokens', chalk.gray('—'));
      }

      // Files
      const files = s.filesChangedToday ?? s.linesWrittenThisMonth;
      row('Files', files != null ? chalk.white(`${files} files changed`) : chalk.gray('—'));

      // Commits (fall back to git)
      let commitsStr = chalk.gray('—');
      if (repoPath) {
        const git = getGitRecap(repoPath, since);
        if (git.commits > 0) {
          const aiPct = git.commits > 0 ? Math.round((git.aiCommits / git.commits) * 100) : 0;
          commitsStr = chalk.white(`${git.commits} commits`) +
            (aiPct > 0 ? chalk.gray(` (${aiPct}% AI-attributed)`) : '');
        } else {
          commitsStr = chalk.gray('0 commits');
        }
      }
      row('Commits', commitsStr);

      // Top model
      if (s.costByModel && s.costByModel.length > 0) {
        const top = s.costByModel[0];
        row('Top Model', chalk.cyan(`${top.model}`) + chalk.gray(` (${top.count} sessions)`));
      } else if (s.topModel) {
        row('Top Model', chalk.cyan(s.topModel));
      } else {
        row('Top Model', chalk.gray('—'));
      }

      usedApi = true;
    } catch {
      // Fall through to local data
    }
  }

  // ── Local fallback (or supplement for commits/todos) ────────────────────
  if (!usedApi) {
    const local = getLocalRecap(since);

    // Sessions
    row('Sessions', local.sessions > 0
      ? chalk.white(`${local.sessions} sessions`)
      : chalk.gray('0 sessions'));

    // Cost — not available locally
    row('Cost', chalk.gray('—  (login to see costs)'));

    // Tokens (estimated from prompt lengths)
    if (local.totalInputTokens > 0) {
      const tokenStr = `${formatTokens(local.totalInputTokens)} input · ${formatTokens(local.totalOutputTokens)} output` +
        chalk.gray(' (est.)');
      row('Tokens', chalk.white(tokenStr));
    } else {
      row('Tokens', chalk.gray('—'));
    }

    // Files from prompt records
    const fileCount = local.filesChanged.size;
    row('Files', fileCount > 0
      ? chalk.white(`${fileCount} files changed`)
      : chalk.gray('0 files changed'));

    // Commits from git
    if (repoPath) {
      const git = getGitRecap(repoPath, since);
      if (git.commits > 0) {
        const aiPct = Math.round((git.aiCommits / git.commits) * 100);
        const commitsStr = chalk.white(`${git.commits} commits`) +
          (aiPct > 0 ? chalk.gray(` (${aiPct}% AI-attributed)`) : '');
        row('Commits', commitsStr);
      } else {
        row('Commits', chalk.gray('0 commits'));
      }
    } else {
      row('Commits', chalk.gray('—'));
    }

    // Top model from local prompts
    const modelEntries = Object.entries(local.models).sort((a, b) => b[1] - a[1]);
    if (modelEntries.length > 0) {
      const [topModel, topCount] = modelEntries[0];
      row('Top Model', chalk.cyan(topModel) + chalk.gray(` (${topCount} prompts)`));
    } else {
      row('Top Model', chalk.gray('—'));
    }
  }

  // ── TODOs (always from local store) ─────────────────────────────────────
  try {
    const openTodos = getOpenTodos(repoPath || undefined);
    if (openTodos.length > 0) {
      row('TODOs', chalk.yellow(`${openTodos.length} open item${openTodos.length !== 1 ? 's' : ''}`));
    }
  } catch { /* skip if todo store unavailable */ }

  console.log('');
}
