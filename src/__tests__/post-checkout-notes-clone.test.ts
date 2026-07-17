// A fresh `git clone` must land with attribution notes already present.
//
// `git clone` fetches refs/heads/* and refs/tags/* and NOTHING else, so
// refs/notes/origin never comes down with it — a new teammate, or an agent
// cloning the repo, sees no attribution at all. Git can't be told otherwise;
// there's no server-side setting for it.
//
// But git DOES run post-checkout after a clone, and Origin's hooks are global
// (core.hooksPath), so they fire in every repo on the machine — including one
// that was created a millisecond ago by `git clone`. That's the hook in here.
//
// The trap this pins: git passes flag=1 for ORDINARY BRANCH SWITCHES too, not
// just clones. The clone signature is the null-ref previous HEAD. Keying on the
// flag alone would fire a network fetch on every `git checkout`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeGlobalPostCheckoutHook } from '../commands/enable.js';

// Which of the two jobs runs is decided purely by the previous HEAD. Getting
// this wrong in the "fires on everything" direction means a network fetch on
// every `git checkout`; getting it wrong the other way means fresh clones never
// get their attribution. Both are silent, so pin the routing directly.
describe('handleGitPostCheckout routing: clone vs ordinary checkout', () => {
  const NULL_REF = '0'.repeat(40);
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  async function run(prev: string, next: string, flag: string) {
    vi.resetModules();
    const syncNotes = vi.fn().mockReturnValue(true);
    const preserve = vi.fn();
    vi.doMock('../git-notes.js', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('../git-notes.js')),
      syncNotesFromRemoteThrottled: syncNotes,
    }));
    vi.doMock('../history-preservation.js', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('../history-preservation.js')),
      handlePostCheckout: preserve,
    }));
    vi.doMock('../session-state.js', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('../session-state.js')),
      getGitRoot: () => '/tmp/some-repo',
    }));
    const { handleGitPostCheckout } = await import('../commands/hooks.js');
    await handleGitPostCheckout(prev, next, flag);
    return { syncNotes, preserve };
  }

  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('clone (null-ref previous HEAD) → fetches notes, no stash work', async () => {
    const { syncNotes, preserve } = await run(NULL_REF, SHA_B, '1');
    expect(syncNotes).toHaveBeenCalledTimes(1);
    expect(preserve).not.toHaveBeenCalled();
  });

  it('ordinary branch switch → stash preservation, and NO notes fetch', async () => {
    // The whole point: flag is 1 here too. Only the previous HEAD differs.
    const { syncNotes, preserve } = await run(SHA_A, SHA_B, '1');
    expect(syncNotes).not.toHaveBeenCalled();
    expect(preserve).toHaveBeenCalledTimes(1);
  });

  it('file checkout (flag=0) → neither', async () => {
    const { syncNotes, preserve } = await run(SHA_A, SHA_B, '0');
    expect(syncNotes).not.toHaveBeenCalled();
    expect(preserve).not.toHaveBeenCalled();
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: gitEnv }).trim();
}
let gitEnv: NodeJS.ProcessEnv;

