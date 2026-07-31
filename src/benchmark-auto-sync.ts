// Opportunistic, rate-limited trigger for code-survival measurement. Called
// from the post-commit hook so survival on the /benchmarks scorecard + bake-off
// columns stays fresh WITHOUT anyone remembering to run `origin benchmark sync`.
//
// Design: at most once per day per repo (a per-repo marker file), and the sync
// runs as a DETACHED background process so it never adds latency to the commit.
// Never throws — a hook must not fail over benchmarking.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { loadConfig } from './config.js';

const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // once/day/repo

function markerPath(repoPath: string): string {
  const hash = crypto.createHash('sha1').update(repoPath).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.origin', 'benchmark-sync', `${hash}.stamp`);
}

/** True if we should skip (ran within the last day). Stamps the marker when it
 *  decides to run, so concurrent hooks don't all spawn a sync. */
function throttled(repoPath: string): boolean {
  const mp = markerPath(repoPath);
  try {
    const st = fs.statSync(mp);
    if (Date.now() - st.mtimeMs < MIN_INTERVAL_MS) return true;
  } catch { /* no marker yet — first run */ }
  try {
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    fs.writeFileSync(mp, new Date().toISOString());
  } catch { /* best-effort */ }
  return false;
}

export function maybeAutoSyncBenchmark(repoPath: string): void {
  try {
    if (!repoPath) return;
    // Only when logged in — `benchmark sync` needs the API; skip the spawn
    // entirely in standalone/not-logged-in setups.
    let hasConfig = false;
    try { hasConfig = !!loadConfig()?.apiKey; } catch { hasConfig = false; }
    if (!hasConfig) return;
    if (throttled(repoPath)) return;

    const entry = process.argv[1];
    if (!entry) return;
    const child = spawn(process.execPath, [entry, 'benchmark', 'sync'], {
      cwd: repoPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch { /* never break the hook */ }
}
