// `origin review runner` — the local daemon for reviewer runs and local CI
// checks (commands/local-ci.ts; a repo's fixed test command on each PR head).
//
// A run queued by a PR event (Pull requests → Reviewers, trigger "when a PR opens"
// or "on every push") has nobody at a keyboard to open the getorigin:// link
// that `origin review run` needs. This daemon polls Origin for queued runs on
// the repos this machine has checkouts of, claims one (the server's claim is
// atomic, so two runners never take the same run), and runs it exactly like
// `origin review run <id>`: packet → worktree at the PR head → the reviewer
// agent read-only → findings posted. Agents run HERE, with the person's own
// logins; the server only owns the queue.
//
// `--once` drains one run and exits (cron, CI); otherwise it polls (default
// 15 s), restarting itself on upgrade like the bake-off runner. `install`
// makes it a user service (review-runner-service.ts) so it needs no terminal.
import chalk from 'chalk';
import os from 'os';
import path from 'path';
import { runDetailed } from '../utils/exec.js';
import { deriveRepoFullName } from './benchmark-bakeoff.js';
import { candidateCheckouts, knownCheckouts, remoteUrl } from '../url-handler.js';
import { canonicalRoot } from './issue-start.js';
import { defaultReviewRunDeps, runOneReview, type ReviewRunDeps, type ReviewRunOutcome } from './review-run.js';
import { localCheckEnv, runLocalCheck, runShellCommand, type ClaimedLocalCheck, type LocalCheckReport } from './local-ci.js';
import { getCurrentVersion, shouldRestartForUpgrade } from '../version-check.js';
import {
  installReviewRunnerService, reviewRunnerServiceStatus, serviceLogFile, serviceSpec, uninstallReviewRunnerService,
  type ServiceSpec, type ServiceStatus,
} from './review-runner-service.js';

export interface ClaimedReviewRun {
  id: string;
  prNumber: number;
  repoFullName: string;
  reviewerName: string;
}

/** A checkout the runner watches: where it is, and the `owner/name` its origin remote names. */
export interface WatchedCheckout {
  path: string;
  fullName: string;
}

export interface ReviewRunnerOptions {
  once?: boolean;
  interval?: string;
  repo?: string[];
}

export interface ReviewRunnerDeps {
  cwd: string;
  machineId: string;
  log: (line: string) => void;
  /** The claim call; null run when nothing is queued for `repos`. */
  claim: (data: { machineId: string; repos: string[] }) => Promise<{ run: ClaimedReviewRun | null }>;
  /** Runs one claimed run in `cwd`; the seam tests replace. */
  runReview: (runId: string, cwd: string) => Promise<ReviewRunOutcome>;
  /** Local CI: claim a queued test command (null when none) — polled before reviewer runs. */
  claimLocal?: (data: { machineId: string; repos: string[] }) => Promise<{ check: ClaimedLocalCheck | null }>;
  /** Runs one claimed local check in `cwd` and reports it. */
  runLocal?: (check: ClaimedLocalCheck, cwd: string) => Promise<LocalCheckReport>;
  /** The checkouts to consider when no --repo is given (defaults to this machine's). */
  discover: () => string[];
  sleep: (ms: number) => Promise<void>;
  /** The on-disk CLI version, re-read between polls (self-restart on upgrade). */
  version: () => string | null;
  exit: (code: number) => void;
}

