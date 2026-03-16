import chalk from 'chalk';
import { requirePlatform } from '../config.js';
import { api } from '../api.js';

export async function reposCommand() {
  if (!requirePlatform('repos')) return;
  try {
    const repos = await api.getRepos() as any[];

    if (repos.length === 0) {
      console.log(chalk.gray('No repositories connected.'));
      return;
    }

    console.log(chalk.bold(`\nRepositories (${repos.length})\n`));

    for (const r of repos) {
      const synced = r.syncedAt ? `synced ${timeAgo(r.syncedAt)}` : 'never synced';
      console.log(
        `  ${chalk.dim(r.id.slice(0, 8))}  ${chalk.white(r.name.padEnd(25))}  ${chalk.dim(r.provider.padEnd(10))}  ${chalk.dim((r._count?.commits ?? 0) + ' commits')}  ${chalk.gray(synced)}`
      );
      console.log(`           ${chalk.gray(r.path)}`);
    }
    console.log('');
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}

export async function repoAddCommand(opts: { name: string; path: string; provider?: string }) {
  try {
    const repo = await api.createRepo(opts) as any;
    console.log(chalk.green(`✓ Repository added: ${repo.name} (${repo.id.slice(0, 8)}...)`));
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
