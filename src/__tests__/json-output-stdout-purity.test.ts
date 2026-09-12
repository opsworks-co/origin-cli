// `--json` stdout is a PROTOCOL, not a console.
//
// The postAction version check has now corrupted a machine reader twice, with
// the same two lines of output both times:
//
//   1. agy's PreToolUse hook reply (fixed by exempting `origin hooks …`, and
//      guarded by agy-hook-stdout-purity.test.ts).
//   2. `origin verify-capture --json`. The release-gate test
//      (release-gate-windows-on-turns.test.ts) failed on the native-Windows job
//      with "Unexpected non-whitespace character after JSON at position 1508"
//      — the banner, appended after the JSON.
//
// The second one bit an API-only PR that touched no CLI code, because whether
// the banner appears depends on what getorigin.io is advertising at that
// instant: a branch cut before a release carries the previous version, so for
// the minutes between the tag and the next bump EVERY build on EVERY branch
// has an update available. The Windows job reaches the CLI suite ~13 minutes
// in and lost that race far more often than the faster Ubuntu leg, which is
// what made it look like a Windows defect.
//
// Two rules, both asserted here:
//   - A human notice goes to stderr. Then no stdout reader can be corrupted,
//     including one nobody has thought of yet.
//   - An invocation that says it is machine-read (`--json`, `--waiver`) skips
//     the check entirely — it also costs a network round-trip, and an output
//     that varies with what a remote server currently advertises is not
//     something a test or a release script can depend on.
//
// The third case is the control: silence everywhere would satisfy the first two
// assertions just as well as deleting the feature would.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../../dist/index.js');

let home: string;
let repo: string;

interface Run { out: string; err: string; code: number }

function run(args: string[]): Run {
  if (!fs.existsSync(CLI)) {
    throw new Error(`CLI not built: ${CLI} does not exist. Run \`pnpm run build\` in packages/cli.`);
  }
  // spawnSync, not execFileSync: these assertions are about WHICH stream each
  // line went to, and execFileSync returns stdout only — it gives no way to
  // read stderr on a successful exit, which is exactly the case under test.
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo, encoding: 'utf-8',
    // os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows. Set
    // both, or the seeded cache below is never read on the Windows runner and
    // the test passes without exercising anything.
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  if (r.error) throw r.error;
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
}

describe('a machine-readable invocation keeps its stdout clean while an update is available', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-purity-home-'));
    fs.mkdirSync(path.join(home, '.origin', 'sessions'), { recursive: true });
    // Drive the REAL code path with no network and no test-only switch:
    // checkForUpdate returns from this cache, and the version is high enough
    // that no release can ever overtake it.
    fs.writeFileSync(
      path.join(home, '.origin', 'last-update-check.json'),
      JSON.stringify({ latest: '99.99999999.9999', checkedAt: new Date().toISOString() }),
    );
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-purity-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });
  afterEach(() => {
    for (const d of [home, repo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('verify-capture --json writes JSON and nothing else', () => {
    const r = run(['verify-capture', '--since', '1d', '--json']);
    expect(r.code, `stderr: ${r.err}`).toBe(0);
    expect(r.out).not.toContain('Update available');
    expect(r.err).not.toContain('Update available');
    // The assertion that matters is the one the release gate makes: the bytes
    // parse. `not.toContain` alone would miss any other appended line.
    expect(() => JSON.parse(r.out)).not.toThrow();
  });

  it('verify-capture --waiver writes nothing a tag message should not carry', () => {
    // release-cli.sh captures this with `$(…)` and puts it in the annotated
    // tag's message. A banner there is permanent.
    const r = run(['verify-capture', '--since', '1d', '--waiver']);
    expect(r.code, `stderr: ${r.err}`).toBe(0);
    expect(r.out).not.toContain('Update available');
    expect(r.out).not.toContain('origin upgrade');
  });

  it('but a human still gets told, on stderr', () => {
    // `config list` is the cheapest human-facing command that needs no network
    // and no login. Without this the two assertions above would also pass if
    // the version check were simply deleted.
    const r = run(['config', 'list']);
    expect(r.code, `stderr: ${r.err}`).toBe(0);
    expect(r.err).toContain('Update available');
    expect(r.out).not.toContain('Update available');
  });
});
