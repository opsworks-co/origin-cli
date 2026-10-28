// `origin url-handler install|uninstall|status` and `origin open-url <link>`:
// the web's "Start" button (see ../url-handler.ts).
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import {
  installUrlHandler, openUrlCommand, rememberCheckout, uninstallUrlHandler, urlHandlerStatus,
} from '../url-handler.js';
import { LAUNCH_URL_SCHEME } from '../issue-prompt.js';

/** Run inside a repo: remember it as that repo's checkout for launches. */
async function rememberHere(): Promise<string | null> {
  let root = '';
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
  // The main checkout, not a linked worktree: `origin issue start` remembers
  // that one too, and a worktree may be gone by the next launch.
  root = (await import('./issue-start.js')).canonicalRoot(root);
  try {
    const { defaultFindDeps, remoteUrl } = await import('../url-handler.js');
    const id = await (await defaultFindDeps()).repoIdOf(root, remoteUrl(root));
    if (!id) return null;
    rememberCheckout(id, root);
    return root;
  } catch { return null; }
}

export async function urlHandlerAction(sub = 'install'): Promise<void> {
  if (sub === 'status') {
    const s = urlHandlerStatus();
    console.log(s.installed
      ? chalk.green(`✓ ${LAUNCH_URL_SCHEME}:// links open Origin (${s.where})`)
      : chalk.yellow(`Not installed. Run ${chalk.bold('origin url-handler install')} so Start on Origin's issue pages opens your agent.`));
    return;
  }
  if (sub === 'uninstall') {
    console.log(uninstallUrlHandler() ? chalk.green('✓ Removed the getorigin:// handler') : chalk.gray('Nothing to remove.'));
    return;
  }
  if (sub !== 'install') {
    console.error(chalk.red(`Unknown action "${sub}". Use install, uninstall or status.`));
    process.exitCode = 2;
    return;
  }
  try {
    const where = installUrlHandler();
    console.log(chalk.green(`✓ ${LAUNCH_URL_SCHEME}:// links now open Origin`) + chalk.gray(` (${where})`));
  } catch (err: any) {
    console.error(chalk.red(`Could not register the handler: ${err?.message || err}`));
    process.exitCode = 1;
    return;
  }
  const here = await rememberHere();
  if (here) console.log(chalk.gray(`Start on this repo's issues opens ${here}.`));
  console.log(chalk.gray('Start on an issue page now opens a terminal in the repo and runs the agent. Your browser asks the first time.'));
}

export async function openUrlAction(url: string): Promise<void> {
  await openUrlCommand(url);
}
