// `origin benchmark runner` — the local execution daemon for bake-offs.
//
// The server owns the QUEUE (a bake-off is queued from the UI "Run now" or by a
// due schedule); this daemon owns EXECUTION. It polls for the next queued
// bake-off in the repo it's launched from, atomically claims it (so two daemons
// never grab the same one), sets up a git worktree per arm, drives each agent
// headless via the existing runBakeOffArms, and reports the outcome back
// (running → done | error). Agents run HERE, on the user's machine, with their
// own keys — the server never executes them.
//
// Run it once (--once, drains one job then exits — used by cron/CI) or leave it
// polling (default). One daemon covers one repo; run several for several repos.
import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import { runDetailed } from '../utils/exec.js';
import { api } from '../api.js';
import { deriveRepoFullName } from './benchmark-bakeoff.js';
import { runBakeOffArms, AGENT_RUNNERS } from './benchmark-bakeoff-run.js';
import { resolveAgentKeys, readLocalAgentKeys, setLocalAgentKey, clearLocalAgentKey, isAgentKeyProvider, type AgentKeys } from '../agent-keys.js';

interface ClaimedBakeOff {
  id: string;
  shortId: string;
  prompt: string;
  title: string | null;
  arms: Array<{ id: string; agentSlug: string; branch: string }>;
}

// Set up worktrees for a claimed bake-off's arms and drive the headless agents.
// Returns { ok, error } for the report call. Exported for testing with a
// caller-supplied runner. Reuses the SAME worktree layout as
// `origin benchmark bakeoff` so a half-run bake-off can be resumed by hand.
export function executeClaimedBakeOff(
  claimed: ClaimedBakeOff,
  repoPath: string,
  keys: AgentKeys = {},
  runArms: typeof runBakeOffArms = runBakeOffArms,
): { ok: boolean; error?: string } {
  const base = repoPath.split('/').pop() || 'repo';
  const parentDir = repoPath.slice(0, Math.max(0, repoPath.length - base.length - 1));
  const ready: Array<{ agentSlug: string; worktree: string }> = [];
  for (const arm of claimed.arms) {
    const wt = `${parentDir}/${base}-bakeoff-${claimed.shortId}-${arm.agentSlug}`;
    if (!fs.existsSync(wt)) {
      const add = runDetailed('git', ['worktree', 'add', '-b', arm.branch, wt, 'HEAD'], { cwd: repoPath, timeoutMs: 20_000 });
      if (add.status !== 0) {
        console.log(chalk.yellow(`  ⚠ ${arm.agentSlug}: worktree add failed — ${(add.stderr || '').trim().split('\n')[0] || 'unknown'}`));
        continue;
      }
    }
    try { fs.writeFileSync(`${wt}/BAKEOFF_PROMPT.md`, `# Bake-off prompt\n\n${claimed.prompt}\n`); } catch { /* ignore */ }
    ready.push({ agentSlug: arm.agentSlug, worktree: wt });
  }

  const runnable = ready.filter((a) => AGENT_RUNNERS[a.agentSlug]);
  if (runnable.length === 0) {
    return { ok: false, error: 'no headless-capable agents (need claude-code / codex / cursor installed)' };
  }
  const results = runArms(runnable, claimed.prompt, { keys });
  const anyRan = results.some((r) => r.outcome === 'ran');
  return anyRan ? { ok: true } : { ok: false, error: 'every arm errored or was skipped' };
}

// After this many CONSECUTIVE poll failures the daemon exits so its service
// manager (launchd/systemd, both configured with restart-on-exit) respawns a
// fresh process. A long-lived process can end up with a wedged HTTP connection
// pool — e.g. after the server redeploys and severs its in-flight keep-alive
// sockets — where every reused socket hangs until the client timeout, so the
// daemon silently stops claiming work forever. A fresh process gets a clean
// pool and recovers; retrying on the same wedged process never does.
export const MAX_CONSECUTIVE_POLL_FAILURES = 5;

export type PollOutcome =
  | { status: 'claimed'; bakeOff: ClaimedBakeOff }
  | { status: 'idle' }
  | { status: 'poll-failed'; error: string };

/** Poll the claim endpoint once, tolerating a single transient blip (one retry)
 *  so a one-off timeout doesn't skip a whole interval. Exported for testing. */
export async function pollForBakeOff(
  claim: () => Promise<{ bakeOff: ClaimedBakeOff | null }>,
): Promise<PollOutcome> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await claim();
      const bakeOff = res?.bakeOff ?? null;
      return bakeOff ? { status: 'claimed', bakeOff } : { status: 'idle' };
    } catch (err: any) {
      lastErr = err;
    }
  }
  return { status: 'poll-failed', error: lastErr?.serverError || lastErr?.message || String(lastErr) };
}

