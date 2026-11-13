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
// It also launches the issues the Orchestrator hands to a local agent in live
// mode (orchestrator-launch.ts): `origin issue start --background` in the
// repo's checkout, which returns as soon as the agent is going.
//
// `--once` drains one run and exits (cron, CI); otherwise it polls (default
// 15 s), restarting itself on upgrade like the bake-off runner. `--parallel n`
// drives up to n reviewer runs at once (each in its own worktree), so a slow
// optional reviewer no longer holds the rest of a PR's queue. `--no-local-ci`
// leaves local checks to another machine; `--local-ci-only` takes nothing but
// local checks (a CI box such as Jenkins, where no reviewer agent is logged
// in). The queue is shared, so splitting it is up to the runners. `install`
// makes it a user service (review-runner-service.ts) so it needs no terminal.
//
// Settings → Runners (apps/api services/runners.ts) owns two things per
// runner: how many runs at once (it overrides --parallel; 0 pauses it), and
// whom it serves — by default only its owner's own runs and PRs, or the whole
// workspace for a shared box. The runner says hello at start and every minute
// to learn its slots; the server applies both at every claim.
import chalk from 'chalk';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { runDetailed } from '../utils/exec.js';
import { deriveRepoFullName } from './benchmark-bakeoff.js';
import { candidateCheckouts, knownCheckouts, remoteUrl } from '../url-handler.js';
import { canonicalRoot } from './issue-start.js';
import { defaultReviewRunDeps, runOneReview, type ReviewRunDeps, type ReviewRunOutcome } from './review-run.js';
import { launchOrchestratorRun, type ClaimedOrchestratorRun, type LaunchResult } from './orchestrator-launch.js';
import { localCheckEnv, runLocalCheck, runnerHostFromEnv, runShellCommand, type ClaimedLocalCheck, type LocalCheckReport } from './local-ci.js';
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

/**
 * A checkout the runner watches: where it is, the `owner/name` its origin
 * remote names, and every name a claim may know it by (`names`, see
 * `repoNamesOf`). Absent `names` means just `fullName`.
 */
export interface WatchedCheckout {
  path: string;
  fullName: string;
  names?: string[];
}

/**
 * The names a remote URL can go by on the server, most specific first: the
 * whole path after the host (`origin/team/repo` on an Origin-hosted RhodeCode,
 * `group/sub/repo` on a GitLab subgroup), then its last two parts — what
 * runners have always sent, kept so a repo matched that way still is. A
 * server repo's fullName is the whole path, so a two-part-only name never
 * matched a nested repo and no runner could claim its checks or reviews.
 * Empty when the URL names no `owner/name`. Pure.
 */
export function remoteRepoNames(url: string): string[] {
  const two = deriveRepoFullName(url);
  if (!two) return [];
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  // https://host[:port]/a/b/c, ssh://git@host[:port]/a/b/c, git@host:a/b/c
  const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i) ?? u.match(/^[^/:@]+@[^/:]+:(.+)$/);
  const whole = m ? m[1]!.replace(/^\/+/, '') : null;
  return whole && whole.toLowerCase() !== two.toLowerCase() && whole.split('/').length > 2 ? [whole, two] : [two];
}

/** Every name the watched checkouts go by, for a hello or a claim. */
export function repoNamesOf(checkouts: WatchedCheckout[]): string[] {
  return [...new Set(checkouts.flatMap((c) => c.names ?? [c.fullName]))];
}

export interface ReviewRunnerOptions {
  once?: boolean;
  interval?: string;
  repo?: string[];
  /** Reviewer runs at once (default 1, at most MAX_PARALLEL). */
  parallel?: string;
  /** `--no-local-ci` (commander sets false): never claim a local check, so another machine (Jenkins) runs them. */
  localCi?: boolean;
  /** `--local-ci-only`: claim local checks only — no reviewer runs, no orchestrator issues (a CI box). */
  localCiOnly?: boolean;
  /**
   * `--scope mine|workspace`: whom the runner serves when the server first
   * registers it ("Add a host" puts it in the command). Settings → Runners
   * owns it after that, so later hellos carrying it change nothing.
   */
  scope?: string;
}

