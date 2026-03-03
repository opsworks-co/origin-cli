import chalk from 'chalk';
import { api } from '../api.js';

export async function statsCommand() {
  try {
    const s = await api.getStats() as any;

    console.log(chalk.bold('\nOrigin Dashboard Stats\n'));
    console.log(`  ${chalk.gray('Sessions this week:')}   ${chalk.white(s.sessionsThisWeek)}`);
    console.log(`  ${chalk.gray('Active agents:')}        ${chalk.white(s.activeAgents)}`);
    console.log(`  ${chalk.gray('AI authorship:')}        ${chalk.cyan(s.aiPercentage + '%')}`);
    console.log(`  ${chalk.gray('Total tokens:')}         ${chalk.white(s.tokensUsed.toLocaleString())}`);
    console.log(`  ${chalk.gray('Est. cost this month:')} ${chalk.yellow('$' + s.estimatedCostThisMonth.toFixed(2))}`);
    console.log(`  ${chalk.gray('Lines written:')}        ${chalk.white(s.linesWrittenThisMonth.toLocaleString())}`);
    console.log(`  ${chalk.gray('Unreviewed sessions:')}  ${s.unreviewed > 0 ? chalk.red(s.unreviewed) : chalk.green('0')}`);
    console.log(`  ${chalk.gray('Policy violations:')}    ${s.policyViolations > 0 ? chalk.red(s.policyViolations) : chalk.green('0')}`);

    if (s.costByModel && s.costByModel.length > 0) {
      console.log(`\n  ${chalk.bold('Cost by Model')}`);
      for (const m of s.costByModel) {
        console.log(`    ${chalk.cyan(m.model.padEnd(28))} $${m.cost.toFixed(2).padStart(8)}  (${m.count} sessions)`);
      }
    }

    if (s.topAgents && s.topAgents.length > 0) {
      console.log(`\n  ${chalk.bold('Top Agents')}`);
      for (const a of s.topAgents) {
        console.log(`    ${chalk.white(a.name.padEnd(20))}  ${chalk.cyan(a.model.padEnd(25))}  ${chalk.dim(a.count + ' sessions')}`);
      }
    }

    console.log('');
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}