function toplevel(cwd: string): string | null {
  const r = runDetailed('git', ['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * The checkouts to watch, each with its `owner/name`: the explicit `--repo`
 * paths, else the cwd's repo (when inside one) plus every checkout Origin knows
 * on this machine. Deduplicated by canonical root (a linked worktree counts as
 * its main checkout), in the order given; one without an origin remote naming
 * `owner/name` is left out. Pure apart from reading git.
 */
export function checkoutsToWatch(explicit: string[] | undefined, cwd: string, discover: () => string[]): WatchedCheckout[] {
  const dirs = explicit && explicit.length > 0
    ? explicit.map((p) => path.resolve(cwd, p))
    : [toplevel(cwd), ...discover()].filter((d): d is string => !!d);
  const out: WatchedCheckout[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const top = toplevel(dir);
    if (!top) continue;
    const root = canonicalRoot(top);
    if (seen.has(root)) continue;
    seen.add(root);
    const fullName = deriveRepoFullName(remoteUrl(root));
    if (!fullName) continue;
    out.push({ path: root, fullName });
  }
  return out;
}

/** The watched checkout for a claimed run's repo, by full name, case-insensitively. */
export function pickCheckout(repoFullName: string, checkouts: WatchedCheckout[]): WatchedCheckout | null {
  const want = repoFullName.toLowerCase();
  return checkouts.find((c) => c.fullName.toLowerCase() === want) ?? null;
}

// After this many CONSECUTIVE poll failures the daemon exits so its service
// manager respawns a fresh process with a clean connection pool — see
// benchmark-runner.ts for why a wedged pool never recovers on its own.
export const MAX_CONSECUTIVE_POLL_FAILURES = 5;

export type PollOutcome =
  | { status: 'claimed'; run: ClaimedReviewRun }
  | { status: 'idle' }
  | { status: 'poll-failed'; error: string };

/** Poll the claim endpoint once, tolerating a single transient blip (one retry). */
export async function pollForReviewRun(claim: () => Promise<{ run: ClaimedReviewRun | null }>): Promise<PollOutcome> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await claim();
      const run = res?.run ?? null;
      return run ? { status: 'claimed', run } : { status: 'idle' };
    } catch (err: any) {
      lastErr = err;
    }
  }
  return { status: 'poll-failed', error: lastErr?.serverError || lastErr?.message || String(lastErr) };
}

export async function defaultReviewRunnerDeps(): Promise<ReviewRunnerDeps> {
  const { api } = await import('../api.js');
  const base = await defaultReviewRunDeps();
  return {
    cwd: process.cwd(),
    machineId: os.hostname(),
    log: (l) => console.log(l),
    claim: (data) => api.claimReviewRun(data) as Promise<{ run: ClaimedReviewRun | null }>,
    runReview: (runId, cwd) => runOneReview(runId, {}, { ...base, cwd } as ReviewRunDeps),
    claimLocal: (data) => api.claimLocalCheck(data) as Promise<{ check: ClaimedLocalCheck | null }>,
    runLocal: (check, cwd) => runLocalCheck(check, cwd, {
      log: (l) => console.log(l),
      report: (id, data) => api.reportLocalCheck(id, data as unknown as Record<string, unknown>),
      run: runShellCommand,
      env: localCheckEnv(process.env),
    }),
    discover: () => [...candidateCheckouts(), ...knownCheckouts()],
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    version: getCurrentVersion,
    exit: (code) => process.exit(code),
  };
}

export type CycleResult = 'ran' | 'idle' | 'poll-failed';

/**
 * One poll-and-run cycle. 'ran' when a run was claimed and executed (the loop
 * polls again at once for a backlog), 'idle' when nothing is queued,
 * 'poll-failed' when the claim request itself failed.
 */
