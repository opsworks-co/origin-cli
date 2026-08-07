import chalk from 'chalk';
import { gitDetailed } from '../utils/exec.js';
import { isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { computeAttributionStats, type AttributionStats } from '../attribution.js';
import { getGitRoot } from '../session-state.js';

// ─── Bar Graph Rendering ──────────────────────────────────────────────────

function renderBar(value: number, max: number, width: number = 30): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  const empty = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

function renderPercentBar(pct: number, width: number = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

// ─── Local Stats Display ──────────────────────────────────────────────────

// Per-model cost from the SERVER (api.getStats → costByModel). The local
// per-commit git notes only carry token counts for agents that surface them
// per-turn (Codex), so non-Codex models (Claude, Gemini/Antigravity, Cursor,
// Devin) priced to $0 in `origin stats` even though the server had captured
// their real session cost. When available we prefer the server figure.
export interface ServerModelCost { model: string; cost: number }

// Resolve a git-note model name to the server's cost. Exact match first; then a
// brand fallback so a bare-brand git-note model ("claude") reconciles with the
// server's specific ids ("claude-opus-5", "claude-opus-4-8"), summing every
// specific model under that brand. Returns undefined when the server has no
// matching cost (→ caller falls back to the git-note figure / offline).
export function resolveServerCost(model: string, server: ServerModelCost[] | undefined): number | undefined {
  if (!server || server.length === 0) return undefined;
  const m = model.toLowerCase();
  const exact = server.find((e) => e.model.toLowerCase() === m);
  if (exact) return exact.cost;
  const brand = server.filter((e) => {
    const s = e.model.toLowerCase();
    return s.startsWith(m + '-') || m.startsWith(s + '-');
  });
  if (brand.length) return brand.reduce((sum, e) => sum + (e.cost || 0), 0);
  return undefined;
}

function displayLocalStats(stats: AttributionStats, serverCostByModel?: ServerModelCost[]): void {
  console.log(chalk.bold('\n  Local Attribution Stats\n'));

  // Overview
  console.log(`  ${chalk.gray('Total commits:')}    ${chalk.white(String(stats.totalCommits))}`);
  console.log(`  ${chalk.gray('AI commits:')}       ${chalk.green(String(stats.aiCommits))} (${stats.totalCommits > 0 ? Math.round((stats.aiCommits / stats.totalCommits) * 100) : 0}%)`);
  console.log(`  ${chalk.gray('Human commits:')}    ${chalk.white(String(stats.humanCommits))} (${stats.totalCommits > 0 ? Math.round((stats.humanCommits / stats.totalCommits) * 100) : 0}%)`);
  console.log('');
  console.log(`  ${chalk.gray('Total lines added:')} ${chalk.white(String(stats.totalLinesAdded))}`);
  console.log(`  ${chalk.gray('AI lines:')}          ${chalk.green(String(stats.aiLinesAdded))} (${stats.totalLinesAdded > 0 ? Math.round((stats.aiLinesAdded / stats.totalLinesAdded) * 100) : 0}%)`);
  console.log(`  ${chalk.gray('Human lines:')}       ${chalk.white(String(stats.humanLinesAdded))} (${stats.totalLinesAdded > 0 ? Math.round((stats.humanLinesAdded / stats.totalLinesAdded) * 100) : 0}%)`);

  // Tool breakdown with bar graphs
  if (stats.byTool.size > 0) {
    console.log(chalk.bold('\n  By Tool\n'));
    const maxToolLines = Math.max(...Array.from(stats.byTool.values()).map(v => v.linesAdded));
    for (const [tool, data] of stats.byTool) {
      const pct = stats.totalLinesAdded > 0 ? Math.round((data.linesAdded / stats.totalLinesAdded) * 100) : 0;
      const bar = renderBar(data.linesAdded, maxToolLines, 20);
      console.log(
        `  ${chalk.cyan(tool.padEnd(16))} ${bar} ${chalk.white(String(pct) + '%').padStart(5)}  ${chalk.gray(`${data.commits} commits, ${data.linesAdded} lines`)}`,
      );
    }
  }

  // Model breakdown with bar graphs
  if (stats.byModel.size > 0) {
    console.log(chalk.bold('\n  By Model\n'));
    const maxModelLines = Math.max(...Array.from(stats.byModel.values()).map(v => v.linesAdded));
    for (const [model, data] of stats.byModel) {
      const pct = stats.totalLinesAdded > 0 ? Math.round((data.linesAdded / stats.totalLinesAdded) * 100) : 0;
      const bar = renderBar(data.linesAdded, maxModelLines, 20);
      console.log(
        `  ${chalk.cyan(model.padEnd(24))} ${bar} ${chalk.white(String(pct) + '%').padStart(5)}  ${chalk.gray(`${data.commits} commits`)}`,
      );
    }

    // Per-model acceptance + cost (skip if nothing meaningful to show).
    // We only print this block when at least one model has tracked line-level
    // acceptance OR a cost from git notes — otherwise the table is all zeros.
    const hasPerModelAcceptance = Array.from(stats.byModel.entries()).some(
      ([model, v]) =>
        v.acceptedLines + v.overriddenLines + v.deletedLines > 0 ||
        v.costUsd > 0 ||
        (resolveServerCost(model, serverCostByModel) ?? 0) > 0,
    );
    if (hasPerModelAcceptance) {
      console.log(chalk.bold('\n  Per-Model Acceptance & Cost\n'));
      console.log(
        '  ' + chalk.gray('Model'.padEnd(24)) +
        chalk.gray('Accept'.padStart(8)) +
        chalk.gray('Override'.padStart(10)) +
        chalk.gray('Deleted'.padStart(10)) +
        chalk.gray('Rate'.padStart(8)) +
        chalk.gray('Cost'.padStart(10)),
      );
      for (const [model, data] of stats.byModel) {
        const denom = data.acceptedLines + data.overriddenLines;
        const rate = denom > 0 ? Math.round(data.acceptanceRate * 100) + '%' : '—';
        // Prefer the server's per-model cost (covers agents whose per-commit git
        // notes carry no token counts); fall back to the git-note figure offline.
        const serverCost = resolveServerCost(model, serverCostByModel);
        const effectiveCost = serverCost != null && serverCost > 0 ? serverCost : data.costUsd;
        const cost = effectiveCost > 0 ? `$${effectiveCost.toFixed(2)}` : '—';
        console.log(
          '  ' + chalk.cyan(model.padEnd(24)) +
          chalk.green(String(data.acceptedLines).padStart(8)) +
          chalk.yellow(String(data.overriddenLines).padStart(10)) +
          chalk.red(String(data.deletedLines).padStart(10)) +
          chalk.white(rate.padStart(8)) +
          chalk.white(cost.padStart(10)),
        );
      }
    }
  }

  // Acceptance metrics
  const acc = stats.acceptance;
  if (acc.totalAiLines > 0) {
    console.log(chalk.bold('\n  AI Code Acceptance\n'));
    const accPct = Math.round(acc.acceptanceRate * 100);
    console.log(`  ${chalk.gray('Total AI lines:')}     ${chalk.white(String(acc.totalAiLines))}`);
    console.log(`  ${chalk.gray('Accepted:')}           ${chalk.green(String(acc.acceptedLines))} (${accPct}%)`);
    console.log(`  ${chalk.gray('Overridden:')}         ${chalk.yellow(String(acc.overriddenLines))}`);
    console.log(`  ${chalk.gray('Deleted:')}            ${chalk.red(String(acc.deletedLines))}`);
    console.log(`  ${chalk.gray('Acceptance rate:')}    ${renderPercentBar(accPct)} ${accPct}%`);
  }

  console.log('');
}

// ─── Command ──────────────────────────────────────────────────────────────

export async function statsCommand(opts?: { local?: boolean; dashboard?: boolean; range?: string; global?: boolean }) {
  // Default to local stats when in a git repo (per-repo, not global)
  // Use --dashboard to see org-wide API stats, --global for all repos
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (opts?.dashboard && isConnectedMode()) {
    // Skip local — go straight to API dashboard stats
  } else if (repoPath) {
    // Always show per-repo local stats when in a git repo
    try {
      const range = opts?.range || undefined;
      const stats = computeAttributionStats(repoPath, range);
      // Reconcile per-model cost against the server when connected: local git
      // notes only carry per-commit tokens for agents that surface them (Codex),
      // so other agents priced to $0. Best-effort — any failure falls back to
      // the git-note cost, keeping `origin stats` fully functional offline.
      let serverCostByModel: ServerModelCost[] | undefined;
      if (isConnectedMode()) {
        try {
          const params: Record<string, string> = {};
          const r = gitDetailed(['remote', 'get-url', 'origin'], { cwd: repoPath });
          if (r.status === 0) {
            // The stats endpoint scopes on Repo.name, which is the BASENAME
            // (e.g. "origin-demo-1"), not the "owner/repo" fullName — passing the
            // fullName silently matched nothing, so the join returned no cost.
            const m = r.stdout.trim().match(/([^/]+?)(?:\.git)?$/);
            if (m && m[1]) params.repoName = m[1];
          }
          const s = await api.getStats(params) as any;
          if (Array.isArray(s?.costByModel)) {
            serverCostByModel = s.costByModel.map((m: any) => ({ model: String(m.model), cost: Number(m.cost) || 0 }));
          }
        } catch { /* offline / API error → git-note cost */ }
      }
      displayLocalStats(stats, serverCostByModel);
    } catch (err: any) {
      console.error(chalk.red(`Error computing local stats: ${err.message}`));
    }
    return;
  } else if (!isConnectedMode()) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  // Remote (API) stats — scoped to current repo unless --global
  const params: Record<string, string> = {};
  let repoName = '';
  if (!opts?.global && repoPath) {
    const r = gitDetailed(['remote', 'get-url', 'origin'], { cwd: repoPath });
    if (r.status === 0) {
      const remoteUrl = r.stdout.trim();
      const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) {
        repoName = match[1];
        params.repoName = repoName;
      }
    }
  }

  try {
    const s = await api.getStats(params) as any;

    const headerSuffix = repoName ? ` — ${repoName}` : opts?.global ? ' — all repos' : '';
    console.log(chalk.bold(`\nOrigin Dashboard Stats${headerSuffix}\n`));
    console.log(`  ${chalk.gray('Sessions this week:')}   ${chalk.white(s.sessionsThisWeek)}`);
    console.log(`  ${chalk.gray('Active agents:')}        ${chalk.white(s.activeAgents)}`);
    console.log(`  ${chalk.gray('AI authorship:')}        ${chalk.cyan(s.aiPercentage + '%')}`);
    console.log(`  ${chalk.gray('Total tokens:')}         ${chalk.white(s.tokensUsed.toLocaleString())}`);
    console.log(`  ${chalk.gray('Est. cost this month:')} ${chalk.yellow('$' + s.estimatedCostThisMonth.toFixed(2))}`);
    console.log(`  ${chalk.gray('Lines written:')}        ${chalk.white(s.linesWrittenThisMonth.toLocaleString())}`);
    console.log(`  ${chalk.gray('Unreviewed sessions:')}  ${s.unreviewed > 0 ? chalk.red(s.unreviewed) : chalk.green('0')}`);
    console.log(`  ${chalk.gray('Policy violations:')}    ${s.policyViolations > 0 ? chalk.red(s.policyViolations) : chalk.green('0')}`);

    if (s.costByModel && s.costByModel.length > 0) {
      console.log(`\n  ${chalk.bold('Cost by Model')}`);
      for (const m of s.costByModel) {
        console.log(`    ${chalk.cyan(m.model.padEnd(28))} $${m.cost.toFixed(2).padStart(8)}  (${m.count} sessions)`);
      }
    }

    if (s.topAgents && s.topAgents.length > 0) {
      console.log(`\n  ${chalk.bold('Top Agents')}`);
      for (const a of s.topAgents) {
        console.log(`    ${chalk.white(a.name.padEnd(20))}  ${chalk.cyan(a.model.padEnd(25))}  ${chalk.dim(a.count + ' sessions')}`);
      }
    }

    console.log('');
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}
