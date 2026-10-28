import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { api } from '../api.js';
import { git, gitOrNull } from '../utils/exec.js';
import { getCanonicalRepoPath } from '../session-state.js';
import { syncRepoHistory, BACKFILL_TIMEOUT_MS } from '../history-backfill.js';
import { syncNotesFromRemote, resolvePushRemote, redactRemoteCredentials } from '../git-notes.js';
import { publishMemoryNotes, remoteUrlFor } from '../memory-transport.js';
import { findShadowingHooksPath } from '../local-hooks-path.js';
import { memoryPushDecision, type MemoryPushSource } from '../prompt-privacy.js';

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

/**
 * Why memory was not pushed, and the one edit that changes it. Memory is
 * pushed by default, so this only runs when something turned it off — name
 * that key and file. "opted out" alone left people stuck: no command flips it.
 */
export function describeMemoryOptOut(decision: { source: MemoryPushSource; key?: string }, gitRoot: string): string[] {
  const repoFile = path.join(gitRoot, '.origin.json');
  const machineFile = '~/.origin/config.json';
  const { source } = decision;
  const where = source === 'machine' ? machineFile : repoFile;
  const why = source === 'repo-invalid'
    ? `${repoFile} is not a valid config (not a JSON object, or notesPushMemory / notesIncludePrompts is not true/false)`
    : decision.key === 'notesIncludePrompts'
      ? `notesIncludePrompts is false in ${where}, which also keeps memory on this machine`
      : `notesPushMemory is false in ${where}`;
  const set = chalk.white('"notesPushMemory": true');
  const lines = [chalk.yellow(`  ⚠ Repo memory: not pushed — ${why}.`)];
  if (source === 'machine') {
    lines.push(chalk.gray(`    To push it: set ${set} in ${machineFile} (every repo on this machine),`));
    lines.push(chalk.gray(`    or put {${set}} in ${repoFile} (this repo only). Then run origin sync again.`));
  } else {
    // The repo's own file decides; the machine setting cannot override it.
    lines.push(chalk.gray(`    To push it: set ${set} in ${repoFile}. If that file is committed, this changes it for everyone.`));
    lines.push(chalk.gray('    Then run origin sync again.'));
  }
  lines.push(chalk.gray('    Prompt text stays out of pushed memory unless notesIncludePrompts is true.'));
  return lines;
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
  // The remote memory is pushed to, and so the dashboard repo it lands on. A
  // repo name alone can't tell two clones apart — "origin" read as the
  // product, and a sync from the wrong clone looked like it had worked.
  const pushRemote = resolvePushRemote(gitRoot);
  const pushUrl = pushRemote ? remoteUrlFor(gitRoot, pushRemote) : undefined;
  console.log(chalk.gray(`  Remote: ${pushUrl ? redactRemoteCredentials(pushUrl) : 'none (memory stays on this machine)'}`));
  console.log(chalk.gray(`  Git root: ${gitRoot}`));

  // A repo-local core.hooksPath hides Origin's global git hooks: commits here
  // go out with no note and no memory, and everything below still reports
  // success. Only doctor looked for it, so sync said all green on such a repo.
  try {
    const shadow = findShadowingHooksPath(gitRoot);
    if (shadow) {
      console.log(chalk.yellow(`\n  ⚠ core.hooksPath = ${shadow.value} replaces Origin's git hooks in this repo.`));
      console.log(chalk.gray('    New commits here are not captured and carry no memory to the remote.'));
      console.log(chalk.gray(`    Run ${chalk.white('origin doctor --fix')} to run those hooks after Origin's instead.\n`));
    }
  } catch { /* best-effort — doctor has the full check */ }

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
    const { outcome, error, memory: mem } = await publishMemoryNotes(gitRoot, 'sync', { timeoutMs: BACKFILL_TIMEOUT_MS });
    const onDashboard = mem
      ? `${mem.sessions} session${mem.sessions === 1 ? '' : 's'}, ${mem.commits} commit${mem.commits === 1 ? '' : 's'}${mem.brief ? ', brief' : ''}`
      : '';
    // Each way memory fails to arrive gets its own line: a failed push and a
    // clone with no memory both used to print a gray "–" that read as fine.
    if (outcome === 'failed') {
      console.log(chalk.yellow(`  ⚠ Repo memory push failed: ${error || 'the remote did not accept refs/notes/origin-memory'}`));
      console.log(chalk.gray('    Nothing reached the remote, so the dashboard has no new memory. It is kept and retried on the next sync.'));
    } else if (outcome === 'nothing-local') {
      if (mem) {
        console.log(chalk.green(`  ✓ Repo memory on dashboard: ${onDashboard} (none written in this clone)`));
      } else {
        console.log(chalk.yellow('  ⚠ Repo memory: this clone has none to push (no refs/notes/origin-memory here).'));
        console.log(chalk.gray('    Memory is written where your agent sessions run. Run origin sync in that clone,'));
        console.log(chalk.gray('    or check origin doctor here if your sessions do run in this one.'));
      }
    } else if (outcome === 'pushed') {
      if (mem) {
        console.log(chalk.green(`  ✓ Repo memory on dashboard: ${onDashboard}`));
      } else {
        console.log(chalk.yellow('  ⚠ Repo memory pushed, but the dashboard did not pick it up (repo not added in Origin, or the server could not read the remote).'));
      }
    } else if (outcome === 'no-remote') {
      console.log(chalk.gray('  – Repo memory: no remote to push to — it stays on this machine'));
    } else {
      for (const line of describeMemoryOptOut(memoryPushDecision(gitRoot), gitRoot)) console.log(line);
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Repo memory publish failed: ${err.message}`));
  }

  // .entire/ is written only by the Entire CLI — Origin never creates it, so
  // a repo without one is the normal case, not something to warn about.
  if (!fs.existsSync(entireDir)) {
    console.log();
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