export interface ReviewRunnerDeps {
  cwd: string;
  machineId: string;
  /**
   * This process, random per start. Two daemons share a machineId (the
   * service and one started by hand), so the server tells a restarted daemon's
   * orphaned run from a live sibling's by it and by the heartbeat.
   */
  instance?: string;
  log: (line: string) => void;
  /** The claim call; null run when nothing is queued for `repos`. */
  claim: (data: { machineId: string; instance?: string; repos: string[] }) => Promise<{ run: ClaimedReviewRun | null }>;
  /**
   * Settings → Runners: says this runner is alive and what it is, and answers
   * how many runs at once the dashboard allows (0: paused). At start and every
   * RUNNER_HELLO_MS. Absent, or failing (an older server), the runner keeps
   * --parallel.
   */
  hello?: (data: RunnerHello) => Promise<{ slots?: number; scope?: string } | null>;
  /** Says this process is still driving its run, every RUNNER_HEARTBEAT_MS while one runs. */
  heartbeat?: (data: { machineId: string; instance: string }) => Promise<unknown>;
  /** Runs one claimed run in `cwd`; the seam tests replace. */
  runReview: (runId: string, cwd: string) => Promise<ReviewRunOutcome>;
  /** Local CI: claim a queued test command (null when none) — polled before reviewer runs. */
  claimLocal?: (data: { machineId: string; repos: string[] }) => Promise<{ check: ClaimedLocalCheck | null }>;
  /** Runs one claimed local check in `cwd` and reports it. */
  runLocal?: (check: ClaimedLocalCheck, cwd: string) => Promise<LocalCheckReport>;
  /** The Orchestrator's live mode: claim a queued issue for a local agent (null when none). */
  claimOrchestrator?: (data: { machineId: string; repos: string[] }) => Promise<{ run: ClaimedOrchestratorRun | null }>;
  /** Launches a claimed issue in `cwd` (`origin issue start --background`). */
  launchOrchestrator?: (run: ClaimedOrchestratorRun, cwd: string) => Promise<LaunchResult>;
  /** Tells the server how the launch went. */
  reportOrchestrator?: (runId: string, data: LaunchResult) => Promise<unknown>;
  /** The checkouts to consider when no --repo is given (defaults to this machine's). */
  discover: () => string[];
  sleep: (ms: number) => Promise<void>;
  /** The on-disk CLI version, re-read between polls (self-restart on upgrade). */
  version: () => string | null;
  exit: (code: number) => void;
  /**
   * Another worker for --parallel: its own process-like `instance` (the
   * server heartbeats and re-queues orphans per instance) and a runReview
   * that stamps it. Absent → the runner stays serial.
   */
  worker?: () => Pick<ReviewRunnerDeps, 'instance' | 'runReview'>;
}

export const MAX_PARALLEL = 8;

/** What a runner tells the server about itself (apps/api routes/runners.ts). */
export interface RunnerHello {
  machineId: string;
  version: string | null;
  parallel: number;
  mode: 'all' | 'no_local_ci' | 'local_ci_only';
  repos: string[];
  scope?: 'mine' | 'workspace';
}

/** --scope as the server names it, or undefined when absent or not one of the two. Pure. */
export function runnerScopeFlag(raw: string | undefined): RunnerHello['scope'] {
  return raw === 'mine' || raw === 'workspace' ? raw : undefined;
}

/** How often the runner re-reads its slots from the dashboard. */
export const RUNNER_HELLO_MS = 60_000;

/** The dashboard's answer → runs at once, or `fallback` when it gave none. Pure. */
export function slotsFromHello(res: { slots?: unknown } | null | undefined, fallback: number): number {
  const n = Number(res?.slots);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_PARALLEL) : fallback;
}

/** The runner's mode as the server names it. Pure. */
export function runnerMode(opts: ReviewRunnerOptions): RunnerHello['mode'] {
  return opts.localCiOnly ? 'local_ci_only' : opts.localCi === false ? 'no_local_ci' : 'all';
}

/** --parallel as a worker count: 1..MAX_PARALLEL, 1 when absent or not a number. */
export function parallelWorkers(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PARALLEL) : 1;
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
    const names = remoteRepoNames(remoteUrl(root));
    if (names.length === 0) continue;
    out.push({ path: root, fullName: names[0]!, names });
  }
  return out;
}

