// Code-survival computation for agent benchmarking (spec P2). Runs in the CLI
// because it needs the working repo — the API server keeps no clone.
//
// For a session that authored some lines (via its own commits), survival = the
// fraction of those lines still present, UNMODIFIED, at current HEAD. We get it
// from `git blame`: a line still attributed to one of the session's commits is
// surviving; a line since edited is blamed to the newer commit (reworked), and
// a deleted line isn't blamed at all. This is exactly first-author-wins.
//
// Squash-merge / rebase rewrites the session's shas, so they vanish from
// history and blame would report 0 — which is misleading. We detect that
// (none of the session's shas are ancestors of HEAD) and mark the result
// `resolvable: false` so the server records survival as UNKNOWN, never 0.

import { runDetailed } from './utils/exec.js';

const FULL_SHA = /^([0-9a-f]{40}) \d+ \d+/;

export interface SurvivalResult {
  linesSurviving: number;
  resolvable: boolean;
  filesBlamed: number;
}

function gitOut(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
  const r = runDetailed('git', args, { cwd: repoPath, timeoutMs: 15_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || '' };
}

/** True when at least one of `shas` is reachable from HEAD (i.e. the session's
 *  work wasn't squashed/rebased away). */
export function anyShaReachable(repoPath: string, shas: string[]): boolean {
  for (const sha of shas) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    const r = runDetailed('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: repoPath, timeoutMs: 5_000 });
    if (r.status === 0) return true;
  }
  return false;
}

/**
 * Count lines at HEAD in `files` that are still blamed to one of `ownedShas`.
 * Uses --line-porcelain, which emits a `<40-hex sha> <orig> <final> …` header
 * for EVERY line, so we count headers whose sha is owned.
 */
export function computeSessionSurvival(
  repoPath: string,
  ownedShas: string[],
  files: string[],
): SurvivalResult {
  const owned = new Set(ownedShas.filter((s) => /^[0-9a-f]{40}$/i.test(s)).map((s) => s.toLowerCase()));
  if (owned.size === 0) return { linesSurviving: 0, resolvable: false, filesBlamed: 0 };

  if (!anyShaReachable(repoPath, [...owned])) {
    return { linesSurviving: 0, resolvable: false, filesBlamed: 0 };
  }

  let surviving = 0;
  let filesBlamed = 0;
  for (const file of files) {
    if (!file) continue;
    const { ok, stdout } = gitOut(repoPath, ['blame', '--line-porcelain', 'HEAD', '--', file]);
    if (!ok || !stdout) continue; // file deleted/renamed at HEAD, or binary — skip
    filesBlamed++;
    for (const line of stdout.split('\n')) {
      const m = FULL_SHA.exec(line);
      if (m && owned.has(m[1].toLowerCase())) surviving++;
    }
  }
  return { linesSurviving: surviving, resolvable: true, filesBlamed };
}