export async function reviewRunnerCycle(checkouts: WatchedCheckout[], deps: ReviewRunnerDeps): Promise<CycleResult> {
  // A local check first: a fixed command, quick next to an agent's review.
  // A failed poll here (an older server without /api/ci/local) never stops the reviews.
  if (deps.claimLocal && deps.runLocal) {
    let check: ClaimedLocalCheck | null = null;
    try {
      check = (await deps.claimLocal({ machineId: deps.machineId, repos: checkouts.map((c) => c.fullName) }))?.check ?? null;
    } catch { /* fall through to reviews */ }
    if (check) {
      deps.log(chalk.bold(`  ▶ ${check.name} on ${check.repoFullName}#${check.prNumber}`));
      const checkout = pickCheckout(check.repoFullName, checkouts);
      if (!checkout) {
        deps.log(chalk.red(`  ✗ no checkout of ${check.repoFullName} here`));
        return 'ran';
      }
      try {
        await deps.runLocal(check, checkout.path);
      } catch (err: any) {
        deps.log(chalk.red(`  ✗ ${check.id.slice(0, 8)}: ${err?.message || err}`));
      }
      return 'ran';
    }
  }
  const poll = await pollForReviewRun(() => deps.claim({ machineId: deps.machineId, repos: checkouts.map((c) => c.fullName) }));
  if (poll.status === 'poll-failed') {
    deps.log(chalk.yellow(`  poll failed: ${poll.error}`));
    return 'poll-failed';
  }
  if (poll.status === 'idle') return 'idle';
  const run = poll.run;
  deps.log(chalk.bold(`  ▶ ${run.reviewerName} on ${run.repoFullName}#${run.prNumber}`));
  const checkout = pickCheckout(run.repoFullName, checkouts);
  if (!checkout) {
    // The server matched a repo we named, so this is a race with --repo
    // changing under us; the run stays running until its server-side timeout.
    deps.log(chalk.red(`  ✗ no checkout of ${run.repoFullName} here`));
    return 'ran';
  }
  let outcome: ReviewRunOutcome;
  try {
    outcome = await deps.runReview(run.id, checkout.path);
  } catch (err: any) {
    deps.log(chalk.red(`  ✗ ${run.id.slice(0, 8)}: ${err?.message || err}`));
    return 'ran';
  }
  deps.log(outcome.ok
    ? chalk.green(`  ✓ ${run.reviewerName} on #${run.prNumber}: ${outcome.result?.verdict ?? 'done'} — ${outcome.result?.findings.length ?? 0} finding(s)`)
    : chalk.red(`  ✗ ${run.reviewerName} on #${run.prNumber}: ${outcome.error}`));
  return 'ran';
}

export async function reviewRunnerCommand(opts: ReviewRunnerOptions = {}, deps?: ReviewRunnerDeps): Promise<void> {
  const d = deps ?? await defaultReviewRunnerDeps();
  const checkouts = checkoutsToWatch(opts.repo, d.cwd, d.discover);
  if (checkouts.length === 0) {
    d.log(chalk.red('No checkout to watch: run this inside a repo with an `origin` remote, or pass --repo <path>.'));
    d.exit(2);
    return;
  }
  const intervalSec = Math.max(5, Number(opts.interval) || 15);
  const startupVersion = d.version();
  d.log(chalk.bold('\nReviewer runner'));
  for (const c of checkouts) d.log(chalk.gray(`  ${c.fullName}  ${c.path}`));
  d.log(chalk.gray(opts.once ? '  single pass (--once)\n' : `  polling every ${intervalSec}s — Ctrl-C to stop\n`));

  if (opts.once) {
    const res = await reviewRunnerCycle(checkouts, d);
    if (res === 'idle') d.log(chalk.gray('  Nothing queued.'));
    if (res === 'poll-failed') d.exit(1);
    return;
  }

  let consecutivePollFailures = 0;
  for (;;) {
    const res = await reviewRunnerCycle(checkouts, d);
    if (res === 'poll-failed') {
      consecutivePollFailures++;
      if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        d.log(chalk.red(`  ${consecutivePollFailures} consecutive poll failures — restarting for a fresh connection.`));
        d.exit(1);
        return;
      }
    } else {
      consecutivePollFailures = 0;
    }
    // A run has fully finished before cycle() returns, so exiting here never
    // interrupts one. Only when the on-disk version is strictly newer than the
    // one this process started with — an `origin upgrade` happened.
    const onDisk = d.version();
    if (shouldRestartForUpgrade(startupVersion, onDisk)) {
      d.log(chalk.cyan(`  CLI upgraded ${startupVersion} → ${onDisk} — restarting onto the new binary.`));
      d.exit(0);
      return;
    }
    if (res !== 'ran') await d.sleep(intervalSec * 1000);
  }
}