export async function benchmarkRunnerCommand(opts: { once?: boolean; interval?: string }): Promise<void> {
  const rootRes = runDetailed('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), timeoutMs: 5_000 });
  if (rootRes.status !== 0 || !rootRes.stdout.trim()) { console.log(chalk.red('Not inside a git repository.')); return; }
  const repoPath = rootRes.stdout.trim();
  const remoteRes = runDetailed('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, timeoutMs: 5_000 });
  const fullName = remoteRes.status === 0 ? deriveRepoFullName(remoteRes.stdout) : null;
  if (!fullName) { console.log(chalk.red('Could not determine the repo (no `origin` remote with an owner/name URL).')); return; }

  const intervalSec = Math.max(5, Number(opts.interval) || 15);
  const machineId = os.hostname();
  console.log(chalk.bold(`\nBake-off runner — ${fullName}`));
  console.log(chalk.gray(opts.once ? '  single pass (--once)\n' : `  polling every ${intervalSec}s — Ctrl-C to stop\n`));

  // One poll+run cycle. Returns 'ran' when it executed a bake-off (so the loop
  // can immediately poll again for a backlog), 'idle' when nothing is queued,
  // or 'poll-failed' when the claim request itself failed.
  const cycle = async (): Promise<'ran' | 'idle' | 'poll-failed'> => {
    const poll = await pollForBakeOff(() =>
      api.claimBakeOff({ repoFullName: fullName, machineId }) as Promise<{ bakeOff: ClaimedBakeOff | null }>);
    if (poll.status === 'poll-failed') {
      console.log(chalk.yellow(`  poll failed: ${poll.error}`));
      return 'poll-failed';
    }
    if (poll.status === 'idle') return 'idle';

    const claimed = poll.bakeOff;
    console.log(chalk.bold(`  ▶ Bake-off ${claimed.shortId} — running ${claimed.arms.length} agent(s) autonomously`));
    // Resolve agent keys (local file / server) to inject where the shell doesn't
    // already carry them — so headless claude/codex auth without a login prompt.
    const keys = await resolveAgentKeys();
    let outcome: { ok: boolean; error?: string };
    try {
      outcome = executeClaimedBakeOff(claimed, repoPath, keys);
    } catch (err: any) {
      outcome = { ok: false, error: String(err?.message || err) };
    }
    try { await api.reportBakeOffRun(claimed.id, { ok: outcome.ok, error: outcome.error }); } catch { /* best-effort */ }
    console.log(outcome.ok
      ? chalk.green(`  ✓ ${claimed.shortId} done — see results at https://getorigin.io/benchmarks/bakeoffs`)
      : chalk.red(`  ✗ ${claimed.shortId}: ${outcome.error}`));
    return 'ran';
  };

  if (opts.once) {
    const res = await cycle();
    if (res === 'idle') console.log(chalk.gray('  Nothing queued.'));
    if (res === 'poll-failed') process.exitCode = 1; // signal failure to cron/CI
    return;
  }
  // Continuous poll loop. Runs the backlog eagerly; sleeps only when idle.
  // Self-heals a wedged connection pool: after MAX_CONSECUTIVE_POLL_FAILURES in
  // a row, exit so the service manager restarts us with a fresh pool.
  let consecutivePollFailures = 0;
  for (;;) {
    const res = await cycle();
    if (res === 'poll-failed') {
      consecutivePollFailures++;
      if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        console.log(chalk.red(
          `  ${consecutivePollFailures} consecutive poll failures — restarting for a fresh connection.`));
        process.exit(1); // launchd/systemd (restart-on-exit) respawns a clean process
      }
    } else {
      consecutivePollFailures = 0;
    }
    if (res !== 'ran') await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

// `origin benchmark key <provider> [key]` — manage the LOCAL agent key that
// overrides the server-stored one. No key arg → show status. --clear removes it.
export async function benchmarkKeyCommand(
  provider: string,
  key: string | undefined,
  opts: { clear?: boolean },
): Promise<void> {
  if (!isAgentKeyProvider(provider)) {
    console.log(chalk.red('provider must be "anthropic" (claude-code) or "openai" (codex).'));
    return;
  }
  if (opts.clear) {
    clearLocalAgentKey(provider);
    console.log(chalk.green(`Cleared local ${provider} key. The runner will fall back to your env var or Origin's stored key.`));
    return;
  }
  if (!key) {
    const local = readLocalAgentKeys();
    const v = local[provider];
    console.log(v
      ? chalk.green(`${provider}: set locally (••••${v.slice(-4)}) — overrides the server key`)
      : chalk.gray(`${provider}: no local key. The runner uses your ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} env var, else Origin's stored key.`));
    return;
  }
  setLocalAgentKey(provider, key);
  console.log(chalk.green(`Saved ${provider} key locally (~/.origin/agent-keys.json, 0600). It overrides the server-stored key and is never uploaded.`));
}
