// END-TO-END transport of refs/notes/origin between clones, through the
// GENERATED hook scripts and the BUILT CLI — no transport function is called by
// hand in place of a hook (OR-9/A3).
//
//   author commit → Origin note (real writer, v1 record inside)
//     → git push: generated pre-push → bare remote refs/notes/origin
//     → git clone: generated post-checkout → staging ref → fold → live ref
//     → plain git notes / legacy reader / v1 reader all see it
//   clone A: local note whose auto-push failed (offline)
//   clone B: note on another commit, published by `origin push-metadata`
//   clone A: git pull → generated post-merge → both notes locally
//   clone A: git push → pre-push publishes the union to origin
//   verification clone: both notes; repeats change nothing
//
// Plus: `git push upstream` never carries the notes to upstream, and the
// repo-local model — `origin enable --local` right after a plain clone fetches
// and folds at once and installs its local hooks.
//
// Isolated from the real machine: its own HOME (standalone, no API), its own
// global git config, bare remotes on disk. Requires `dist/`. POSIX-only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

vi.mock('../api.js', () => ({ api: { importGitNote: () => Promise.resolve({ ok: true }) } }));

const { writeGitNotes, ORIGIN_NOTES_GLOB_REFSPEC, STAGED_NOTES } = await import('../git-notes.js');
const { writeGlobalPostCheckoutHook, writeGlobalPostMergeHook, writeGlobalPrePushHook } = await import('../commands/enable.js');
const { readRecord } = await import('../attribution-record.js');
const { getSessionContextForCommit } = await import('../attribution.js');

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN) && process.platform !== 'win32';

let root = '';
let home = '';        // HOME of every hook and CLI run (standalone Origin)
let binDir = '';      // holds the `origin` wrapper around dist/index.js
let hooksDir = '';    // core.hooksPath of the "global" install
let remote = '';
let globalEnv: NodeJS.ProcessEnv;  // git with Origin's global hooks installed
let plainEnv: NodeJS.ProcessEnv;   // git with no global hooks (repo-local model)

function sh(cwd: string, env: NodeJS.ProcessEnv, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, env, encoding: 'utf-8', stdio: 'pipe' }).trim();
}
const g = (cwd: string, ...args: string[]) => sh(cwd, globalEnv, 'git', ...args);

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitFor(predicate: () => boolean, timeoutMs = 20_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (predicate()) return true; } catch { /* not yet */ }
    sleepSync(100);
  }
  try { return predicate(); } catch { return false; }
}

function noteOf(repo: string, sha: string): any | null {
  try { return JSON.parse(g(repo, 'notes', '--ref=origin', 'show', sha)); } catch { return null; }
}
const hasNote = (repo: string, sha: string) => noteOf(repo, sha) !== null;

function commitIn(repo: string, name: string): string {
  fs.writeFileSync(path.join(repo, name), `${name}\n`);
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', `add ${name}`);
  return g(repo, 'rev-parse', 'HEAD');
}

function identity(repo: string, who: string) {
  g(repo, 'config', 'user.email', `${who}@example.com`);
  g(repo, 'config', 'user.name', who);
  g(repo, 'config', 'commit.gpgsign', 'false');
}

/** The real writer, as post-commit calls it, with a v1 record source. */
function annotate(repo: string, sha: string, sessionId: string, agentId = 'claude-code') {
  writeGitNotes(repo, [sha], {
    sessionId,
    model: 'claude-opus-5-5',
    agentSlug: agentId,
    promptCount: 1,
    promptSummary: 'private prompt text',
    originUrl: `https://origin.example.com/sessions/${sessionId}`,
    linesAdded: 1,
    linesRemoved: 0,
    attribution: { sessionId, agentId, modelId: 'claude-opus-5-5' },
  });
}

function cloneWithGlobalHooks(name: string): string {
  const dest = path.join(root, name);
  sh(root, globalEnv, 'git', 'clone', '-q', remote, dest);
  identity(dest, name);
  return dest;
}

function expectFullyReadable(repo: string, sha: string, sessionId: string) {
  const note = noteOf(repo, sha);
  expect(note, `no live note for ${sha.slice(0, 8)} in ${path.basename(repo)}`).not.toBeNull();
  // Plain git.
  expect(g(repo, 'log', '-1', '--show-notes=origin', '--format=%N', sha)).toContain(sessionId);
  // The legacy Origin reader.
  expect(getSessionContextForCommit(repo, sha)?.sessionId).toBe(sessionId);
  // The v1 reader.
  expect(readRecord(note.attribution_record).status).toBe('exact');
  expect(note.attribution_record.revision.id).toBe(sha);
}

