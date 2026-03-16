import chalk from 'chalk';
import { requirePlatform } from '../config.js';
import { api } from '../api.js';

export async function auditCommand(opts: { action?: string; limit?: string }) {
  if (!requirePlatform('audit')) return;
  try {
    const params: Record<string, string> = {};
    if (opts.action) params.action = opts.action;
    if (opts.limit) params.limit = opts.limit;
    else params.limit = '30';

    const data = await api.getAuditLogs(params) as any;
    const entries = data.entries || [];

    if (entries.length === 0) {
      console.log(chalk.gray('No audit log entries.'));
      return;
    }

    console.log(chalk.bold(`\nAudit Log (${data.total} total)\n`));

    for (const e of entries) {
      const actionColor = e.action.includes('DELETED') ? chalk.red : e.action.includes('CREATED') ? chalk.green : chalk.cyan;
      const time = new Date(e.createdAt).toLocaleString();
      console.log(
        `  ${chalk.dim(time)}  ${actionColor(e.action.padEnd(22))}  ${chalk.gray(e.userName || 'system')}  ${chalk.dim(e.resource?.slice(0, 8) || '—')}`
      );
    }
    console.log('');
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}
