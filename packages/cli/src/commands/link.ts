import chalk from 'chalk';
import { loadConfig, loadRepoConfig, saveRepoConfig, clearRepoConfig } from '../config.js';
import { api } from '../api.js';
import { getGitRoot } from '../session-state.js';

export async function linkCommand(slug?: string, opts?: { clear?: boolean }): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Not logged in. Run: origin login'));
    process.exit(1);
  }

  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.log(chalk.red('Not inside a git repository. Run this from your project directory.'));
    process.exit(1);
  }

  // Clear mode
  if (opts?.clear) {
    clearRepoConfig(gitRoot);
    console.log(chalk.green('\n  ✓ Agent mapping removed (.origin.json deleted)\n'));
    return;
  }

  // Show current mapping
  if (!slug) {
    const repoConfig = loadRepoConfig(gitRoot);
    if (repoConfig?.agent) {
      console.log(chalk.bold('\n🔗 Current agent mapping:\n'));
      console.log(chalk.white(`  Agent: `) + chalk.cyan(repoConfig.agent));
      console.log(chalk.gray(`  Config: ${gitRoot}/.origin.json`));
      console.log(chalk.gray(`\n  To change: origin link <new-agent-slug>`));
      console.log(chalk.gray(`  To remove: origin link --clear\n`));
    } else {
      console.log(chalk.yellow('\n  No agent mapping configured for this repo.'));
      console.log(chalk.gray('  Sessions will use the default agent from the hook command.\n'));
      console.log(chalk.gray('  To set: origin link <agent-slug>\n'));
    }
    return;
  }

  // Validate agent exists in Origin
  try {
    const agents = await api.getAgents() as any[];
    const match = agents.find((a: any) => a.slug === slug && a.status === 'ACTIVE');
    if (!match) {
      console.log(chalk.red(`\n  ✗ Agent "${slug}" not found in Origin.\n`));
      console.log(chalk.gray('  Available agents:'));
      const active = agents.filter((a: any) => a.status === 'ACTIVE');
      if (active.length === 0) {
        console.log(chalk.gray('    (none — create one in the Origin dashboard)'));
      } else {
        for (const a of active) {
          console.log(chalk.gray(`    • ${a.slug} — ${a.name}`));
        }
      }
      console.log('');
      process.exit(1);
    }

    saveRepoConfig(gitRoot, { agent: slug });
    console.log(chalk.green(`\n  ✓ Linked repo to agent "${slug}"`));
    console.log(chalk.gray(`  Agent: ${match.name} (${match.model})`));
    console.log(chalk.gray(`  Config: ${gitRoot}/.origin.json`));
    console.log(chalk.white('\n  All sessions in this repo will now be attributed to this agent.\n'));
  } catch (err: any) {
    console.log(chalk.red(`\n  ✗ Could not validate agent: ${err.message}\n`));
    process.exit(1);
  }
}
