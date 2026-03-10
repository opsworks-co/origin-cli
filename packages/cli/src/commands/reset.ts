import chalk from 'chalk';
import { clearSessionState, getGitRoot, getGitDir, loadSessionState } from '../session-state.js';
import fs from 'fs';
import path from 'path';

/**
 * origin reset
 *
 * Clears the session state for the current repository — similar to Entire's `reset`.
 * Useful when a session gets stuck or you want to start fresh.
 *
 * Does NOT delete:
 *   - The origin-sessions branch (entrypoints)
 *   - Git notes
 *   - Remote session data
 *
 * Only clears the local .git/origin-session.json file.
 */
export async function resetCommand(opts?: { force?: boolean }) {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);

  if (!repoPath) {
    console.log(chalk.red('Not in a git repository.'));
    return;
  }

  const state = loadSessionState(cwd);

  if (!state) {
    console.log(chalk.gray('No active session state to clear.'));
    return;
  }

  const ageMs = Date.now() - new Date(state.startedAt).getTime();
  const ageMin = Math.round(ageMs / 60000);

  console.log(chalk.bold('\n  Session State'));
  console.log(chalk.gray(`    Session ID:  ${state.sessionId}`));
  console.log(chalk.gray(`    Model:       ${state.model}`));
  console.log(chalk.gray(`    Started:     ${ageMin}m ago`));
  console.log(chalk.gray(`    Prompts:     ${state.prompts.length}`));

  if (!opts?.force && ageMs < 60 * 60 * 1000) {
    console.log(chalk.yellow(`\n  This session is only ${ageMin}m old — it may still be active.`));
    console.log(chalk.gray(`  Run with --force to clear anyway.`));
    return;
  }

  clearSessionState(cwd);
  console.log(chalk.green(`\n  ✓ Session state cleared for ${repoPath}`));

  // Also clear the .git/origin-session.json directly if it exists
  const gitDir = getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
    const stateFile = path.join(resolvedGitDir, 'origin-session.json');
    if (fs.existsSync(stateFile)) {
      try {
        fs.unlinkSync(stateFile);
      } catch { /* ignore */ }
    }
  }

  console.log(chalk.gray('  Remote session data is preserved on the Origin dashboard.\n'));
}