beforeAll(() => {
  if (!haveDist) return;
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-transport-')));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
  binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'origin'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  fs.chmodSync(path.join(binDir, 'origin'), '755');

  hooksDir = path.join(root, 'git-hooks');
  fs.mkdirSync(hooksDir);
  for (const write of [writeGlobalPostCheckoutHook, writeGlobalPostMergeHook, writeGlobalPrePushHook]) write(hooksDir);
  // Point each generated script at the wrapper: the resolution block would
  // otherwise find whatever `origin` this machine has installed.
  for (const hook of ['post-checkout', 'post-merge', 'pre-push']) {
    const p = path.join(hooksDir, hook);
    const src = fs.readFileSync(p, 'utf-8');
    const start = src.indexOf('ORIGIN_BIN=""');
    const end = src.indexOf('\nfi\n', start);
    expect(start).toBeGreaterThan(-1);
    fs.writeFileSync(p, src.slice(0, start) + `ORIGIN_BIN="${path.join(binDir, 'origin')}"` + src.slice(end + '\nfi'.length));
    fs.chmodSync(p, '755');
  }

  const base = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${binDir}:${process.env.PATH}`, GIT_CONFIG_SYSTEM: '/dev/null' };
  const globalCfg = path.join(root, 'gitconfig-global');
  fs.writeFileSync(globalCfg, `[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n[core]\n\thooksPath = ${hooksDir}\n`);
  globalEnv = { ...base, GIT_CONFIG_GLOBAL: globalCfg };
  const plainCfg = path.join(root, 'gitconfig-plain');
  fs.writeFileSync(plainCfg, '[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n');
  plainEnv = { ...base, GIT_CONFIG_GLOBAL: plainCfg };

  remote = path.join(root, 'remote.git');
  sh(root, globalEnv, 'git', 'init', '-q', '--bare', '-b', 'main', remote);
});

afterAll(() => {
  if (root) {
    // Let backgrounded hook children finish before the tree disappears.
    sleepSync(500);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!haveDist)('refs/notes/origin across clones, through the generated hooks', () => {
  let author = '';
  let cloneA = '';
  let cloneB = '';
  let c1 = '';
  let cA = '';
  let cB = '';

  it('author: a note written by the real writer reaches the remote on an ordinary git push', () => {
    author = path.join(root, 'author');
    fs.mkdirSync(author);
    g(author, 'init', '-q', '-b', 'main');
    identity(author, 'author');
    c1 = commitIn(author, 'one.txt');
    annotate(author, c1, 'sess-author');          // no remote yet: nothing to auto-push
    g(author, 'remote', 'add', 'origin', remote);
    g(author, 'push', '-q', '-u', 'origin', 'main'); // → generated pre-push publishes

    expect(g(remote, 'notes', '--ref=origin', 'show', c1)).toContain('sess-author');
  }, 60_000);

  it('a fresh clone gets the notes by itself: staging ref, fold, live ref (eventually)', () => {
    cloneA = cloneWithGlobalHooks('clone-a');
    // The hook backgrounds the fetch so the clone never waits on it.
    expect(waitFor(() => hasNote(cloneA, c1)), 'post-checkout never delivered the notes').toBe(true);
    expect(g(cloneA, 'rev-parse', '--verify', STAGED_NOTES.attribution.staging)).toMatch(/^[0-9a-f]{40}$/);
    expect(g(cloneA, 'config', '--get-all', 'remote.origin.fetch')).toContain(ORIGIN_NOTES_GLOB_REFSPEC);
    expectFullyReadable(cloneA, c1, 'sess-author');

    cloneB = cloneWithGlobalHooks('clone-b');
    expect(waitFor(() => hasNote(cloneB, c1))).toBe(true);
  }, 60_000);

  it('A keeps an unpushed note, B publishes another with `origin push-metadata`, A pulls and folds both', () => {
    // A: commit + note while the remote is unreachable, so the writer's
    // best-effort auto-push fails and the note stays local.
    cA = commitIn(cloneA, 'a.txt');
    g(cloneA, 'config', 'remote.origin.pushurl', path.join(root, 'offline.git'));
    annotate(cloneA, cA, 'sess-a', 'cursor');
    g(cloneA, 'config', '--unset', 'remote.origin.pushurl');
    expect(() => g(remote, 'notes', '--ref=origin', 'show', cA)).toThrow();

    // B: its own commit, pushed; its note, published by the command.
    cB = commitIn(cloneB, 'b.txt');
    g(cloneB, 'config', 'remote.origin.pushurl', path.join(root, 'offline.git'));
    annotate(cloneB, cB, 'sess-b', 'codex');
    g(cloneB, 'config', '--unset', 'remote.origin.pushurl');
    g(cloneB, 'push', '-q', 'origin', 'main');
    const out = sh(cloneB, globalEnv, 'origin', 'push-metadata');
    expect(out).toContain('Published refs/notes/origin to origin');
    expect(g(remote, 'notes', '--ref=origin', 'show', cB)).toContain('sess-b');

    // A: an ordinary pull (merge) → generated post-merge folds.
    g(cloneA, 'pull', '-q', '--no-edit');
    expect(waitFor(() => hasNote(cloneA, cB)), 'post-merge never folded B\'s note').toBe(true);
    expectFullyReadable(cloneA, cA, 'sess-a');   // the unpushed local note survived
    expectFullyReadable(cloneA, cB, 'sess-b');
    expectFullyReadable(cloneA, c1, 'sess-author');
  }, 60_000);

  it('A pushes normally: pre-push publishes the union to origin', () => {
    g(cloneA, 'push', '-q', 'origin', 'main');
    for (const [sha, sid] of [[c1, 'sess-author'], [cA, 'sess-a'], [cB, 'sess-b']]) {
      expect(g(remote, 'notes', '--ref=origin', 'show', sha)).toContain(sid);
    }

    const verify = cloneWithGlobalHooks('verify');
    expect(waitFor(() => hasNote(verify, cA) && hasNote(verify, cB) && hasNote(verify, c1))).toBe(true);
    expectFullyReadable(verify, cA, 'sess-a');
    expectFullyReadable(verify, cB, 'sess-b');
  }, 60_000);

  it('repeating fetch, fold and push loses nothing and changes nothing', () => {
    const remoteTip = g(remote, 'rev-parse', 'refs/notes/origin');
    const liveA = g(cloneA, 'rev-parse', 'refs/notes/origin');
    g(cloneA, 'pull', '-q', '--no-edit');
    sh(cloneA, globalEnv, 'origin', 'hooks', 'git-post-merge'); // a fold with nothing new
    g(cloneA, 'push', '-q', 'origin', 'main');
    expect(sh(cloneA, globalEnv, 'origin', 'push-metadata', 'origin')).toContain('Published');
    sleepSync(1_000); // any backgrounded hook work
    expect(g(remote, 'rev-parse', 'refs/notes/origin')).toBe(remoteTip);
    expect(g(cloneA, 'rev-parse', 'refs/notes/origin')).toBe(liveA);
    for (const sha of [c1, cA, cB]) expect(hasNote(cloneA, sha)).toBe(true);
  }, 60_000);

  it('`git push upstream` through the generated hook never carries the notes to upstream', () => {
    // A second remote — an open-source upstream, a customer's repository. The
    // notes carry prompt text (the real writer, with the explicit
    // notesIncludePrompts opt-in — the default since OR-48 is metadata only).
    fs.writeFileSync(path.join(cloneA, '.origin.json'), JSON.stringify({ notesIncludePrompts: true }));
    fs.appendFileSync(path.join(cloneA, '.git', 'info', 'exclude'), '\n.origin.json\n');
    const pub = path.join(root, 'public.git');
    sh(root, globalEnv, 'git', 'init', '-q', '--bare', '-b', 'main', pub);
    g(cloneA, 'remote', 'add', 'upstream', pub);
    const cU = commitIn(cloneA, 'upstream.txt');
    g(cloneA, 'config', 'remote.origin.pushurl', path.join(root, 'offline.git'));
    annotate(cloneA, cU, 'sess-up', 'claude-code');
    g(cloneA, 'config', '--unset', 'remote.origin.pushurl');
    expect(noteOf(cloneA, cU).origin.promptSummary).toBe('private prompt text');

    g(cloneA, 'push', '-q', 'upstream', 'main');   // → generated pre-push
    sleepSync(500);
    expect(() => sh(pub, globalEnv, 'git', 'rev-parse', '--verify', 'refs/notes/origin')).toThrow();
    // It went to origin, by policy — the push's own remote does not decide.
    expect(g(remote, 'notes', '--ref=origin', 'show', cU)).toContain('private prompt text');
  }, 60_000);

  it('repo-local model: `origin enable --local` after a plain clone fetches at once and installs local hooks', () => {
    const local = path.join(root, 'local-only');
    sh(root, plainEnv, 'git', 'clone', '-q', remote, local);
    identity(local, 'local');
    // No global hooks, nothing fetched: a clone cannot bring notes or hooks.
    expect(hasNote(local, c1)).toBe(false);

    sh(local, plainEnv, 'origin', 'enable', '--local', '--agent', 'aider', '--no-mcp');
    // Immediately, not eventually: enable syncs synchronously.
    const lg = (...args: string[]) => sh(local, plainEnv, 'git', ...args);
    expect(JSON.parse(lg('notes', '--ref=origin', 'show', c1)).origin.sessionId).toBe('sess-author');
    for (const hook of ['post-checkout', 'pre-push']) {
      expect(fs.existsSync(path.join(local, '.git', 'hooks', hook)), `local ${hook} missing`).toBe(true);
    }
  }, 120_000);
});