/** The watched checkout for a claimed run's repo, by full name, case-insensitively. */
export function pickCheckout(repoFullName: string, checkouts: WatchedCheckout[]): WatchedCheckout | null {
  const want = repoFullName.toLowerCase();
  return checkouts.find((c) => (c.names ?? [c.fullName]).some((n) => n.toLowerCase() === want)) ?? null;
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

// The server re-queues a run whose process is quiet for 5 minutes
// (apps/api routes/reviewers.ts RUNNER_INSTANCE_STALE_MS).
export const RUNNER_HEARTBEAT_MS = 60_000;

export async function defaultReviewRunnerDeps(): Promise<ReviewRunnerDeps> {
  const { api } = await import('../api.js');
  const base = await defaultReviewRunDeps();
  const instance = crypto.randomUUID();
  const worker = (): Pick<ReviewRunnerDeps, 'instance' | 'runReview'> => {
    const id = crypto.randomUUID();
    return { instance: id, runReview: (runId, cwd) => runOneReview(runId, {}, { ...base, cwd, runnerInstance: id } as ReviewRunDeps) };
  };
  return {
    cwd: process.cwd(),
    machineId: os.hostname(),
    instance,
    log: (l) => console.log(l),
    claim: (data) => api.claimReviewRun(data) as Promise<{ run: ClaimedReviewRun | null }>,
    heartbeat: (data) => api.heartbeatReviewRunner(data),
    hello: (data) => api.runnerHello({ ...data, host: runnerHostFromEnv(process.env) }) as Promise<{ slots?: number; scope?: string } | null>,
    runReview: (runId, cwd) => runOneReview(runId, {}, { ...base, cwd, runnerInstance: instance } as ReviewRunDeps),
    claimLocal: (data) => api.claimLocalCheck({ ...data, host: runnerHostFromEnv(process.env) }) as Promise<{ check: ClaimedLocalCheck | null }>,
    runLocal: (check, cwd) => runLocalCheck(check, cwd, {
      log: (l) => console.log(l),
      report: (id, data) => api.reportLocalCheck(id, data as unknown as Record<string, unknown>),
      run: runShellCommand,
      env: localCheckEnv(process.env),
    }),
    claimOrchestrator: (data) => api.claimOrchestratorRun(data) as Promise<{ run: ClaimedOrchestratorRun | null }>,
    launchOrchestrator: (run, cwd) => launchOrchestratorRun(run, cwd, [process.execPath, path.resolve(process.argv[1] || '')]),
    reportOrchestrator: (runId, data) => api.reportOrchestratorLaunch(runId, data),
    discover: () => [...candidateCheckouts(), ...knownCheckouts()],
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    version: getCurrentVersion,
    exit: (code) => process.exit(code),
    worker,
  };
}

export type CycleResult = 'ran' | 'idle' | 'poll-failed';

/**
 * One poll-and-run cycle. 'ran' when a run was claimed and executed (the loop
 * polls again at once for a backlog), 'idle' when nothing is queued,
 * 'poll-failed' when the claim request itself failed.
 */
export async function reviewRunnerCycle(checkouts: WatchedCheckout[], deps: ReviewRunnerDeps): Promise<CycleResult> {
  // An orchestrator issue first: its launch returns once the agent is going.
  // A failed poll (an older server without the endpoint) never stops the rest.
  if (deps.claimOrchestrator && deps.launchOrchestrator && deps.reportOrchestrator) {
    let run: ClaimedOrchestratorRun | null = null;
    try {
      run = (await deps.claimOrchestrator({ machineId: deps.machineId, repos: repoNamesOf(checkouts) }))?.run ?? null;
    } catch { /* fall through */ }
    if (run) {
      deps.log(chalk.bold(`  ▶ orchestrator: ${run.shortId} with ${run.agent} on ${run.repoFullName}`));
      const checkout = pickCheckout(run.repoFullName, checkouts);
      const result: LaunchResult = checkout
        ? await deps.launchOrchestrator(run, checkout.path).catch((err: any) => ({ ok: false, output: String(err?.message || err) }))
        : { ok: false, output: `no checkout of ${run.repoFullName} on ${deps.machineId}` };
      deps.log(result.ok ? chalk.green(`  ✓ ${run.agent} started on ${run.shortId}`) : chalk.red(`  ✗ ${run.shortId}: ${result.output.split('\n').slice(-3).join(' ')}`));
      try {
        await deps.reportOrchestrator(run.id, result);
      } catch (err: any) {
        deps.log(chalk.yellow(`  could not report ${run.shortId}: ${err?.message || err}`));
      }
      return 'ran';
    }
  }
  // A local check first: a fixed command, quick next to an agent's review.
  // A failed poll here (an older server without /api/ci/local) never stops the reviews.
  if (deps.claimLocal && deps.runLocal) {
    let check: ClaimedLocalCheck | null = null;
    try {
      check = (await deps.claimLocal({ machineId: deps.machineId, repos: repoNamesOf(checkouts) }))?.check ?? null;
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
  const poll = await pollForReviewRun(() => deps.claim({
    machineId: deps.machineId, ...(deps.instance ? { instance: deps.instance } : {}), repos: repoNamesOf(checkouts),
  }));
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
    // changing under us. Our next claim re-queues the run (this process holds
    // nothing then), so wait a poll rather than claiming it again at once.
    deps.log(chalk.red(`  ✗ no checkout of ${run.repoFullName} here`));
    return 'idle';
  }
  let outcome: ReviewRunOutcome;
  const { heartbeat, instance } = deps;
  const beat = heartbeat && instance
    ? setInterval(() => { heartbeat({ machineId: deps.machineId, instance }).catch(() => { /* an older server, or a blip */ }); }, RUNNER_HEARTBEAT_MS)
    : null;
  beat?.unref?.();
  try {
    outcome = await deps.runReview(run.id, checkout.path);
  } catch (err: any) {
    deps.log(chalk.red(`  ✗ ${run.id.slice(0, 8)}: ${err?.message || err}`));
    return 'ran';
  } finally {
    if (beat) clearInterval(beat);
  }
  deps.log(outcome.ok
    ? chalk.green(`  ✓ ${run.reviewerName} on #${run.prNumber}: ${outcome.result?.verdict ?? 'done'} — ${outcome.result?.findings.length ?? 0} finding(s)`)
    : chalk.red(`  ✗ ${run.reviewerName} on #${run.prNumber}: ${outcome.error}`));
  return 'ran';
}

/**
 * The deps for what this runner may claim: --no-local-ci drops the local-check
 * poll; --local-ci-only drops orchestrator issues and reviewer runs (its claim
 * never asks the server, so nothing is taken). An error when both are given. Pure.
 */
export function depsForRunnerMode(opts: ReviewRunnerOptions, d: ReviewRunnerDeps): { deps: ReviewRunnerDeps } | { error: string } {
  if (opts.localCiOnly && opts.localCi === false) return { error: '--local-ci-only and --no-local-ci cannot be used together.' };
  if (opts.localCi === false) {
    const { claimLocal, runLocal, ...rest } = d;
    return { deps: rest };
  }
  if (opts.localCiOnly) {
    const { claimOrchestrator, launchOrchestrator, reportOrchestrator, worker, heartbeat, ...rest } = d;
    return { deps: { ...rest, claim: async () => ({ run: null }) } };
  }
  return { deps: d };
}

export async function reviewRunnerCommand(opts: ReviewRunnerOptions = {}, deps?: ReviewRunnerDeps): Promise<void> {
  const base = deps ?? await defaultReviewRunnerDeps();
  const mode = depsForRunnerMode(opts, base);
  if ('error' in mode) {
    base.log(chalk.red(mode.error));
    base.exit(2);
    return;
  }
  const d = mode.deps;
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
  if (opts.localCiOnly) d.log(chalk.gray('  local checks only (--local-ci-only): no reviewer runs, no orchestrator issues'));
  else if (opts.localCi === false) d.log(chalk.gray('  no local checks (--no-local-ci): another runner takes them'));
  d.log(chalk.gray(opts.once ? '  single pass (--once)\n' : `  polling every ${intervalSec}s — Ctrl-C to stop\n`));

  // Settings → Runners decides how many runs at once; --parallel is the
  // starting number, and what stays in force when the server can't say.
  const flagSlots = parallelWorkers(opts.parallel);
  const scope = runnerScopeFlag(opts.scope);
  const helloData: RunnerHello = { machineId: d.machineId, version: startupVersion, parallel: flagSlots, mode: runnerMode(opts), repos: repoNamesOf(checkouts), ...(scope ? { scope } : {}) };
  let slots = flagSlots;
  let helloAt = 0;
  let heard = false;
  const sayHello = async (): Promise<void> => {
    helloAt = Date.now();
    if (!d.hello) return;
    let res: { slots?: number; scope?: string } | null = null;
    try { res = await d.hello(helloData); } catch { return; /* an older server, or a blip: keep what we have */ }
    const next = slotsFromHello(res, slots);
    if (next !== slots || !heard) {
      d.log(chalk.cyan(next === 0
        ? '  Paused in Settings → Runners: taking nothing until it is resumed.'
        : `  Settings → Runners: ${next} run${next === 1 ? '' : 's'} at once.`));
    }
    heard = true;
    slots = next;
  };
  await sayHello();

  if (opts.once) {
    if (slots === 0) return;
    const res = await reviewRunnerCycle(checkouts, d);
    if (res === 'idle') d.log(chalk.gray('  Nothing queued.'));
    if (res === 'poll-failed') d.exit(1);
    return;
  }

  // Worker 0 is the runner as it always was (orchestrator launches, local
  // checks, reviews); the others only take reviewer runs. A worker that sees
  // an upgrade or too many failed polls stops the rest from claiming more,
  // and the process exits once every worker's run has finished.
  // With a hello the pool is MAX_PARALLEL loops, each taking work only while
  // its index is under the dashboard's slots (the server enforces them too);
  // a loop gets its worker only once it is first needed.
  const pool = d.worker ? (d.hello ? MAX_PARALLEL : flagSlots) : 1;
  if (!d.hello && pool > 1) d.log(chalk.gray(`  ${pool} reviewer runs at once\n`));
  let stop: number | null = null;
  const loop = async (index: number, make: () => ReviewRunnerDeps): Promise<void> => {
    let consecutivePollFailures = 0;
    let wd: ReviewRunnerDeps | null = null;
    while (stop === null) {
      if (index === 0 && Date.now() - helloAt >= RUNNER_HELLO_MS) await sayHello();
      if (index >= slots) {
        // Paused, or more loops than slots. Loop 0 still notices an upgrade.
        if (index === 0 && shouldRestartForUpgrade(startupVersion, d.version())) {
          if (stop === null) stop = 0;
          return;
        }
        await d.sleep(intervalSec * 1000);
        continue;
      }
      wd ??= make();
      const res = await reviewRunnerCycle(checkouts, wd);
      if (res === 'poll-failed') {
        consecutivePollFailures++;
        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          if (stop === null) {
            d.log(chalk.red(`  ${consecutivePollFailures} consecutive poll failures — restarting for a fresh connection.`));
            stop = 1;
          }
          return;
        }
      } else {
        consecutivePollFailures = 0;
      }
      // A run has fully finished before cycle() returns, so stopping here
      // never interrupts one. Only when the on-disk version is strictly newer
      // than the one this process started with — an `origin upgrade` happened.
      const onDisk = d.version();
      if (shouldRestartForUpgrade(startupVersion, onDisk)) {
        if (stop === null) {
          d.log(chalk.cyan(`  CLI upgraded ${startupVersion} → ${onDisk} — restarting onto the new binary.`));
          stop = 0;
        }
        return;
      }
      if (res !== 'ran') await d.sleep(intervalSec * 1000);
    }
  };
  const makeExtra = (): ReviewRunnerDeps => {
    const { claimOrchestrator, launchOrchestrator, reportOrchestrator, claimLocal, runLocal, ...rest } = d;
    return { ...rest, ...d.worker!() } as ReviewRunnerDeps;
  };
  await Promise.all([loop(0, () => d), ...Array.from({ length: pool - 1 }, (_, i) => loop(i + 1, makeExtra))]);
  d.exit(stop ?? 0);
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
    deps.log(chalk.red(`Unknown action "${sub}". Use setup, install, uninstall or status, or no action to run the daemon here.`));
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

export async function reviewRunnerAction(action: string | undefined, opts: ReviewRunnerOptions & { clone?: string[]; dir?: string } = {}): Promise<void> {
  if (action === 'setup') {
    const { runnerSetupCommand } = await import('./review-runner-setup.js');
    await runnerSetupCommand(opts);
  } else if (action) await reviewRunnerServiceAction(action, opts);
  else await reviewRunnerCommand(opts);
}
