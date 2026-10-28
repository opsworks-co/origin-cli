// `origin issue run-epic <KEY>` — an epic worked through as a sequence of its
// stories, one agent at a time.
//
// Starting an agent on the epic itself hands it the whole epic as one prompt,
// which is too large a unit of work. This instead takes the epic's stories
// from the live task queue (docs/LIVE_TASK_QUEUE.md) one by one:
//
//   1. Claim the next open, unclaimed story under the epic, by priority
//      (POST …/issues/claim-next with the epic's id as parentId). None left:
//      done.
//   2. Start the agent on it exactly as `origin issue start` does — the
//      story's branch, its prompt with the epic it is part of, its run on the
//      issue's Attempts table, its session linked — and wait for the agent to
//      exit. The claim's lease is renewed while it runs.
//   3. The agent exited cleanly (and its branch was pushed, unless
//      --no-publish): finish the claim with the PR it opened. Anything else:
//      release the claim and stop — a story the agent could not do would be
//      claimed again by the next turn of the loop.
//   4. Back to 1, until none is left or --max stories are done.
//
// Each story closes as its source says (an Origin issue at finish, a GitHub
// or GitLab one on the host too, a Jira story when Jira's sync sees its PR),
// so the epic's done count on the Issues tab moves as the loop goes.
import chalk from 'chalk';
import os from 'os';
import { isIssueAgent, ISSUE_AGENTS, type IssueAgent } from '../issue-prompt.js';
import { canonicalRoot, issueStartCommand, toplevel, type IssueStartDeps, type IssueStartResult } from './issue-start.js';

export interface IssueRunEpicOptions {
  agent?: string;
  /** Stop after this many stories (default: until none is left). */
  max?: string | number;
  /** Each story in a worktree of its own (`origin issue start --worktree`). */
  worktree?: string | boolean;
  /** commander: --no-publish sets false. */
  publish?: boolean;
  /** Start a story even when someone is already on it. */
  force?: boolean;
  json?: boolean;
}

/** What the loop touches, so tests can stand in for it. */
export interface IssueRunEpicDeps {
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
  connected: () => boolean;
  api: {
    previewRoute: (data: { repoPath: string; repoUrl?: string }) => Promise<any>;
    getIssue: (repoId: string, shortId: string) => Promise<any>;
    claimNextIssue: (repoId: string, data: { parentId?: string; agent: string; host: string; leaseSeconds?: number }) => Promise<any>;
    renewIssueClaim: (repoId: string, shortId: string, claimToken: string, leaseSeconds?: number) => Promise<any>;
    releaseIssueClaim: (repoId: string, shortId: string, claimToken: string) => Promise<any>;
    finishIssueClaim: (repoId: string, shortId: string, data: { claimToken: string; resolution: string; prUrl?: string | null }) => Promise<any>;
  } | null;
  hostname: () => string;
  /** Runs one story to the end: `origin issue start` (issue-start.ts). */
  start: (id: string, opts: Parameters<typeof issueStartCommand>[1], injected?: Partial<IssueStartDeps>) => Promise<IssueStartResult | null>;
  /** How often the claim's lease is pushed out while the agent runs. */
  renewEveryMs: number;
}

/** The lease asked for on each claim (seconds); renewed well before it runs out. */
export const RUN_EPIC_LEASE_S = 60 * 60;
const RENEW_EVERY_MS = 10 * 60_000;

export interface RunEpicStory {
  shortId: string;
  title: string;
  /** finished: the claim was finished; released: given back; lost: the lease was gone when the run ended. */
  outcome: 'finished' | 'released' | 'lost';
  exitCode: number | null;
  branch: string | null;
  prUrl: string | null;
}

export interface IssueRunEpicResult {
  epic: { shortId: string; title: string };
  stories: RunEpicStory[];
  /** Why the loop stopped. */
  stopped: 'none-left' | 'max' | 'failed' | 'error';
}

async function defaultDeps(): Promise<IssueRunEpicDeps> {
  const [{ api }, { isConnectedMode }] = await Promise.all([import('../api.js'), import('../config.js')]);
  return {
    cwd: process.cwd(),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    connected: isConnectedMode,
    api: {
      previewRoute: api.previewRoute, getIssue: api.getIssue, claimNextIssue: api.claimNextIssue,
      renewIssueClaim: api.renewIssueClaim, releaseIssueClaim: api.releaseIssueClaim, finishIssueClaim: api.finishIssueClaim,
    },
    hostname: () => os.hostname(),
    start: issueStartCommand,
    renewEveryMs: RENEW_EVERY_MS,
  };
}

