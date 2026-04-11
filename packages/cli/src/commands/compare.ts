import chalk from 'chalk';
import { gitDetailed } from '../utils/exec.js';
import { computeAttributionStats, type AttributionStats } from '../attribution.js';
import { getGitRoot } from '../session-state.js';

const SAFE_REF = /^[a-zA-Z0-9_./~^-]+$/;

function renderBar(pct: number, width: number = 15): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

function pct(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 100) : 0;
}

function displaySideBySide(labelA: string, statsA: AttributionStats, labelB: string, statsB: AttributionStats): void {
  const a = statsA;
  const b = statsB;

  const colW = 20;
  const headerA = labelA.length > colW ? labelA.slice(0, colW - 1) + '…' : labelA;
  const headerB = labelB.length > colW ? labelB.slice(0, colW - 1) + '…' : labelB;

  console.log(chalk.bold('\n  Origin Compare\n'));
  console.log(`  ${''.padEnd(18)}${chalk.bold(headerA.padEnd(colW + 8))}${chalk.bold(headerB)}`);
  console.log('');

  // AI commits %
  const aiCommitsPctA = pct(a.aiCommits, a.totalCommits);
  const aiCommitsPctB = pct(b.aiCommits, b.totalCommits);
  console.log(
    `  ${chalk.gray('AI commits %'.padEnd(18))}` +
    `${renderBar(aiCommitsPctA)} ${chalk.white(String(aiCommitsPctA) + '%').padStart(5)}   ` +
    `${renderBar(aiCommitsPctB)} ${chalk.white(String(aiCommitsPctB) + '%').padStart(5)}`,
  );

  // AI lines %
  const aiLinesPctA = pct(a.aiLinesAdded, a.totalLinesAdded);
  const aiLinesPctB = pct(b.aiLinesAdded, b.totalLinesAdded);
  console.log(
    `  ${chalk.gray('AI lines %'.padEnd(18))}` +
    `${renderBar(aiLinesPctA)} ${chalk.white(String(aiLinesPctA) + '%').padStart(5)}   ` +
    `${renderBar(aiLinesPctB)} ${chalk.white(String(aiLinesPctB) + '%').padStart(5)}`,
  );

  // Total commits
  console.log(
    `  ${chalk.gray('Total commits'.padEnd(18))}` +
    `${chalk.white(String(a.totalCommits).padStart(colW))}   ` +
    `${chalk.white(String(b.totalCommits).padStart(colW))}`,
  );

  // Total lines
  console.log(
    `  ${chalk.gray('Total lines'.padEnd(18))}` +
    `${chalk.white(String(a.totalLinesAdded).padStart(colW))}   ` +
    `${chalk.white(String(b.totalLinesAdded).padStart(colW))}`,
  );

  // Tool breakdown (merge all tools from both sides)
  const allTools = new Set([...a.byTool.keys(), ...b.byTool.keys()]);
  if (allTools.size > 0) {
    console.log(chalk.bold('\n  By Tool\n'));
    for (const tool of allTools) {
      const dataA = a.byTool.get(tool);
      const dataB = b.byTool.get(tool);
      const pctA = dataA ? pct(dataA.linesAdded, a.totalLinesAdded) : 0;
      const pctB = dataB ? pct(dataB.linesAdded, b.totalLinesAdded) : 0;
      console.log(
        `  ${chalk.cyan(tool.padEnd(18))}` +
        `${renderBar(pctA)} ${chalk.white(String(pctA) + '%').padStart(5)}   ` +
        `${renderBar(pctB)} ${chalk.white(String(pctB) + '%').padStart(5)}`,
      );
    }
  }

  // Model breakdown
  const allModels = new Set([...a.byModel.keys(), ...b.byModel.keys()]);
  if (allModels.size > 0) {
    console.log(chalk.bold('\n  By Model\n'));
    for (const model of allModels) {
      const dataA = a.byModel.get(model);
      const dataB = b.byModel.get(model);
      const pctA = dataA ? pct(dataA.linesAdded, a.totalLinesAdded) : 0;
      const pctB = dataB ? pct(dataB.linesAdded, b.totalLinesAdded) : 0;
      const label = model.length > 18 ? model.slice(0, 17) + '…' : model;
      console.log(
        `  ${chalk.cyan(label.padEnd(18))}` +
        `${renderBar(pctA)} ${chalk.white(String(pctA) + '%').padStart(5)}   ` +
        `${renderBar(pctB)} ${chalk.white(String(pctB) + '%').padStart(5)}`,
      );
    }
  }

  console.log('');
}

