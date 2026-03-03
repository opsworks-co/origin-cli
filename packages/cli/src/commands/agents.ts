import chalk from 'chalk';
import { api } from '../api.js';

export async function agentsCommand() {
  try {
    const agents = await api.getAgents() as any[];

    if (agents.length === 0) {
      console.log(chalk.gray('No agents registered.'));
      return;
    }

    console.log(chalk.bold(`\nAgents (${agents.length})\n`));

    for (const a of agents) {
      const statusColor = a.status === 'ACTIVE' ? chalk.green : chalk.gray;
      console.log(
        `  ${chalk.dim(a.id.slice(0, 8))}  ${chalk.white(a.name.padEnd(20))}  ${chalk.cyan(a.model.padEnd(25))}  ${statusColor(a.status.padEnd(10))}  ${chalk.dim((a._count?.sessions ?? 0) + ' sessions')}`
      );
    }
    console.log('');
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}

export async function agentCreateCommand(opts: { name: string; slug: string; model: string; description?: string }) {
  try {
    const agent = await api.createAgent(opts) as any;
    console.log(chalk.green(`✓ Agent created: ${agent.name} (${agent.id.slice(0, 8)}...)`));
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}
