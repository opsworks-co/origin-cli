// `origin benchmark bakeoff create` — sets up a head-to-head: records the
// bake-off server-side (one arm per agent, each on branch
// bakeoff/<shortId>/<agent>) and creates an isolated git worktree per agent so
// each runs the SAME prompt without stepping on the others. Origin correlates
// each arm's session to its branch; compare + pick a winner in the web UI.
// See docs/notes/AGENT_BENCHMARKING_SPEC.md P3.

import chalk from 'chalk';
import fs from 'fs';
import { runDetailed } from '../utils/exec.js';
import { api } from '../api.js';
import { runBakeOffArms, AGENT_RUNNERS } from './benchmark-bakeoff-run.js';
import { resolveAgentKeys } from '../agent-keys.js';

/** owner/name from an origin remote (https://…/owner/name(.git), git@…:owner/name). */
export function deriveRepoFullName(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

interface BakeOffCreateResult {
  id: string;
  shortId: string;
  repoFullName: string | null;
  prompt: string;
  arms: Array<{ id: string; agentSlug: string; branch: string }>;
}

export async function benchmarkBakeoffCreateCommand(opts: { prompt?: string; agents?: string; id?: string; title?: string; run?: boolean }): Promise<void> {
  const runId = (opts.id || '').trim();
  const prompt = (opts.prompt || '').trim();
  const agents = (opts.agents || '').split(',').map((a) => a.trim()).filter(Boolean);
  // --id and --prompt/--agents are mutually exclusive entry points: --id RUNS a
  // bake-off already recorded from the web UI; --prompt/--agents CREATE a new one.
  if (!runId) {
    if (!prompt) { console.log(chalk.red('--prompt is required (or pass --id to run a bake-off created in the web UI).')); return; }
    if (agents.length < 2) { console.log(chalk.red('--agents needs at least 2 comma-separated slugs (e.g. claude-code,codex).')); return; }
  }

  const rootRes = runDetailed('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), timeoutMs: 5_000 });
  if (rootRes.status !== 0 || !rootRes.stdout.trim()) { console.log(chalk.red('Not inside a git repository.')); return; }
  const repoPath = rootRes.stdout.trim();
  const remoteRes = runDetailed('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, timeoutMs: 5_000 });
  const fullName = remoteRes.status === 0 ? deriveRepoFullName(remoteRes.stdout) : null;
  if (!fullName) { console.log(chalk.red('Could not determine the repo (no `origin` remote with an owner/name URL).')); return; }

  let created: BakeOffCreateResult;
  if (runId) {
    // Run an EXISTING bake-off: fetch its prompt + arms, don't create a new row.
    try {
      const fetched = await api.getBakeOff(runId) as BakeOffCreateResult & { prompt: string };
      created = fetched;
    } catch (err: any) {
      console.log(chalk.red(`Failed to load bake-off ${runId}: ${err?.serverError || err?.message || err}`));
      return;
    }
    if (!created?.arms?.length) { console.log(chalk.red(`Bake-off ${runId} has no arms.`)); return; }
  } else {
    try {
      created = await api.createBakeOff({ repoFullName: fullName, prompt, title: opts.title, agents }) as BakeOffCreateResult;
    } catch (err: any) {
      console.log(chalk.red(`Failed to create bake-off: ${err?.serverError || err?.message || err}`));
      return;
    }
  }
  // The prompt to run is the bake-off's own (authoritative when running by --id).
  const effectivePrompt = (created.prompt || prompt).trim();

  console.log(chalk.bold(`\nBake-off ${created.shortId} — ${fullName}\n`));
  const base = repoPath.split('/').pop() || 'repo';
  const parentDir = repoPath.slice(0, Math.max(0, repoPath.length - base.length - 1));
  const promptFile = 'BAKEOFF_PROMPT.md';
  const ready: Array<{ agentSlug: string; worktree: string }> = [];
  for (const arm of created.arms) {
    const wt = `${parentDir}/${base}-bakeoff-${created.shortId}-${arm.agentSlug}`;
    const add = runDetailed('git', ['worktree', 'add', '-b', arm.branch, wt, 'HEAD'], { cwd: repoPath, timeoutMs: 20_000 });
    if (add.status === 0) {
      try { fs.writeFileSync(`${wt}/${promptFile}`, `# Bake-off prompt\n\n${effectivePrompt}\n`); } catch { /* ignore */ }
      ready.push({ agentSlug: arm.agentSlug, worktree: wt });
      console.log(chalk.green(`  ✓ ${arm.agentSlug}`) + chalk.gray(`  ${wt}  (branch ${arm.branch})`));
    } else {
      console.log(chalk.yellow(`  ⚠ ${arm.agentSlug}: worktree add failed — ${(add.stderr || '').trim().split('\n')[0] || 'unknown'}`));
    }
  }

  if (opts.run) {
    await runArmsAutomatically(ready, effectivePrompt);
  } else {
    console.log(chalk.gray(`\n  Next: run each agent in its worktree with the same prompt (saved to ${promptFile}),`));
    console.log(chalk.gray(`  or re-run with ${chalk.white('--run')} to have Origin drive every agent for you.`));
  }
  console.log(chalk.gray('\n  Origin correlates each arm\'s session by its branch. Compare + pick a winner at:'));
  console.log(chalk.cyan('    https://getorigin.io/benchmarks/bakeoffs\n'));
}

/** --run: drive each agent headless in its worktree, then report per-arm. */
async function runArmsAutomatically(ready: Array<{ agentSlug: string; worktree: string }>, prompt: string): Promise<void> {
  const runnable = ready.filter((a) => AGENT_RUNNERS[a.agentSlug]);
  const noRunner = ready.filter((a) => !AGENT_RUNNERS[a.agentSlug]);
  for (const a of noRunner) {
    console.log(chalk.yellow(`  ⚠ ${a.agentSlug}: no headless runner — run it by hand in ${a.worktree}`));
  }
  if (runnable.length === 0) {
    console.log(chalk.yellow('\n  No agents can run headless. Set them off manually in their worktrees.'));
    return;
  }

  console.log(chalk.bold(`\n  Running ${runnable.length} agent(s) autonomously — each edits + commits inside its own worktree only.`));
  // Inject stored/local agent keys so headless agents authenticate without the
  // interactive login (same resolution the runner daemon uses).
  const keys = await resolveAgentKeys();
  const results = runBakeOffArms(runnable, prompt, { keys });

  console.log(chalk.bold('\n  Results:'));
  for (const r of results) {
    const secs = (r.durationMs / 1000).toFixed(0);
    if (r.outcome === 'ran') {
      const c = r.committed ? '' : chalk.gray(' (no changes)');
      console.log(chalk.green(`  ✓ ${r.agentSlug}`) + chalk.gray(`  ${secs}s`) + c);
    } else if (r.outcome === 'skipped') {
      console.log(chalk.yellow(`  ⚠ ${r.agentSlug}: skipped — ${r.reason}`));
    } else {
      const c = r.committed ? chalk.gray(' (committed partial work)') : '';
      console.log(chalk.red(`  ✗ ${r.agentSlug}: ${r.reason}`) + chalk.gray(`  ${secs}s`) + c);
    }
  }
}
