// `origin benchmark sync` — computes code-survival for this repo's benchmarked
// sessions and reports it to the server. Survival needs the working repo (blame
// over time), which the API server doesn't have — so it's computed here. See
// docs/notes/AGENT_BENCHMARKING_SPEC.md P2.

import chalk from 'chalk';
import { runDetailed } from '../utils/exec.js';
import { api } from '../api.js';
import { anyShaReachable, computeSessionSurvival } from '../benchmark-survival.js';

/** owner/name from the origin remote (github.com/owner/name(.git), git@…:owner/name). */
export function deriveRepoFullName(remoteUrl: string): string | null {
  const u = remoteUrl.trim();
  const m =
    u.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

interface SurvivalTarget {
  sessionId: string;
  horizonDays: number;
  ageDays: number;
  commitShas: string[];
  landedShas?: string[]; // the PR's merge/squash commit(s) — see benchmark-survival.ts
  files: string[];
  linesAuthored: number;
}

export async function benchmarkSyncCommand(): Promise<void> {
  const rootRes = runDetailed('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), timeoutMs: 5_000 });
  if (rootRes.status !== 0 || !rootRes.stdout.trim()) {
    console.log(chalk.red('Not inside a git repository.'));
    return;
  }
  const repoPath = rootRes.stdout.trim();
  const remoteRes = runDetailed('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, timeoutMs: 5_000 });
  const fullName = remoteRes.status === 0 ? deriveRepoFullName(remoteRes.stdout) : null;
  if (!fullName) {
    console.log(chalk.red('Could not determine the repo (no `origin` remote with an owner/name URL).'));
    return;
  }

  // A shallow clone cuts history off: blame cannot reach any commit past the
  // cut, so every session reads as squashed away and is reported UNKNOWN —
  // 320 rows of it from one checkout on 2026-10-29. Measure nothing instead.
  const shallowRes = runDetailed('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoPath, timeoutMs: 5_000 });
  if (shallowRes.status === 0 && shallowRes.stdout.trim() === 'true') {
    console.log(chalk.yellow('This clone is shallow, so survival cannot be measured here. Run `git fetch --unshallow`, then sync again.'));
    return;
  }

  console.log(chalk.bold(`\nOrigin benchmark sync — ${fullName}\n`));
  let targetsRes: { repoId: string | null; targets: SurvivalTarget[] };
  try {
    targetsRes = await api.getSurvivalTargets(fullName, { repoPath, repoUrl: remoteRes.stdout.trim() }) as any;
  } catch (err: any) {
    console.log(chalk.red(`Failed to fetch targets: ${err?.message || err}`));
    return;
  }
  if (!targetsRes.repoId) {
    console.log(chalk.yellow('This repo isn’t registered with Origin, or has no sessions yet.'));
    return;
  }
  const targets = targetsRes.targets || [];
  if (targets.length === 0) {
    console.log(chalk.green('Nothing to measure — all recent sessions are up to date.\n'));
    return;
  }

  console.log(chalk.gray(`  Measuring survival for ${targets.length} session(s)…`));
  const results = [];
  let resolved = 0, unknown = 0, notHere = 0;
  for (const t of targets) {
    // A landing commit is on the base branch by definition. When this HEAD
    // cannot reach it, the checkout is behind or on another branch — not a
    // squash that lost the lines — so the session is left for a later sync
    // rather than stored UNKNOWN, which the server does not offer again.
    const landed = t.landedShas || [];
    if (landed.length > 0 && !anyShaReachable(repoPath, [...t.commitShas, ...landed])) { notHere++; continue; }
    const sv = computeSessionSurvival(repoPath, t.commitShas, t.files, landed);
    if (sv.resolvable) resolved++; else unknown++;
    // A landing commit carries every line of the PR, which can exceed what
    // THIS session authored when several sessions shared the PR; survival is
    // a share of the session's own lines, so it cannot exceed them.
    const linesSurviving = t.linesAuthored > 0 ? Math.min(sv.linesSurviving, t.linesAuthored) : sv.linesSurviving;
    results.push({
      sessionId: t.sessionId,
      horizonDays: t.horizonDays,
      ageDays: t.ageDays,
      linesAuthored: t.linesAuthored,
      linesSurviving,
      resolvable: sv.resolvable,
    });
  }

  if (notHere > 0) {
    console.log(chalk.yellow(`  ${notHere} session(s) skipped — their PRs landed on commits this checkout's HEAD does not contain. Pull the base branch and sync again.`));
  }
  if (results.length === 0) return;
  const body = { repoId: targetsRes.repoId, results, repoPath, repoUrl: remoteRes.stdout.trim() };
  try {
    let post: any;
    try {
      post = await api.postSurvival(body);
    } catch (err: any) {
      // Blaming a few hundred sessions takes minutes, and the keep-alive
      // socket the targets read opened is dead by then: the first send fails
      // with a bare "fetch failed" (opsworks-co/origin, 211 sessions, ~10 min,
      // three runs in a row). A second send gets a fresh connection. An HTTP
      // error is the server's answer, not a dead socket, so it is not retried.
      if (err?.message !== 'fetch failed') throw err;
      post = await api.postSurvival(body);
    }
    console.log(chalk.green(`\n  ✓ Reported ${post?.upserted ?? results.length} measurement(s) — ${resolved} resolved, ${unknown} unknown (squashed/rebased).\n`));
  } catch (err: any) {
    console.log(chalk.red(`\n  Failed to report survival: ${err?.message || err}\n`));
  }
}
