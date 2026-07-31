// `origin benchmark sync` — computes code-survival for this repo's benchmarked
// sessions and reports it to the server. Survival needs the working repo (blame
// over time), which the API server doesn't have — so it's computed here. See
// docs/notes/AGENT_BENCHMARKING_SPEC.md P2.

import chalk from 'chalk';
import { runDetailed } from '../utils/exec.js';
import { api } from '../api.js';
import { computeSessionSurvival } from '../benchmark-survival.js';

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

  console.log(chalk.bold(`\nOrigin benchmark sync — ${fullName}\n`));
  let targetsRes: { repoId: string | null; targets: SurvivalTarget[] };
  try {
    targetsRes = await api.getSurvivalTargets(fullName) as any;
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
  let resolved = 0, unknown = 0;
  for (const t of targets) {
    const sv = computeSessionSurvival(repoPath, t.commitShas, t.files);
    if (sv.resolvable) resolved++; else unknown++;
    results.push({
      sessionId: t.sessionId,
      horizonDays: t.horizonDays,
      ageDays: t.ageDays,
      linesAuthored: t.linesAuthored,
      linesSurviving: sv.linesSurviving,
      resolvable: sv.resolvable,
    });
  }

  try {
    const post = await api.postSurvival({ repoId: targetsRes.repoId, results }) as any;
    console.log(chalk.green(`\n  ✓ Reported ${post?.upserted ?? results.length} measurement(s) — ${resolved} resolved, ${unknown} unknown (squashed/rebased).\n`));
  } catch (err: any) {
    console.log(chalk.red(`\n  Failed to report survival: ${err?.message || err}\n`));
  }
}