describe('post-checkout hook fetches notes on a fresh clone', () => {
  let root: string;
  let hooksDir: string;
  let bare: string;
  let author: string;
  let traceLog: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-pc-'));
    hooksDir = path.join(root, 'git-hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    traceLog = path.join(root, 'invoked.log');

    // Isolate git from the real machine's config, then point it at the hooks
    // dir the way `origin enable --global` does.
    //
    // init.defaultBranch matters more than it looks: isolating the config throws
    // away whatever the host set, and git then falls back to `master` (ubuntu/CI)
    // while macOS dev boxes are usually configured for `main`. A bare repo whose
    // HEAD points at a branch we never push cannot be checked out — git prints
    // "remote HEAD refers to nonexistent ref, unable to checkout", produces an
    // EMPTY worktree, and never runs post-checkout. That failed only on CI and
    // looked exactly like a dead hook.
    const gitconfig = path.join(root, 'gitconfig');
    fs.writeFileSync(gitconfig, '[init]\n\tdefaultBranch = main\n');
    gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_SYSTEM: '/dev/null' };

    // Generate the REAL hook, then swap its binary-resolution block for a tracer
    // so we can see exactly when the hook decides to invoke us, and with what.
    // (The block can't be left alone: it resolves to the real `origin` on this
    // machine, which would run against the developer's actual config.)
    writeGlobalPostCheckoutHook(hooksDir);
    const hookPath = path.join(hooksDir, 'post-checkout');
    const real = fs.readFileSync(hookPath, 'utf-8');
    const start = real.indexOf('ORIGIN_BIN=""');
    const endMarker = real.indexOf('\nfi\n', start);
    expect(start, 'binary-resolution block not found in generated hook').toBeGreaterThan(-1);
    expect(endMarker, 'end of binary-resolution block not found').toBeGreaterThan(start);
    const traced =
      real.slice(0, start) +
      `ORIGIN_BIN="${path.join(root, 'fake-origin')}"` +
      real.slice(endMarker + '\nfi'.length);
    fs.writeFileSync(hookPath, traced);
    fs.chmodSync(hookPath, '755');

    // The stand-in for `origin`: records its args, then does what the real
    // handler does — sync notes from the remote.
    fs.writeFileSync(
      path.join(root, 'fake-origin'),
      `#!/bin/sh
echo "$@" >> ${JSON.stringify(traceLog)}
# mimic handleGitPostCheckout: fetch + fold the notes
git fetch -q origin '+refs/notes/origin:refs/notes/origin-remote' 2>/dev/null
git update-ref refs/notes/origin refs/notes/origin-remote 2>/dev/null
exit 0
`,
    );
    fs.chmodSync(path.join(root, 'fake-origin'), '755');

    execFileSync('git', ['config', '--global', 'core.hooksPath', hooksDir], { env: gitEnv });

    // An author publishes code + a note, as the real hooks do.
    bare = path.join(root, 'bare.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: gitEnv });
    author = path.join(root, 'author');
    fs.mkdirSync(author);
    git(author, 'init', '-q', '-b', 'main', '.');
    git(author, 'config', 'user.email', 'a@a.co');
    git(author, 'config', 'user.name', 'a');
    git(author, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(author, 'app.py'), 'def f(): pass\n');
    git(author, 'add', '-A');
    git(author, 'commit', '-qm', 'add f()');
    git(author, 'remote', 'add', 'origin', bare);
    git(author, 'push', '-q', 'origin', 'main');
    git(author, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(author, 'b.py'), 'x\n');
    git(author, 'add', '-A');
    git(author, 'commit', '-qm', 'c2');
    git(author, 'push', '-q', 'origin', 'feature');
    git(author, 'checkout', '-q', 'main');
    git(author, 'notes', '--ref=origin', 'add', '-m', '{"model":"opus","prompt":"write f()"}', 'HEAD');
    git(author, 'push', '-q', 'origin', 'refs/notes/origin:refs/notes/origin');

    // core.hooksPath is GLOBAL, so the hook fired for the author repo's own
    // checkouts above. Reset the trace so each test only sees what it caused —
    // otherwise the counts below silently measure the fixture, not the clone.
    fs.writeFileSync(traceLog, '');
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function invocations(): string[] {
    try {
      return fs.readFileSync(traceLog, 'utf-8').split('\n').filter(Boolean);
    } catch { return []; }
  }

  function cloneFresh(name: string): string {
    const dest = path.join(root, name);
    execFileSync('git', ['clone', '-q', bare, dest], { env: gitEnv });
    return dest;
  }

  /**
   * The hook backgrounds its work on purpose — a slow network must never hold
   * up someone's clone — so the notes land a moment AFTER `git clone` returns.
   * Wait for that rather than racing it. (A test that read the log immediately
   * saw zero invocations and looked like the hook was dead.)
   */
  function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  function waitFor(predicate: () => boolean, timeoutMs = 8_000): boolean {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      sleepSync(25);
    }
    return predicate();
  }

  /** Nothing should fire — give any stray background job a chance to prove us wrong. */
  function settle(): void {
    sleepSync(600);
  }

  it('a plain git clone lands with the notes already present — no manual command', () => {
    const fresh = cloneFresh('fresh');

    // The hook ran, and told us it was a clone (null-ref previous HEAD).
    expect(waitFor(() => invocations().length === 1), 'hook never invoked origin').toBe(true);
    expect(invocations()[0]).toMatch(/^hooks git-post-checkout 0{40} [0-9a-f]{40} 1$/);

    // And the payoff: attribution readable with plain git, nothing else run.
    expect(waitFor(() => {
      try { return git(fresh, 'notes', '--ref=origin', 'show', 'HEAD').includes('write f()'); }
      catch { return false; }
    }), 'notes never arrived after clone').toBe(true);
    expect(git(fresh, 'log', '-1', '--show-notes=origin', '--format=%N')).toContain('opus');
  }, 30_000);

  it('passes a REAL previous HEAD on a branch switch, so the CLI can tell it from a clone', () => {
    const fresh = cloneFresh('fresh');
    waitFor(() => invocations().length === 1); // let the clone's own run finish
    fs.writeFileSync(traceLog, '');            // then reset

    git(fresh, 'checkout', '-q', 'feature');
    settle();

    // The hook DOES fire here — the same command also drives stash attribution
    // preservation, which needs ordinary checkouts. What distinguishes a clone
    // is the null-ref previous HEAD, NOT the flag (both pass flag=1). If the CLI
    // keyed on the flag it would run a network fetch on every checkout.
    expect(invocations().length).toBe(1);
    expect(invocations()[0]).toMatch(/^hooks git-post-checkout [0-9a-f]{40} [0-9a-f]{40} 1$/);
    expect(invocations()[0]).not.toMatch(/ 0{40} /); // not a clone
  }, 30_000);

  it('does NOT fire on a file checkout', () => {
    const fresh = cloneFresh('fresh');
    waitFor(() => invocations().length === 1);
    fs.writeFileSync(traceLog, '');

    fs.appendFileSync(path.join(fresh, 'app.py'), 'junk\n');
    git(fresh, 'checkout', '-q', '--', 'app.py');
    settle();

    // flag=0 — bailed in shell, before any node startup.
    expect(invocations()).toEqual([]);
  }, 30_000);

  it('never breaks the clone when origin is missing or broken', () => {
    // Point the hook at a binary that does not exist, and one that fails.
    const hookPath = path.join(hooksDir, 'post-checkout');
    const src = fs.readFileSync(hookPath, 'utf-8');
    fs.writeFileSync(hookPath, src.replace(/ORIGIN_BIN="[^"]*"/, `ORIGIN_BIN="${path.join(root, 'nope')}"`));
    fs.chmodSync(hookPath, '755');
    expect(() => cloneFresh('c1')).not.toThrow();

    fs.writeFileSync(path.join(root, 'boom'), '#!/bin/sh\nexit 3\n');
    fs.chmodSync(path.join(root, 'boom'), '755');
    fs.writeFileSync(hookPath, src.replace(/ORIGIN_BIN="[^"]*"/, `ORIGIN_BIN="${path.join(root, 'boom')}"`));
    fs.chmodSync(hookPath, '755');
    expect(() => cloneFresh('c2')).not.toThrow();
  }, 30_000);
});