// ── As a service: `origin review runner install|uninstall|status` ───────────

export interface ReviewRunnerServiceDeps {
  platform: NodeJS.Platform;
  cwd: string;
  discover: () => string[];
  log: (line: string) => void;
  spec: (opts: ReviewRunnerOptions, cwd: string) => ServiceSpec;
  install: (spec: ServiceSpec, platform: NodeJS.Platform) => string;
  uninstall: (platform: NodeJS.Platform) => boolean;
  status: (platform: NodeJS.Platform) => ServiceStatus;
  exit: (code: number) => void;
}

function defaultServiceDeps(): ReviewRunnerServiceDeps {
  return {
    platform: process.platform,
    cwd: process.cwd(),
    discover: () => [...candidateCheckouts(), ...knownCheckouts()],
    log: (l) => console.log(l),
    spec: serviceSpec,
    install: installReviewRunnerService,
    uninstall: uninstallReviewRunnerService,
    status: reviewRunnerServiceStatus,
    exit: (code) => { process.exitCode = code; },
  };
}

/**
 * `install` writes the service for THIS machine's checkouts (the same ones the
 * daemon would watch from here, so an install with nothing to watch is refused
 * instead of leaving a service that exits every ten seconds), `uninstall`
 * stops and removes it, `status` says whether it is installed and running.
 */
export async function reviewRunnerServiceAction(sub: string, opts: ReviewRunnerOptions = {}, deps: ReviewRunnerServiceDeps = defaultServiceDeps()): Promise<void> {
  const { platform } = deps;
  if (sub === 'status') {
    const s = deps.status(platform);
    if (!s.installed) {
      deps.log(chalk.yellow(`Not installed. Run ${chalk.bold('origin review runner install')} so automatic reviewer runs drain in the background.`));
      return;
    }
    deps.log(s.running
      ? chalk.green(`✓ running${s.pid ? ` (pid ${s.pid})` : ''}`) + chalk.gray(`  ${s.file}`)
      : chalk.yellow(`installed but not running`) + chalk.gray(`  ${s.file} — see ${serviceLogFile()}`));
    return;
  }
  if (sub === 'uninstall') {
    deps.log(deps.uninstall(platform) ? chalk.green('✓ Removed the reviewer runner service') : chalk.gray('Nothing to remove.'));
    return;
  }
  if (sub !== 'install') {
    deps.log(chalk.red(`Unknown action "${sub}". Use install, uninstall or status, or no action to run the daemon here.`));
    deps.exit(2);
    return;
  }
  const checkouts = checkoutsToWatch(opts.repo, deps.cwd, deps.discover);
  if (checkouts.length === 0) {
    deps.log(chalk.red('No checkout to watch: run this inside a repo with an `origin` remote, or pass --repo <path>.'));
    deps.exit(2);
    return;
  }
  let file: string;
  try {
    file = deps.install(deps.spec(opts, deps.cwd), platform);
  } catch (err: any) {
    deps.log(chalk.red(`Could not install the service: ${err?.message || err}`));
    deps.exit(1);
    return;
  }
  deps.log(chalk.green('✓ Reviewer runner installed as a background service') + chalk.gray(` (${file})`));
  for (const c of checkouts) deps.log(chalk.gray(`  ${c.fullName}  ${c.path}`));
  deps.log(chalk.gray(`  log: ${serviceLogFile()}`));
  deps.log(chalk.gray(platform === 'darwin'
    ? '  It starts at login and restarts itself after an upgrade. `origin review runner status` / `uninstall`.'
    : '  It restarts itself after an upgrade; `loginctl enable-linger` keeps it running while you are logged out. `origin review runner status` / `uninstall`.'));
}

export async function reviewRunnerAction(action: string | undefined, opts: ReviewRunnerOptions = {}): Promise<void> {
  if (action) await reviewRunnerServiceAction(action, opts);
  else await reviewRunnerCommand(opts);
}
