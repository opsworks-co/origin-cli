// `origin issue race <id> --agents claude,codex` — the same issue handed to
// several agents at once, to compare them on the issue's Attempts table.
//
// Each arm is an ordinary `origin issue start --background` on a branch of its
// own (`<issue branch>-<agent>`, see raceArmBranch), in its own worktree, so it
// gets everything a single start gets: the prompt as edited on the issue, its
// run reported to the issue, its session linked to that run, and — when its
// agent exits cleanly — its branch pushed and a pull request opened. Merging
// one of those PRs closes the issue; the others are left for you to close.
//
// The arms are launched one after another but run at the same time: each
// launch returns once its agent is detached. All of them branch from the same
// base, so the attempts start level.
import chalk from 'chalk';
import { raceAgents, agentBackgroundArgv, MIN_RACE_AGENTS, MAX_RACE_AGENTS, type IssueAgent } from '../issue-prompt.js';
import { issueStartCommand, findOnPath, missingAgentHint, type IssueStartDeps, type IssueStartResult } from './issue-start.js';

export interface IssueRaceOptions {
  agents?: string;
  timeout?: string | number;
  /** commander: --no-publish sets false. */
  publish?: boolean;
  /** Start even when someone is already on the issue. */
  force?: boolean;
}

export interface IssueRaceArm {
  agent: IssueAgent;
  started: boolean;
  branch: string | null;
  worktree: string | null;
}

export async function issueRaceCommand(
  id: string,
  opts: IssueRaceOptions,
  injected?: Partial<IssueStartDeps>,
  start: typeof issueStartCommand = issueStartCommand,
): Promise<IssueRaceArm[] | null> {
  const log = injected?.log ?? ((l: string) => console.log(l));
  const error = injected?.error ?? ((l: string) => console.error(l));
  const agents = raceAgents(opts.agents);
  if (!agents) {
    error(chalk.red(`--agents takes ${MIN_RACE_AGENTS}–${MAX_RACE_AGENTS} different agents, comma-separated (e.g. claude,codex); not "${opts.agents ?? ''}".`));
    process.exitCode = 2;
    return null;
  }

  // An agent whose CLI is not installed here is left out up front, so the
  // first arm that does run is the one that checks nobody is on the issue.
  const env = injected?.env ?? process.env;
  const platform = injected?.platform ?? process.platform;
  const arms: IssueRaceArm[] = [];
  const runnable: IssueAgent[] = [];
  for (const agent of agents) {
    const bin = agentBackgroundArgv(agent, '', '')?.[0] ?? null;
    if (bin && findOnPath(bin, env, platform)) runnable.push(agent);
    else {
      error(chalk.yellow(missingAgentHint(agent, bin ?? agent)));
      arms.push({ agent, started: false, branch: null, worktree: null });
    }
  }

  for (const [i, agent] of runnable.entries()) {
    log(chalk.bold(`\n— ${agent} (${i + 1}/${runnable.length})`));
    const before = process.exitCode;
    process.exitCode = undefined;
    let r: IssueStartResult | null = null;
    try {
      r = await start(id, {
        agent, branchSuffix: agent, background: true, timeout: opts.timeout, publish: opts.publish,
        // The arms after the first find the first one on the issue: that is the race.
        force: opts.force || i > 0,
      }, injected);
    } catch (err: any) {
      error(chalk.red(err?.message || String(err)));
    }
    const started = !!r?.background;
    arms.push({ agent, started, branch: r?.branch ?? null, worktree: r?.worktree ?? null });
    // Someone else is on the issue (or it does not exist): the first arm says
    // so and stops; racing anyway is --force.
    if (i === 0 && !r) {
      process.exitCode = process.exitCode || 1;
      return arms;
    }
    process.exitCode = before;
  }

  const ran = arms.filter((a) => a.started);
  const skipped = arms.filter((a) => !a.started);
  log('');
  if (ran.length > 0) log(chalk.green(`✓ Racing ${ran.map((a) => a.agent).join(', ')} on ${id}. Compare them on the issue's Attempts table; \`origin issue runs\` lists them here.`));
  if (skipped.length > 0) log(chalk.yellow(`Not started: ${skipped.map((a) => a.agent).join(', ')} (see above).`));
  process.exitCode = ran.length > 0 ? 0 : 1;
  return arms;
}

export async function issueRaceAction(id: string, opts: IssueRaceOptions): Promise<void> {
  await issueRaceCommand(id, opts);
}
