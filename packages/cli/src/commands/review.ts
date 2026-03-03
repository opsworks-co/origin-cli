import chalk from 'chalk';
import { api } from '../api.js';

export async function reviewCommand(sessionId: string, opts: { approve?: boolean; reject?: boolean; flag?: boolean; note?: string }) {
  try {
    let status: string;
    if (opts.approve) status = 'APPROVED';
    else if (opts.reject) status = 'REJECTED';
    else if (opts.flag) status = 'FLAGGED';
    else {
      console.error(chalk.red('Specify one of: --approve, --reject, or --flag'));
      return;
    }

    await api.reviewSession(sessionId, status, opts.note);
    const color = status === 'APPROVED' ? chalk.green : status === 'REJECTED' ? chalk.red : chalk.yellow;
    console.log(color(`✓ Session ${sessionId.slice(0, 8)}... marked as ${status}`));
    if (opts.note) console.log(chalk.gray(`  Note: ${opts.note}`));
  } catch (err: any) {
    console.error(chalk.red('Error:'), err.message);
  }
}
