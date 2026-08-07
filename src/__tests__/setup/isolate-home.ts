// Per-worker HOME isolation for the CLI test suite (vitest setupFile).
//
// Many modules write into the user's REAL ~/.origin: config.json / agent.json,
// heartbeat pid files, and — the one that bit us — the sessions/ GLOBAL MIRROR
// that saveSessionState maintains for `origin status --global` discovery. On a
// developer or CI machine that ALSO runs Origin, fixture sessions (sess-main-1,
// sess-wt-1, …) leaked into ~/.origin/sessions/ and then showed up as "active"
// sessions forever, because status --global scans that directory.
//
// Point HOME (and USERPROFILE on Windows) at a throwaway per-worker temp dir so
// every ~/.origin write lands in disposable scratch that global-teardown.ts
// removes after the run. Per WORKER (not per file) so it's stable across the
// files a worker runs — and so config.ts's module-top-level CONFIG_DIR, frozen
// at first import, is frozen to the isolated home.
//
// IMPORTANT: keep this file dependency-free (os/path/fs only). It runs before
// each test file's module graph imports, so it MUST NOT import anything that
// reads os.homedir() at load time (e.g. config.ts) — that would freeze the path
// to the real home before we can redirect it.
import os from 'os';
import path from 'path';
import fs from 'fs';

const worker = process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID || String(process.pid);
const home = path.join(os.tmpdir(), 'origin-cli-test-home', worker);
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