/** The pull request a start's publish line names, if it opened or pushed to one. */
export function prUrlOfPublish(line: string | null | undefined): string | null {
  if (!line || !/^(Opened|Pushed to) pull request /.test(line)) return null;
  return /https?:\/\/\S+/.exec(line)?.[0] ?? null;
}

function apiFailure(err: any): string {
  const msg = String(err?.message || err || 'no answer');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /operation was aborted|timed? ?out/i.test(msg)) return 'it did not answer in time';
  return err?.status ? `HTTP ${err.status}: ${msg}` : msg;
}

export async function issueRunEpicCommand(
  id: string,
  opts: IssueRunEpicOptions = {},
  injected?: Partial<IssueRunEpicDeps>,
): Promise<IssueRunEpicResult | null> {
  const deps: IssueRunEpicDeps = { ...(await defaultDeps()), ...(injected || {}) };
  const agent = (opts.agent || 'claude').toLowerCase();
  if (!isIssueAgent(agent) || agent === 'print') {
    deps.error(chalk.red(`Unknown agent "${opts.agent}". Use one of: ${ISSUE_AGENTS.filter((a) => a !== 'print').join(', ')}.`));
    process.exitCode = 2;
    return null;
  }
  const max = opts.max === undefined ? null : Number(opts.max);
  if (max !== null && (!Number.isInteger(max) || max < 1)) {
    deps.error(chalk.red(`--max takes a whole number of stories, not "${opts.max}".`));
    process.exitCode = 2;
    return null;
  }
  const work = toplevel(deps.cwd);
  if (!work) {
    deps.error(chalk.red('Not inside a git repository.'));
    process.exitCode = 1;
    return null;
  }
  if (!deps.api || !deps.connected()) {
    deps.error(chalk.red('run-epic takes each story from the task queue on Origin, so it needs `origin login` first.'));
    process.exitCode = 1;
    return null;
  }

  // The epic, on Origin: its stories are claimed by its id.
  const canonical = canonicalRoot(work);
  let repoId: string | null = null;
  let epic: { id: string; shortId: string; title: string; type: string | null } | null = null;
  try {
    const route = await deps.api.previewRoute({ repoPath: canonical });
    repoId = route?.repo?.id ?? null;
    if (repoId) {
      const it = await deps.api.getIssue(repoId, id.replace(/^#(?=\d+$)/, ''));
      if (it && typeof it.id === 'string' && typeof it.shortId === 'string') epic = { id: it.id, shortId: it.shortId, title: String(it.title ?? ''), type: typeof it.type === 'string' ? it.type : null };
    }
  } catch (err: any) {
    if (err?.status !== 404) {
      deps.error(chalk.red(`Could not read ${id} from Origin: ${apiFailure(err)}.`));
      process.exitCode = 1;
      return null;
    }
  }
  if (!repoId) {
    deps.error(chalk.red('This repository is not on Origin yet; `origin status` shows where its sessions go.'));
    process.exitCode = 1;
    return null;
  }
  if (!epic) {
    deps.error(chalk.red(`No issue on Origin matches "${id}".`));
    process.exitCode = 1;
    return null;
  }
  if (epic.type !== 'epic') deps.log(chalk.gray(`${epic.shortId} is not an epic; working through the issues under it anyway.`));
  deps.log(chalk.bold(`Working through ${epic.shortId} — ${epic.title}`) + chalk.gray(` with ${agent}, one story at a time${max ? `, at most ${max}` : ''}`));

  const stories: RunEpicStory[] = [];
  const host = deps.hostname();
  let stopped: IssueRunEpicResult['stopped'] = 'none-left';
  const startOpts = { agent: agent as IssueAgent, worktree: opts.worktree, publish: opts.publish, force: opts.force };

  while (max === null || stories.length < max) {
    // 1. The next story under the epic nobody holds.
    let claim: any;
    try {
      claim = await deps.api.claimNextIssue(repoId, { parentId: epic.id, agent, host, leaseSeconds: RUN_EPIC_LEASE_S });
    } catch (err: any) {
      deps.error(chalk.red(`Could not take the next story of ${epic.shortId}: ${apiFailure(err)}.`));
      stopped = 'error';
      break;
    }
    const task = claim?.task;
    const token: string | null = typeof claim?.claimToken === 'string' ? claim.claimToken : null;
    if (!task || typeof task.shortId !== 'string') break;
    if (!token) {
      // A story was claimed but nothing can renew, release or finish it: not "none left".
      deps.error(chalk.red(`Origin claimed ${task.shortId} but gave no claim token (an older server?). Stopping; its lease runs out on its own.`));
      stopped = 'error';
      break;
    }
    const n = stories.length + 1;
    deps.log(chalk.bold(`\n— ${task.shortId} ${task.title ?? ''}`) + chalk.gray(` (story ${n}${max ? ` of at most ${max}` : ''})`));

    // 2. The agent on it, as Start would; the lease kept alive meanwhile.
    let lost = false;
    const renew = setInterval(() => {
      deps.api!.renewIssueClaim(repoId!, task.shortId, token, RUN_EPIC_LEASE_S).catch((err: any) => {
        if (err?.status === 409) lost = true; // taken from us: nothing to renew or finish
      });
    }, deps.renewEveryMs);
    renew.unref?.();
    let r: IssueStartResult | null = null;
    let startError: string | null = null;
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      r = await deps.start(task.shortId, startOpts);
    } catch (err: any) {
      startError = err?.message || String(err);
    } finally {
      clearInterval(renew);
    }
    process.exitCode = before;

    // 3. Finish or release from how it ended.
    const ok = !!r && r.launched !== null && r.exitCode === 0;
    const prUrl = ok ? prUrlOfPublish(r!.published) : null;
    const story: RunEpicStory = { shortId: task.shortId, title: String(task.title ?? ''), outcome: 'released', exitCode: r?.exitCode ?? null, branch: r?.branch ?? null, prUrl };
    if (ok) {
      try {
        const f = await deps.api.finishIssueClaim(repoId, task.shortId, {
          claimToken: token,
          resolution: `${agent} finished it via origin issue run-epic ${epic.shortId}${prUrl ? ` — ${prUrl}` : ''}`,
          prUrl,
        });
        story.outcome = f?.outcome ? 'finished' : 'lost';
        deps.log(chalk.green(`✓ ${task.shortId} done${prUrl ? ` — ${prUrl}` : ''}${f?.outcome === 'pending' ? chalk.gray(' (closes when its tracker sees the work)') : ''}`));
      } catch (err: any) {
        story.outcome = 'lost';
        deps.error(chalk.yellow(err?.status === 409
          ? `${task.shortId}: the claim was gone when the agent finished (its lease ran out and another agent took it); the work is on ${r?.branch ?? 'its branch'}.`
          : `${task.shortId}: could not mark it finished (${apiFailure(err)}); the work is on ${r?.branch ?? 'its branch'}.`));
      }
      stories.push(story);
      continue;
    }
    if (lost) story.outcome = 'lost';
    else {
      try { await deps.api.releaseIssueClaim(repoId, task.shortId, token); } catch { story.outcome = 'lost'; }
    }
    stories.push(story);
    const why = startError
      ? `could not start ${agent} (${startError})`
      : !r ? 'the start was refused (see above)'
        : r.launched === null ? `${agent} is not installed here, so the prompt was only printed`
          : `${agent} exited with code ${r.exitCode}`;
    deps.error(chalk.yellow(`Stopped at ${task.shortId}: ${why}. The story is ${story.outcome === 'released' ? 'back in the queue' : 'held by someone else'}; fix what stopped it and run again.`));
    stopped = 'failed';
    break;
  }
  if (stopped === 'none-left' && max !== null && stories.length >= max) stopped = 'max';

  // 4. The tally.
  const done = stories.filter((s) => s.outcome === 'finished');
  deps.log('');
  if (stopped === 'none-left') {
    deps.log(done.length > 0
      ? chalk.green(`✓ Worked through ${done.length} ${done.length === 1 ? 'story' : 'stories'} of ${epic.shortId}: ${done.map((s) => s.shortId).join(', ')}. Nothing open is left under it.`)
      : chalk.gray(`Nothing to do: no open, unclaimed story under ${epic.shortId}.`));
  } else if (stopped === 'max') {
    deps.log(chalk.green(`✓ Did ${done.length} ${done.length === 1 ? 'story' : 'stories'} of ${epic.shortId} (--max ${max}): ${done.map((s) => s.shortId).join(', ')}. Run again for the rest.`));
  } else if (done.length > 0) {
    deps.log(chalk.gray(`Done before stopping: ${done.map((s) => s.shortId).join(', ')}.`));
  }
  if (opts.json) deps.log(JSON.stringify({ epic, stories, stopped }, null, 2));
  process.exitCode = stopped === 'failed' || stopped === 'error' ? 1 : 0;
  return { epic: { shortId: epic.shortId, title: epic.title }, stories, stopped };
}

export async function issueRunEpicAction(id: string, opts: IssueRunEpicOptions): Promise<void> {
  await issueRunEpicCommand(id, opts);
}
