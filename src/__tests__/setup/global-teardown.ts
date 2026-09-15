// Vitest globalSetup: remove the throwaway HOMEs that isolate-home.ts creates
// under <tmp>/origin-cli-test-runs/<runId>/. Only ever THIS run's directory —
// another suite may be running from another worktree at the same moment, and
// its homes live next to ours. Residue from crashed runs (owning vitest pid no
// longer alive) is swept up front.
import fs from 'fs';
import { RUN_ID_ENV, runHomeRoot, sweepDeadRuns } from './test-home.js';

export default function () {
  sweepDeadRuns();
  const runId = process.env[RUN_ID_ENV];
  if (!runId) return;
  const root = runHomeRoot(runId);
  return () => {
    // ORIGIN_KEEP_TEST_HOMES=1 leaves them behind to read each worker's hooks.log.
    if (process.env.ORIGIN_KEEP_TEST_HOMES === '1') return;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  };
}
