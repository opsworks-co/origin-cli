import { execFile } from 'child_process';

/**
 * Run a git command that fires Origin's hooks WITHOUT blocking this process.
 *
 * A capture-e2e fake API runs in the vitest worker's own event loop. A hooked
 * `git commit` run with execFileSync froze that loop for as long as git ran,
 * and git waits for post-commit, which waits for the fake API: every request
 * the hook made sat unanswered until the CLI aborted it (30 s for the commit
 * ingest, 8 s for each session PATCH) and queued the payload for a later hook
 * to replay. Each hooked commit cost 30-60 s, and the rows reached the fake API
 * late and out of order, which is not how the real API sees them.
 *
 * Use this for every git command that runs a hook while a fake API is up:
 * commit, rebase, cherry-pick, merge, checkout/switch, am, pull. Plain reads
 * can stay synchronous.
 */
export function gitAsync(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; allowFail?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf-8',
      env: opts.env ?? process.env,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout) => {
      if (err && !opts.allowFail) {
        reject(err);
        return;
      }
      resolve(err ? '' : String(stdout).trim());
    });
  });
}
