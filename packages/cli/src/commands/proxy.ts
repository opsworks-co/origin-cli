import chalk from 'chalk';
import { installProxy, uninstallProxy, getProxyStatus } from '../git-proxy.js';

/**
 * `origin proxy install` — Install git proxy wrapper for attribution preservation.
 *
 * Creates a git wrapper at ~/.origin/bin/git that intercepts git commands
 * to preserve Origin attribution through rebases, amends, and cherry-picks.
 *
 * This is opt-in only. The wrapper includes a kill switch (touch ~/.origin/proxy-disabled).
 */
export async function proxyInstallCommand(): Promise<void> {
  console.log(chalk.bold('\nInstalling Origin git proxy...\n'));

  console.log(chalk.yellow('  WARNING: This wraps the git binary to intercept commands.'));
  console.log(chalk.yellow('  This is an advanced feature for preserving attribution.'));
  console.log(chalk.gray('  Kill switch: touch ~/.origin/proxy-disabled'));
  console.log(chalk.gray('  Uninstall:   origin proxy uninstall\n'));

  const result = installProxy();

  if (result.success) {
    console.log(chalk.green('  ' + result.message.split('\n').join('\n  ')));
  } else {
    console.log(chalk.red(`  Failed: ${result.message}`));
    process.exit(1);
  }
}

/**
 * `origin proxy uninstall` — Remove the git proxy wrapper.
 */
export async function proxyUninstallCommand(): Promise<void> {
  console.log(chalk.bold('\nRemoving Origin git proxy...\n'));

  const result = uninstallProxy();

  if (result.success) {
    console.log(chalk.green(`  ${result.message}`));
  } else {
    console.log(chalk.red(`  Failed: ${result.message}`));
    process.exit(1);
  }
}

/**
 * `origin proxy status` — Show current proxy status.
 */
export async function proxyStatusCommand(): Promise<void> {
  const status = getProxyStatus();

  console.log(chalk.bold('\nOrigin Git Proxy Status\n'));

  if (!status.installed) {
    console.log(chalk.gray('  Not installed.'));
    console.log(chalk.gray('  Install with: origin proxy install'));
    return;
  }

  console.log(chalk.green('  Installed'));
  console.log(chalk.gray(`  Wrapper:  ${status.wrapperPath}`));
  console.log(chalk.gray(`  Real git: ${status.realGitPath || 'unknown'}`));

  if (status.disabled) {
    console.log(chalk.yellow('\n  DISABLED (kill switch active)'));
    console.log(chalk.gray('  Remove: rm ~/.origin/proxy-disabled'));
  } else {
    console.log(chalk.green('\n  Active'));
  }
}
