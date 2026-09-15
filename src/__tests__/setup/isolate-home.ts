// Per-run, per-worker HOME isolation for the CLI test suite (vitest setupFile).
//
// Many modules write into the user's REAL ~/.origin: config.json / agent.json,
// heartbeat pid files, and — the one that bit us — the sessions/ GLOBAL MIRROR
// that saveSessionState maintains for `origin status --global` discovery. On a
// developer or CI machine that ALSO runs Origin, fixture sessions (sess-main-1,
// sess-wt-1, …) leaked into ~/.origin/sessions/ and then showed up as "active"
// sessions forever, because status --global scans that directory.
//
// Point HOME (and USERPROFILE on Windows) at a throwaway temp dir so every
// ~/.origin write lands in disposable scratch that global-teardown.ts removes
// after the run. Per WORKER (not per file) so it's stable across the files a
// worker runs — and so config.ts's module-top-level CONFIG_DIR, frozen at first
// import, is frozen to the isolated home. Per RUN as well, because worker ids
// restart at 1 in every vitest run: two suites running at once on one machine
// must not share a home (see test-home.ts).
//
// IMPORTANT: keep this file dependency-free (os/path/fs and ./test-home only).
// It runs before each test file's module graph imports, so it MUST NOT import
// anything that reads os.homedir() at load time (e.g. config.ts) — that would
// freeze the path to the real home before we can redirect it.
import path from 'path';
import fs from 'fs';
import { RUN_ID_ENV, workerHome } from './test-home.js';

const worker = process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID || String(process.pid);
// vitest.config.ts always sets the run id; the fallback only covers running
// this setupFile under some other config, and is still unique per process.
const runId = process.env[RUN_ID_ENV] || `nocfg-${process.pid}`;
const home = workerHome(runId, worker);
try {
  fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
} catch {
  /* best effort — a failure here just means writes fall back to the real home,
     which the pre-existing git isolation already tolerated */
}
process.env.HOME = home;
process.env.USERPROFILE = home;
// Some code checks XDG_* / ORIGIN_HOME styles; HOME is the one os.homedir()
// honors on POSIX and USERPROFILE on Windows, which is all the ~/.origin paths
// resolve through.
