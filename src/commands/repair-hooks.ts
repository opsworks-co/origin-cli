import chalk from 'chalk';
import os from 'os';
import {
  checkHookConfigs,
  hookConfigBases,
  isRepairable,
  repairHookConfig,
  type HookConfigReport,
} from '../hook-config-health.js';

function whereLabel(base: string): string {
  return base === os.homedir() ? 'global' : base.replace(os.homedir(), '~');
}

function reasonFor(report: HookConfigReport): string {
  if (report.state === 'relocated') return 'the origin launcher it points at has moved';
  if (report.state === 'unreadable') return 'the file is not valid JSON';
  return report.detail ? `stale schema — ${report.detail}` : 'stale schema';
}

/**
 * `origin hooks repair [--check]`
 *
 * Bring every already-installed agent hook config back in line with what this
 * CLI writes. `origin upgrade` runs this for you (via the freshly installed
 * binary, so the NEW schema is the one that gets written); it exists as its own
 * command because that is also what `upgrade` needs to be able to invoke, and
 * because a hand-run repair beats telling people to re-run `origin enable` and
 * hope they pick the same scope they originally enabled.
 *
 * Only touches agents that are already enabled at a given path — see
 * hook-config-health.ts.
 */
export async function repairHooksCommand(opts: { check?: boolean; quiet?: boolean } = {}): Promise<void> {
  const say = (line: string) => { if (!opts.quiet) console.log(line); };

  say(chalk.bold('\n  Agent hook configs\n'));

  let installed = 0;
  let drifted = 0;
  let repaired = 0;
  const failures: string[] = [];

  for (const base of hookConfigBases()) {
    for (const report of checkHookConfigs(base)) {
      if (report.state === 'absent') continue;
      installed++;
      if (!isRepairable(report.state)) continue;
      drifted++;

      const location = `${report.agentName} · ${report.label} (${whereLabel(base)})`;
      if (opts.check) {
        say(chalk.yellow(`  ⚠ ${location}`));
        say(chalk.gray(`    ${reasonFor(report)}`));
        continue;
      }
      try {
        repairHookConfig(report);
        repaired++;
        say(chalk.green(`  ✓ ${location}`));
        say(chalk.gray(`    rewritten — ${reasonFor(report)}`));
      } catch (err: any) {
        failures.push(`${location}: ${err?.message || err}`);
      }
    }
  }

  for (const failure of failures) {
    say(chalk.red(`  ✗ ${failure}`));
  }

  if (installed === 0) {
    say(chalk.gray('  No agent hooks are installed on this machine.'));
    say(chalk.gray(`  Run ${chalk.white('origin enable')} to set them up.\n`));
    return;
  }
  if (drifted === 0) {
    say(chalk.green(`  All ${installed} hook config${installed === 1 ? '' : 's'} match this CLI.\n`));
    return;
  }
  if (opts.check) {
    say(chalk.yellow(`\n  ${drifted} of ${installed} hook config${installed === 1 ? '' : 's'} out of date.`));
    say(chalk.gray(`  Run ${chalk.white('origin hooks repair')} to rewrite them.\n`));
    return;
  }
  say(chalk.green(`\n  Repaired ${repaired} of ${drifted} drifted hook config${drifted === 1 ? '' : 's'}.\n`));
}
