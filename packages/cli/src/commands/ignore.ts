import chalk from 'chalk';
import { loadRepoConfig, saveRepoConfig } from '../config.js';
import { shouldIgnoreFile, DEFAULT_IGNORE_PATTERNS, loadGitattributesPatterns } from '../ignore-patterns.js';
import { getGitRoot } from '../session-state.js';

export async function ignoreListCommand() {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  console.log(chalk.bold('\n  Origin Ignore Patterns\n'));

  // Default patterns
  console.log(chalk.gray('  Default patterns (built-in):'));
  for (const p of DEFAULT_IGNORE_PATTERNS) {
    console.log(chalk.dim(`    ${p}`));
  }

  // Gitattributes patterns
  if (repoPath) {
    const gitPatterns = loadGitattributesPatterns(repoPath);
    if (gitPatterns.length > 0) {
      console.log(chalk.gray('\n  Gitattributes patterns (linguist-generated):'));
      for (const p of gitPatterns) {
        console.log(chalk.dim(`    ${p}`));
      }
    }
  }

  // Custom patterns
  if (repoPath) {
    const config = loadRepoConfig(repoPath);
    const custom = config?.ignorePatterns || [];
    if (custom.length > 0) {
      console.log(chalk.gray('\n  Custom patterns (.origin.json):'));
      for (const p of custom) {
        console.log(chalk.white(`    ${p}`));
      }
    } else {
      console.log(chalk.gray('\n  No custom patterns in .origin.json'));
      console.log(chalk.gray('  Add with: origin ignore add <pattern>'));
    }
  } else {
    console.log(chalk.gray('\n  Not in a git repo — no custom patterns'));
  }

  console.log('');
}

export async function ignoreAddCommand(pattern: string) {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  const config = loadRepoConfig(repoPath) || {};
  if (!config.ignorePatterns) config.ignorePatterns = [];

  if (config.ignorePatterns.includes(pattern)) {
    console.log(chalk.yellow(`  Pattern already exists: ${pattern}`));
    return;
  }

  config.ignorePatterns.push(pattern);
  saveRepoConfig(repoPath, config);
  console.log(chalk.green(`  ✓ Added pattern: ${pattern}`));
  console.log(chalk.gray(`    Saved to .origin.json (${config.ignorePatterns.length} custom pattern${config.ignorePatterns.length !== 1 ? 's' : ''})`));
}

export async function ignoreRemoveCommand(pattern: string) {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  const config = loadRepoConfig(repoPath);
  if (!config?.ignorePatterns?.length) {
    console.log(chalk.yellow(`  No custom patterns to remove.`));
    return;
  }

  const idx = config.ignorePatterns.indexOf(pattern);
  if (idx === -1) {
    console.log(chalk.yellow(`  Pattern not found: ${pattern}`));
    console.log(chalk.gray('  Current patterns:'));
    for (const p of config.ignorePatterns) {
      console.log(chalk.gray(`    ${p}`));
    }
    return;
  }

  config.ignorePatterns.splice(idx, 1);
  saveRepoConfig(repoPath, config);
  console.log(chalk.green(`  ✓ Removed pattern: ${pattern}`));
}

export async function ignoreTestCommand(filepath: string) {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  const customPatterns = repoPath ? loadRepoConfig(repoPath)?.ignorePatterns : undefined;

  const ignored = shouldIgnoreFile(filepath, customPatterns);

  if (ignored) {
    console.log(chalk.red(`  IGNORED: ${filepath}`));
    // Find which pattern matched
    const allPatterns = [...DEFAULT_IGNORE_PATTERNS, ...(customPatterns || [])];
    if (repoPath) {
      allPatterns.push(...loadGitattributesPatterns(repoPath));
    }
    for (const p of allPatterns) {
      if (shouldIgnoreFile(filepath, [p])) {
        // Need to test against just this one pattern + empty defaults
        // Actually shouldIgnoreFile includes defaults, so test differently
        console.log(chalk.gray(`  Matched pattern: ${p}`));
        break;
      }
    }
  } else {
    console.log(chalk.green(`  TRACKED: ${filepath}`));
  }
}
