// Sends graded replay arms to Origin for the Benchmarks → Replays tab. Local
// results.jsonl stays the source of truth: an upload that fails never fails
// the run, and `origin benchmark replay-sync` sends it again later.
//
// Each upload names the repo the task came from, so the server files the arms
// under the org that owns that repo, as it does a session — not under the org
// the key was minted in (a personal key would otherwise hide team results).

import fs from 'fs';
import path from 'path';
import { api } from './api.js';
import { getCanonicalRepoPath } from './session-state.js';
import { listRecentShas } from './history-backfill.js';
import { gitDetailed } from './utils/exec.js';
import type { ArmResult } from './context-replay.js';

const BATCH = 200;
const RECENT_SHAS = 50;

/** Every run under `<root>/runs/<runId>/results.jsonl`, oldest first. Unreadable lines are skipped. */
export function readLocalReplayRuns(root: string): Array<{ runId: string; arms: ArmResult[] }> {
  const runsDir = path.join(root, 'runs');
  let names: string[];
  try { names = fs.readdirSync(runsDir).sort(); } catch { return []; }
  const out: Array<{ runId: string; arms: ArmResult[] }> = [];
  for (const runId of names) {
    let text: string;
    try { text = fs.readFileSync(path.join(runsDir, runId, 'results.jsonl'), 'utf-8'); } catch { continue; }
    const arms: ArmResult[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { arms.push(JSON.parse(line) as ArmResult); } catch { /* a torn last line */ }
    }
    if (arms.length) out.push({ runId, arms });
  }
  return out;
}

/** The wire shape: armName filled in for runs written before it was recorded; the local repo path stays local. */
export function armForUpload(a: ArmResult): Omit<ArmResult, 'sourceRepo'> & { armName: string } {
  const { sourceRepo: _repo, ...rest } = a;
  return { ...rest, armName: a.armName || `${a.taskId}-${a.variant}-${a.repeat}` };
}

/** Arms grouped by the repo they replayed; arms that did not record one go under `fallbackRepo`. */
export function groupByRepo(arms: ArmResult[], fallbackRepo?: string): Map<string | null, ArmResult[]> {
  const groups = new Map<string | null, ArmResult[]>();
  for (const a of arms) {
    const repo = a.sourceRepo || fallbackRepo || null;
    groups.set(repo, [...(groups.get(repo) || []), a]);
  }
  return groups;
}

/** What the server routes on: the same fields session/start sends. */
function repoTarget(repoPath: string): { repoPath: string; repoUrl?: string; recentShas?: string[] } | undefined {
  if (!fs.existsSync(repoPath)) return undefined;
  const remote = gitDetailed(['remote', 'get-url', 'origin'], { cwd: repoPath });
  const repoUrl = remote.status === 0 ? remote.stdout.trim() : '';
  const shas = listRecentShas(repoPath, RECENT_SHAS);
  return {
    repoPath: getCanonicalRepoPath(repoPath),
    repoUrl: repoUrl || undefined,
    recentShas: shas.length > 0 ? shas : undefined,
  };
}

export async function uploadReplayArms(arms: ArmResult[], fallbackRepo?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    for (const [repo, group] of groupByRepo(arms, fallbackRepo)) {
      const target = repo ? repoTarget(repo) : undefined;
      for (let i = 0; i < group.length; i += BATCH) {
        await api.uploadReplayArms(group.slice(i, i + BATCH).map(armForUpload), target);
      }
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
