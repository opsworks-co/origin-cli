import chalk from 'chalk';
import { loadPlugins, registerPlugin, removePlugin } from '../plugin-system.js';

/**
 * `origin plugin list` — List installed plugins.
 */
export async function pluginListCommand(): Promise<void> {
  const plugins = loadPlugins();

  if (plugins.length === 0) {
    console.log(chalk.gray('\nNo plugins installed.'));
    console.log(chalk.gray('Install one with: origin plugin install <name> <command> [--events <events>]\n'));
    return;
  }

  console.log(chalk.bold(`\nInstalled Plugins (${plugins.length}):\n`));

  for (const plugin of plugins) {
    console.log(`  ${chalk.cyan(plugin.name)}`);
    console.log(chalk.gray(`    Command:  ${plugin.command}`));
    console.log(chalk.gray(`    Events:   ${plugin.events.join(', ')}`));
    if (plugin.description) {
      console.log(chalk.gray(`    Desc:     ${plugin.description}`));
    }
    if (plugin.installedAt) {
      console.log(chalk.gray(`    Installed: ${new Date(plugin.installedAt).toLocaleDateString()}`));
    }
    console.log();
  }
}

/**
 * `origin plugin install <name> <command>` — Register a new plugin.
 *
 * Options:
 *   --events <events>  Comma-separated list of events (default: "*" for all)
 *   --description <d>  Description of the plugin
 */
export async function pluginInstallCommand(
  name: string,
  command: string,
  opts: { events?: string; description?: string },
): Promise<void> {
  const events = opts.events
    ? opts.events.split(',').map(e => e.trim()).filter(Boolean)
    : ['*'];

  console.log(chalk.bold(`\nInstalling plugin "${name}"...\n`));
  console.log(chalk.gray(`  Command: ${command}`));
  console.log(chalk.gray(`  Events:  ${events.join(', ')}`));

  const result = registerPlugin(name, command, events, opts.description);

  if (result.success) {
    console.log(chalk.green(`\n  ${result.message}`));
    console.log(chalk.gray('\n  Plugin protocol: JSON on stdin/stdout'));
    console.log(chalk.gray('  Input:  { "event": "...", "data": {...}, "timestamp": "..." }'));
    console.log(chalk.gray('  Output: { "status": "ok"|"error"|"skip", "data": {...} }'));
  } else {
    console.log(chalk.red(`\n  ${result.message}`));
    process.exit(1);
  }
}

/**
 * `origin plugin remove <name>` — Unregister a plugin.
 */
export async function pluginRemoveCommand(name: string): Promise<void> {
  const result = removePlugin(name);

  if (result.success) {
    console.log(chalk.green(`\n  ${result.message}\n`));
  } else {
    console.log(chalk.red(`\n  ${result.message}\n`));
    process.exit(1);
  }
}
