import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { api } from '../api.js';

function getGitRoot(): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function getRepoName(gitRoot: string): string {
  try {
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8', cwd: gitRoot }).trim();
    // Extract repo name from URL like git@github.com:org/repo.git or https://github.com/org/repo.git
    const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : path.basename(gitRoot);
  } catch {
    return path.basename(gitRoot);
  }
}

export async function syncCommand() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Not logged in. Run: origin login'));
    process.exit(1);
  }

  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.log(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  const repoName = getRepoName(gitRoot);
  const entireDir = path.join(gitRoot, '.entire');

  console.log(chalk.bold('\n🔄 Syncing to Origin\n'));
  console.log(chalk.gray(`  Repository: ${repoName}`));
  console.log(chalk.gray(`  Git root: ${gitRoot}`));

  // Check for .entire directory
  if (!fs.existsSync(entireDir)) {
    console.log(chalk.yellow('\n  ⚠ No .entire/ directory found in this repo.'));
    console.log(chalk.gray('    The .entire/ directory contains session data for Origin.'));
    console.log(chalk.gray('    It will be created automatically by the MCP server.\n'));
    return;
  }

  const files = fs.readdirSync(entireDir);
  console.log(chalk.gray(`  Files in .entire/: ${files.length}`));

  try {
    // Find matching repo or list repos
    const reposData = await api.getRepos() as any;
    const repos = reposData.repos ?? reposData;
    const repo = Array.isArray(repos)
      ? repos.find((r: any) => r.name === repoName || r.fullName?.includes(repoName))
      : null;

    if (repo) {
      await api.syncRepo(repo.id);
      console.log(chalk.green(`\n  ✓ Synced ${files.length} files from .entire/ to Origin`));
      console.log(chalk.gray(`    Repo: ${repo.name || repo.fullName}\n`));
    } else {
      console.log(chalk.yellow(`\n  ⚠ Repository "${repoName}" not found in Origin.`));
      console.log(chalk.gray('    Add this repository in your Origin dashboard first.\n'));
    }
  } catch (err: any) {
    console.log(chalk.red(`\n  ✗ Sync failed: ${err.message}\n`));
    process.exit(1);
  }
}
