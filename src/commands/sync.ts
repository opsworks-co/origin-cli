import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { api } from '../api.js';
import { git, gitOrNull } from '../utils/exec.js';
import { getCanonicalRepoPath } from '../session-state.js';
import { syncRepoHistory, BACKFILL_TIMEOUT_MS } from '../history-backfill.js';
import { syncNotesFromRemote } from '../git-notes.js';
import { publishMemoryNotes } from '../memory-transport.js';

function getGitRoot(): string | null {
  return gitOrNull(['rev-parse', '--show-toplevel']);
}

function getRepoName(gitRoot: string): string {
  try {
    const remoteUrl = git(['remote', 'get-url', 'origin'], { cwd: gitRoot }).trim();
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

  // Commit history: advertise HEAD's ancestry and backfill whatever the
  // server has never seen. This is the manual trigger for the same round
  // the session-start and post-commit hooks run automatically — forced, so
  // a user-invoked sync re-checks with the server even when the local sync
  // marker says everything is current.
  try {
    // syncRepoHistory reports errors through its log callback (a failed
    // advertise is status 'partial' with unknown 0) — capture the last one
    // so a 403/network failure surfaces to the user instead of vanishing.
    let lastError: string | undefined;
    const history = await syncRepoHistory({
      repoPath: getCanonicalRepoPath(gitRoot),
      hookCwd: gitRoot,
      force: true,
      ingest: (data) => api.ingestCommits(data, { timeoutMs: BACKFILL_TIMEOUT_MS }),
      log: (_message, data) => {
        if (data && typeof data.message === 'string') lastError = data.message;
      },
    });
    if (history.status === 'synced' && history.accepted > 0) {
      console.log(chalk.green(`  ✓ Commit history: backfilled ${history.accepted} missing commit${history.accepted === 1 ? '' : 's'}`));
    } else if (history.status === 'synced') {
      // `advertised` is the checked window (capped at 500), NOT Origin's
      // total — don't present it as such for large repos.
      console.log(chalk.green(`  ✓ Commit history: up to date (checked the ${history.advertised} most recent commits)`));
    } else if (history.status === 'partial' && history.unknown === 0) {
      // The advertise request itself failed — nothing was synced at all.
      console.log(chalk.yellow(`  ⚠ Commit history: sync request failed${lastError ? ` (${lastError})` : ''}`));
    } else if (history.status === 'partial') {
      console.log(chalk.yellow(`  ⚠ Commit history: partial sync (${history.accepted}/${history.unknown} missing commits sent)${lastError ? ` (${lastError})` : ''} — run again to retry`));
    } else if (history.status === 'locked') {
      console.log(chalk.yellow('  ⚠ Commit history: another sync is already running — try again in a few minutes'));
    } else if (history.status === 'no-git') {
      console.log(chalk.gray('  – Commit history: no commits to sync'));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Commit history sync failed: ${err.message}`));
  }

  // Repo memory and attribution notes, both directions. `git clone`/`pull`
  // never fetch refs/notes/* on their own: syncNotesFromRemote installs the
  // glob fetch refspec (so plain pulls carry them from here on), fetches once,
  // and folds the staged refs onto the live ones. Then push whatever memory
  // this machine wrote and ask the server to re-read it — a PR carries commits
  // and a diff, never the notes, so this is how memory reaches the dashboard.
  try {
    const folded = syncNotesFromRemote(gitRoot);
    console.log(chalk.green(folded
      ? '  ✓ Repo memory & notes: fetched from remote and folded'
      : '  ✓ Repo memory & notes: up to date with remote'));
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Repo memory & notes fetch failed: ${err.message}`));
  }
  try {
    const { pushed, memory: mem } = await publishMemoryNotes(gitRoot, 'sync', { timeoutMs: BACKFILL_TIMEOUT_MS });
    if (pushed) {
      if (mem) {
        console.log(chalk.green(`  ✓ Repo memory on dashboard: ${mem.sessions} session${mem.sessions === 1 ? '' : 's'}, ${mem.commits} commit${mem.commits === 1 ? '' : 's'}${mem.brief ? ', brief' : ''}`));
      } else {
        console.log(chalk.gray('  – Repo memory on dashboard: not refreshed (repo not registered, or no memory on the remote yet)'));
      }
    } else {
      console.log(chalk.gray('  – Repo memory: nothing to publish (no remote, or prompt text opted out)'));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Repo memory publish failed: ${err.message}`));
  }

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