function displaySingle(label: string, stats: AttributionStats): void {
  const s = stats;

  console.log(chalk.bold(`\n  Origin Compare — ${label}\n`));

  const aiCommitsPct = pct(s.aiCommits, s.totalCommits);
  const aiLinesPct = pct(s.aiLinesAdded, s.totalLinesAdded);

  console.log(`  ${chalk.gray('Commits:')}     ${chalk.white(String(s.totalCommits))} total — ${chalk.green(String(s.aiCommits))} AI (${aiCommitsPct}%) — ${chalk.white(String(s.humanCommits))} human`);
  console.log(`  ${chalk.gray('Lines added:')} ${chalk.white(String(s.totalLinesAdded))} total — ${chalk.green(String(s.aiLinesAdded))} AI (${aiLinesPct}%) — ${chalk.white(String(s.humanLinesAdded))} human`);

  if (s.byTool.size > 0) {
    console.log(chalk.bold('\n  By Tool\n'));
    for (const [tool, data] of s.byTool) {
      const p = pct(data.linesAdded, s.totalLinesAdded);
      console.log(`  ${chalk.cyan(tool.padEnd(18))} ${renderBar(p)} ${chalk.white(String(p) + '%').padStart(5)}  ${chalk.gray(`${data.commits} commits`)}`);
    }
  }

  console.log('');
}

export async function compareCommand(arg1: string, arg2?: string, opts?: { json?: boolean }) {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  const gitOpts = { cwd: repoPath };

  if (arg2) {
    // Two branches: compare arg1 vs arg2
    // Find merge base for each branch
    if (!SAFE_REF.test(arg1) || !SAFE_REF.test(arg2)) {
      console.error(chalk.red('Error: Invalid branch/ref name.'));
      return;
    }
    let rangeA: string;
    let rangeB: string;
    {
      const r = gitDetailed(['merge-base', arg1, arg2], gitOpts);
      if (r.status === 0) {
        const baseA = r.stdout.trim();
        rangeA = `${baseA}..${arg1}`;
        rangeB = `${baseA}..${arg2}`;
      } else {
        // Fallback: just use the branch names as ranges
        rangeA = arg1;
        rangeB = arg2;
      }
    }

    const statsA = computeAttributionStats(repoPath, rangeA);
    const statsB = computeAttributionStats(repoPath, rangeB);

    if (opts?.json) {
      console.log(JSON.stringify({
        left: { label: arg1, range: rangeA, ...serializeStats(statsA) },
        right: { label: arg2, range: rangeB, ...serializeStats(statsB) },
      }, null, 2));
      return;
    }

    displaySideBySide(arg1, statsA, arg2, statsB);
  } else if (arg1.includes('..')) {
    // Single range
    const stats = computeAttributionStats(repoPath, arg1);

    if (opts?.json) {
      console.log(JSON.stringify({ range: arg1, ...serializeStats(stats) }, null, 2));
      return;
    }

    displaySingle(arg1, stats);
  } else {
    // Single branch vs current HEAD
    if (!SAFE_REF.test(arg1)) {
      console.error(chalk.red('Error: Invalid branch/ref name.'));
      return;
    }
    const currentBranch = (() => {
      const r = gitDetailed(['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts);
      return r.status === 0 ? r.stdout.trim() : 'HEAD';
    })();

    if (arg1 === currentBranch) {
      // Same branch — just show stats for recent commits
      const stats = computeAttributionStats(repoPath);
      if (opts?.json) {
        console.log(JSON.stringify({ range: arg1, ...serializeStats(stats) }, null, 2));
        return;
      }
      displaySingle(arg1, stats);
      return;
    }

    // Compare current branch divergence from arg1
    let rangeA: string;
    let rangeB: string;
    {
      const r = gitDetailed(['merge-base', arg1, currentBranch], gitOpts);
      if (r.status === 0) {
        const base = r.stdout.trim();
        rangeA = `${base}..${arg1}`;
        rangeB = `${base}..${currentBranch}`;
      } else {
        rangeA = arg1;
        rangeB = currentBranch;
      }
    }

    const statsA = computeAttributionStats(repoPath, rangeA);
    const statsB = computeAttributionStats(repoPath, rangeB);

    if (opts?.json) {
      console.log(JSON.stringify({
        left: { label: arg1, range: rangeA, ...serializeStats(statsA) },
        right: { label: currentBranch, range: rangeB, ...serializeStats(statsB) },
      }, null, 2));
      return;
    }

    displaySideBySide(arg1, statsA, currentBranch, statsB);
  }
}

function serializeStats(stats: AttributionStats): Record<string, any> {
  return {
    totalCommits: stats.totalCommits,
    aiCommits: stats.aiCommits,
    humanCommits: stats.humanCommits,
    totalLinesAdded: stats.totalLinesAdded,
    aiLinesAdded: stats.aiLinesAdded,
    humanLinesAdded: stats.humanLinesAdded,
    byTool: Object.fromEntries(stats.byTool),
    byModel: Object.fromEntries(stats.byModel),
  };
}
