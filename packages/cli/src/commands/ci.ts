import chalk from 'chalk';
import { execSync } from 'child_process';
import { getGitRoot, getHeadSha } from '../session-state.js';
import {
  generateCIReport,
  formatCIReport,
  collectSquashMergeAttribution,
  writeCombinedNote,
  generateGitHubActionsWorkflow,
} from '../ci-integration.js';

/**
 * `origin ci check` — Report attribution statistics for CI output.
 * Walks recent commits and reports AI vs human attribution.
 */
export async function ciCheckCommand(opts: { range?: string }): Promise<void> {
  const repoPath = getGitRoot();
  if (!repoPath) {
    console.error(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  const report = generateCIReport(repoPath, opts.range);
  const formatted = formatCIReport(report);

  // Output plain text for CI parsing
  console.log(formatted);

  // Exit with non-zero if configured thresholds are exceeded
  // (Future: make thresholds configurable via .origin.json)
}

/**
 * `origin ci squash-merge <base-branch>` — Collect attribution from all commits
 * being squashed and write a combined note to the merge commit.
 */
export async function ciSquashMergeCommand(baseBranch: string): Promise<void> {
  const repoPath = getGitRoot();
  if (!repoPath) {
    console.error(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  console.log(chalk.bold(`\nCollecting attribution from commits since ${baseBranch}...\n`));

  const result = collectSquashMergeAttribution(repoPath, baseBranch);

  if (!result.success) {
    console.error(chalk.red(`  ${result.message}`));
    process.exit(1);
  }

  console.log(chalk.gray(`  ${result.message}`));

  if (result.combinedNote) {
    // Write the combined note to HEAD (the squash merge commit)
    const headSha = getHeadSha();
    if (headSha) {
      const written = writeCombinedNote(repoPath, headSha, result.combinedNote);
      if (written) {
        console.log(chalk.green(`\n  Combined attribution note written to ${headSha.slice(0, 8)}`));
      } else {
        console.log(chalk.yellow(`\n  Warning: Could not write combined note to ${headSha.slice(0, 8)}`));
      }
    } else {
      console.log(chalk.yellow('\n  Warning: Could not determine HEAD SHA.'));
      console.log(chalk.gray('  Combined note:'));
      console.log(chalk.gray('  ' + result.combinedNote.split('\n').join('\n  ')));
    }
  }
}

/**
 * `origin ci generate-workflow` — Output a GitHub Actions YAML snippet
 * for integrating Origin attribution checks into CI.
 */
export async function ciGenerateWorkflowCommand(): Promise<void> {
  const workflow = generateGitHubActionsWorkflow();

  console.log(chalk.bold('\nGitHub Actions Workflow for Origin CI Integration:\n'));
  console.log(chalk.gray('Save this as .github/workflows/origin-attribution.yml\n'));
  console.log(workflow);
  console.log(chalk.gray('\nRequired secrets:'));
  console.log(chalk.gray('  ORIGIN_API_KEY — Your Origin API key (from `origin login`)'));
}
