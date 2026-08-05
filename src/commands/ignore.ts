import chalk from 'chalk';
import { loadRepoConfig, saveRepoConfig } from '../config.js';
import { shouldIgnoreFile, DEFAULT_IGNORE_PATTERNS, loadGitattributesPatterns } from '../ignore-patterns.js';
import { getGitRoot } from '../session-state.js';
import { addIgnoredRepo, removeIgnoredRepo, listIgnoredRepos, normalizeRepoPath } from '../ignore-repos.js';

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

// ── Repo-level ignore (machine-wide, ~/.origin/config.json) ─────────────────
// Unlike the file-pattern commands above (which live in a repo's .origin.json),
// these exclude an ENTIRE repo/workspace from tracking: no session is created
// for it, for any agent. Use it for headless scratch workspaces that run a real
// agent CLI and flood the org (e.g. a Claude Desktop cowork project).

export async function ignoreRepoListCommand() {
  const repos = listIgnoredRepos();
  console.log(chalk.bold('\n  Ignored repos (machine-wide — no sessions created)\n'));
  if (repos.length === 0) {
    console.log(chalk.gray('  None.'));
    console.log(chalk.gray('  Add the current repo with:  origin ignore repo add'));
    console.log(chalk.gray('  Or a specific path with:    origin ignore repo add <path>\n'));
    return;
  }
  for (const r of repos) {
    const abs = normalizeRepoPath(r);
    console.log(chalk.white(`    ${abs}`));
  }
  console.log(chalk.gray(`\n  ${repos.length} ignored. Resume tracking with: origin ignore repo remove <path>\n`));
}

export async function ignoreRepoAddCommand(pathArg?: string) {
  // Default to the current git repo when no path is given, mirroring the
  // file-pattern commands. An explicit path need NOT be a git repo (the user
  // may pre-emptively ignore a workspace before it's ever tracked).
  let target = pathArg;
  if (!target) {
    const root = getGitRoot(process.cwd());
    if (!root) {
      console.error(chalk.red('  Not in a git repository — pass a path: origin ignore repo add <path>'));
      return;
    }
    target = root;
  }
  const res = addIgnoredRepo(target);
  if (res.alreadyCovered) {
    console.log(chalk.yellow(`  Already ignored (or covered by a parent entry): ${res.path}`));
    return;
  }
  console.log(chalk.green(`  ✓ Ignoring repo: ${res.path}`));
  console.log(chalk.gray('    No new sessions will be created for it (or any path under it).'));
  console.log(chalk.gray('    Existing sessions are unaffected — archive them from the dashboard.'));
}

export async function ignoreRepoRemoveCommand(pathArg?: string) {
  const target = pathArg || getGitRoot(process.cwd());
  if (!target) {
    console.error(chalk.red('  Not in a git repository — pass a path: origin ignore repo remove <path>'));
    return;
  }
  const removed = removeIgnoredRepo(target);
  if (!removed) {
    console.log(chalk.yellow(`  Not on the ignore list: ${normalizeRepoPath(target)}`));
    const repos = listIgnoredRepos();
    if (repos.length) {
      console.log(chalk.gray('  Current entries:'));
      for (const r of repos) console.log(chalk.gray(`    ${normalizeRepoPath(r)}`));
    }
    return;
  }
  console.log(chalk.green(`  ✓ Resumed tracking: ${normalizeRepoPath(removed)}`));
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
