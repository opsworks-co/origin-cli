// `origin xray` — the local half of the onboarding AI X-Ray.
//
// The web X-Ray (POST /api/onboarding/xray) shows how much of your recent code
// AI WROTE, from commit messages alone. It can't show how much of that code is
// still ALIVE — that needs `git blame` against the working tree, which only the
// CLI has. This command computes it locally and prints the unlock.
import chalk from 'chalk';
import { computeRepoAiSurvival } from '../xray.js';
import { runDetailed } from '../utils/exec.js';

export async function xrayCommand(opts: { days?: string } = {}): Promise<void> {
  const rootRes = runDetailed('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), timeoutMs: 5_000 });
  if (rootRes.status !== 0 || !rootRes.stdout.trim()) {
    console.log(chalk.red('\n  Not inside a git repository.\n'));
    return;
  }
  const repoPath = rootRes.stdout.trim();
  const days = Math.max(1, parseInt(opts.days || '90', 10) || 90);

  console.log(chalk.gray(`\n  Reading ${days} days of history…`));
  const r = computeRepoAiSurvival(repoPath, days);

  if (r.aiCommits === 0) {
    console.log(chalk.gray(`\n  No AI-authored commits found in the last ${days} days.`));
    console.log(chalk.gray('  (Detected from Origin-Session / Co-Authored-By trailers.)\n'));
    return;
  }

  const aiPct = r.totalCommits > 0 ? Math.round((r.aiCommits / r.totalCommits) * 100) : 0;
  const agents = Object.entries(r.byAgent).sort((a, b) => b[1] - a[1]);

  console.log(chalk.bold('\n  AI X-Ray') + chalk.gray(`  ·  last ${days} days\n`));
  console.log(`  ${chalk.bold(`${aiPct}%`)} of commits are AI-authored  ${chalk.gray(`(${r.aiCommits}/${r.totalCommits})`)}`);
  console.log(`  Top agent: ${chalk.cyan(agents[0]?.[0] ?? '—')}${agents.length > 1 ? chalk.gray(`  (+${agents.length - 1} more)`) : ''}`);

  if (r.survivalPct === null) {
    console.log(`\n  ${chalk.bold('Survival:')} ${chalk.yellow('unknown')}`);
    console.log(chalk.gray('  History was rewritten (squash-merge or rebase), so the original'));
    console.log(chalk.gray("  commits aren't reachable from HEAD. Reporting unknown, not 0%.\n"));
    return;
  }

  // Colour the headline by how much of the AI output actually stuck.
  const c = r.survivalPct >= 70 ? chalk.green : r.survivalPct >= 40 ? chalk.yellow : chalk.red;
  console.log(`\n  ${chalk.bold('Survival:')} ${c.bold(`${r.survivalPct}%`)} of AI-written lines are still alive at HEAD`);
  console.log(chalk.gray(`  ${r.aiLinesSurviving.toLocaleString()} of ${r.aiLinesAdded.toLocaleString()} lines survived; the rest were rewritten or deleted.`));
  console.log(chalk.gray('  (Conservative floor — a line a later AI commit rewrote counts once in the numerator.)\n'));
}
