// `origin agents check` and `origin agents login <agent>`: what Settings →
// Agents shows and its Sign in button (see ../agent-setup.ts,
// docs/AGENT_SIGN_IN.md).
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import os from 'os';
import {
  checkAgents, isSetupAgent, loginSteps, SETUP_AGENTS, type AgentSetupReport,
} from '../agent-setup.js';

/** Send the report to Origin, on this machine's row. Never throws. */
export async function reportAgentSetup(report: AgentSetupReport): Promise<boolean> {
  try {
    const { isConnectedMode, loadAgentConfig } = await import('../config.js');
    if (!isConnectedMode()) return false;
    const cfg = loadAgentConfig();
    const { api } = await import('../api.js');
    await api.reportAgentStatus({
      machineId: cfg?.machineId,
      hostname: cfg?.hostname || os.hostname(),
      report,
    });
    return true;
  } catch {
    return false;
  }
}

function line(a: AgentSetupReport['agents'][number]): string {
  const name = a.agent.padEnd(12);
  if (!a.installed) return `  ${chalk.gray('·')} ${name} ${chalk.gray('not installed')}`;
  const who = a.signedIn === true
    ? chalk.green(a.account || 'signed in') + (a.plan ? chalk.gray(` (${a.plan})`) : '')
    : a.signedIn === false ? chalk.yellow('signed out') : chalk.gray('account unknown');
  const mark = a.usable ? (a.signedIn === null ? chalk.gray('?') : chalk.green('✓')) : chalk.yellow('!');
  return `  ${mark} ${name} ${chalk.gray((a.version || '').padEnd(20))} ${who}${a.problem && a.signedIn !== false ? chalk.yellow(`  ${a.problem}`) : ''}`;
}

export async function agentsCheckAction(opts: { json?: boolean; report?: boolean; quiet?: boolean }): Promise<void> {
  const report = await checkAgents();
  let sent = false;
  if (opts.report) sent = await reportAgentSetup(report);
  if (opts.quiet) return;
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(chalk.bold('\nCoding agents on this machine\n'));
  for (const a of report.agents) console.log(line(a));
  console.log('');
  if (opts.report) console.log(sent ? chalk.gray('Sent to Origin (Settings → Agents).') : chalk.yellow('Could not send this to Origin (not logged in?).'));
  else console.log(chalk.gray(`Sign in: origin agents login <${SETUP_AGENTS.join('|')}> [--switch]`));
}

export interface LoginRunDeps {
  run: (argv: string[]) => { ok: boolean; error?: string };
  /** Check the agents and send the report to Origin; true when it was sent. */
  checkAndReport: () => Promise<{ sent: boolean; line: string | null }>;
  log: (msg: string) => void;
}

/**
 * Run the sign-out steps, report, then the sign-in steps, and report again.
 * The report straight after the sign-out is what keeps the Agents page honest
 * when the sign-in is abandoned — the window closed, the browser flow never
 * finished: it then says "signed out" instead of the account that is gone.
 */
export async function runLoginSteps(steps: string[][], signOut: number, deps: LoginRunDeps): Promise<{ failed: boolean }> {
  for (let i = 0; i < steps.length; i++) {
    deps.log(chalk.gray(`$ ${steps[i].join(' ')}`));
    const r = deps.run(steps[i]);
    if (!r.ok) {
      deps.log(chalk.red(`Could not run ${steps[i][0]}: ${r.error}`));
      // Whatever ran (a sign-out) is still worth reporting.
      if (i > 0) await deps.checkAndReport();
      return { failed: true };
    }
    if (i === signOut - 1 && i < steps.length - 1) {
      const { sent } = await deps.checkAndReport();
      deps.log(chalk.gray(sent ? 'Signed out — sent to Origin. Now sign in with the new account.' : 'Signed out. Now sign in with the new account.'));
    }
  }
  return { failed: false };
}

export async function agentsLoginAction(agent: string, opts: { switch?: boolean }): Promise<void> {
  if (!isSetupAgent(agent)) {
    console.error(chalk.red(`Unknown agent "${agent}". One of: ${SETUP_AGENTS.join(', ')}.`));
    process.exitCode = 2;
    return;
  }
  const { steps, signOut, note } = loginSteps(agent, !!opts.switch);
  console.log(chalk.bold(`\nOrigin: ${opts.switch ? 'switching the account of' : 'signing in to'} ${agent}`));
  console.log(chalk.gray('You sign in with the agent itself; Origin never sees your password or token.'));
  if (note) console.log(chalk.cyan(note));
  console.log('');
  const checkAndReport = async () => {
    const report = await checkAgents();
    const mine = report.agents.find((a) => a.agent === agent);
    return { sent: await reportAgentSetup(report), line: mine ? line(mine) : null };
  };
  const { failed } = await runLoginSteps(steps, signOut, {
    run: (argv) => {
      const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
      return r.error ? { ok: false, error: (r.error as any).code === 'ENOENT' ? 'not installed' : r.error.message } : { ok: true };
    },
    checkAndReport,
    log: (m) => console.log(m),
  });
  if (failed) { process.exitCode = 1; return; }
  console.log(chalk.gray('\nChecking the agents again…'));
  const after = await checkAndReport();
  if (after.line) console.log(after.line);
  console.log(after.sent ? chalk.gray('Sent to Origin — the settings page updates by itself.') : chalk.yellow('Could not send this to Origin (not logged in?).'));
}
