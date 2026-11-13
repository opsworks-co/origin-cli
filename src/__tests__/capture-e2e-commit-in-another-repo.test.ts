// End to end, through the built binary: a session homed in repository A that
// commits in repository B.
//
// Prod 2026-10-15: Claude Code session bd2aa0d7 was registered in a worktree
// of `rhodecode-new.com` (GitHub). It ran `cd ~/Documents/new-rhodecode-com-case-studies
// && … git commit` — a linked worktree of `new-rhodecode-com-prod`, whose
// remote is code.rhodecode.com/internal/new-rhodecode-com — and committed
// b26793a3 there. B's .git holds no session state, so hooks.log read:
//
//   [prepare-commit-msg] skip — no unambiguous active session
//   [post-commit] no git note — no session state for this commit
//   [post-commit] no active sessions, skipped API update
//
// 0 of that repo's 382 commits had a session. Here: B is a main checkout with a
// RhodeCode `origin` (rewritten by insteadOf to a local bare repo, so the
// pre-push publish is real) and a linked worktree the agent `cd`s into, as in
// prod. The commit must carry the trailer, get the note in B, reach the API
// under the session with B linked to it (attach-repo → gitCapture.repoId), and
// the note must reach B's remote on push. Two sessions that both reached B are
// not guessed between, and a turn that has closed claims nothing.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHarness, haveDist, BIN, commitFiles, sleep } from './helpers/stop-next-prompt-harness.js';
import type { Harness } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { TEST_WIN_PROCESS_SNAPSHOT_ENV } from '../utils/process-detect.js';

const T = 120_000 * WINDOWS_SLOWDOWN;
const RHODECODE_URL = 'https://code.rhodecode.com/internal/new-rhodecode-com';
const B_REPO_ID = 'repo-b-rhodecode-0001';

function gitHook(cwd: string, name: string, args: string[] = []): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name, ...args], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

/**
 * gitHook for a commit a PERSON makes: the hook runs outside this process's
 * tree. Every agent hook here is this test process's child, so the session's
 * recorded owner (process-owner.ts) is this process, and a hook it spawns
 * descends from the agent — which a commit typed in a terminal does not. A
 * subshell that exits at once leaves the hook orphaned, as it would be under
 * a terminal that is not the agent. Windows has no process-tree rule: run it
 * the usual way.
 */
async function personGitHook(cwd: string, name: string, args: string[] = []): Promise<{ code: number | null; stderr: string }> {
  if (process.platform === 'win32') return gitHook(cwd, name, args);
  const dir = fs.mkdtempSync(path.join(path.dirname(cwd), 'person-hook-'));
  const done = path.join(dir, 'code');
  const errFile = path.join(dir, 'stderr');
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const cmd = `( ${[process.execPath, BIN, 'hooks', name, ...args].map(q).join(' ')} 2>${q(errFile)}; echo $? > ${q(done + '.tmp')}; mv ${q(done + '.tmp')} ${q(done)} ) >/dev/null &`;
  execFileSync('/bin/sh', ['-c', cmd], { cwd, env: { ...process.env } });
  for (let i = 0; i < 600 && !fs.existsSync(done); i++) await sleep(50);
  const code = fs.existsSync(done) ? Number(fs.readFileSync(done, 'utf-8').trim()) : null;
  const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8') : '';
  return { code, stderr };
}

/** Repository B: a main checkout with a RhodeCode origin, and a linked worktree. */
function makeRepoB(h: Harness): { prod: string; wt: string; bare: string } {
  const root = path.dirname(h.repo);
  const bare = path.join(root, 'b-remote.git');
  const prod = path.join(root, 'new-rhodecode-com-prod');
  const wt = path.join(root, 'new-rhodecode-com-case-studies');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  fs.mkdirSync(prod);
  git(prod, ['init', '-q', '-b', 'master']);
  git(prod, ['config', 'user.name', 'E2E']);
  git(prod, ['config', 'user.email', 'e2e@example.com']);
  git(prod, ['remote', 'add', 'origin', RHODECODE_URL]);
  git(prod, ['config', `url.${bare}.pushInsteadOf`, RHODECODE_URL]);
  fs.mkdirSync(path.join(prod, 'blog'));
  fs.writeFileSync(path.join(prod, 'blog', 'index.md'), '# Blog\n');
  git(prod, ['add', '-A']);
  git(prod, ['commit', '-q', '-m', 'base', '--no-verify']);
  git(prod, ['push', '-q', '--no-verify', 'origin', 'master']);
  git(prod, ['worktree', 'add', '-q', '-b', 'case-studies', wt]);
  return { prod, wt: fs.realpathSync.native(wt), bare };
}

/**
 * `cd <wt> && … git commit` as the agent's one Bash call: pre-tool-use, the
 * write, git's prepare-commit-msg, the commit, post-commit, post-tool-use.
 */
async function agentCommitsIn(
  run: Harness['agentRuns'],
  id: string,
  wt: string,
  file: string,
  content: string,
  subject: string,
): Promise<string> {
  let postCommit: Promise<{ code: number | null; stderr: string }> | null = null;
  await run(id, `cd ${wt} && cat > ${file} <<'EOF'\n${content}EOF\ngit add -A && git commit -m "${subject}"`, async () => {
    fs.writeFileSync(path.join(wt, file), content);
    git(wt, ['add', '-A']);
    const msgFile = path.join(git(wt, ['rev-parse', '--absolute-git-dir']), 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, `${subject}\n`);
    const r = await gitHook(wt, 'git-prepare-commit-msg', [msgFile, 'message']);
    expect(r.code, r.stderr).toBe(0);
    git(wt, ['commit', '-q', '--no-verify', '-F', msgFile]);
    postCommit = gitHook(wt, 'git-post-commit');
  });
  const pc = await postCommit!;
  expect(pc.code, pc.stderr).toBe(0);
  return git(wt, ['rev-parse', 'HEAD']);
}

const noteOf = (cwd: string, sha: string): string => {
  try { return git(cwd, ['notes', '--ref=origin', 'show', sha]); } catch { return ''; }
};

/**
 * Run `fn` while process detection sees exactly one standalone agent process —
 * Codex — and nothing else. post-commit's no-session fallback then has a unique
 * match no matter what really runs on the host, which is the condition that
 * turned an ambiguous foreign lookup into a `detected-codex-*` note.
 *
 * Unix: a fake `pgrep` first on PATH. Windows: detection reads a Win32_Process
 * snapshot from PowerShell, which no PATH shim can replace (spawnSync runs it
 * without a shell), so the snapshot comes from the test-only override that
 * process-detect honours inside a Vitest run. The hooks inherit either one.
 */
async function withOnlyCodexRunning<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const savedPath = process.env.PATH;
  const savedSnapshot = process.env[TEST_WIN_PROCESS_SNAPSHOT_ENV];
  if (process.platform === 'win32') {
    process.env[TEST_WIN_PROCESS_SNAPSHOT_ENV] = JSON.stringify([
      { ProcessId: 424242, ParentProcessId: 1, CommandLine: 'codex.exe exec' },
    ]);
  } else {
    const bin = path.join(root, 'fake-pgrep-bin');
    fs.mkdirSync(bin, { recursive: true });
    // Behaves like `pgrep -f <ERE>` on a machine whose only process is `codex exec`: the pattern the
    // registry passes is matched as an ERE against that command line, so only Codex's pattern finds it.
    fs.writeFileSync(
      path.join(bin, 'pgrep'),
      '#!/bin/sh\n'
        + '[ "$1" = "-f" ] && printf \'%s\\n\' \'codex exec\' | grep -Eq -- "$2" && { echo 424242; exit 0; }\n'
        + 'exit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  }
  try {
    return await fn();
  } finally {
    process.env.PATH = savedPath;
    if (savedSnapshot === undefined) delete process.env[TEST_WIN_PROCESS_SNAPSHOT_ENV];
    else process.env[TEST_WIN_PROCESS_SNAPSHOT_ENV] = savedSnapshot;
  }
}

/** A commit in `wt` made by hand: prepare-commit-msg, the commit, post-commit. */
async function commitByHand(wt: string, file: string, content: string, subject: string): Promise<string> {
  fs.writeFileSync(path.join(wt, file), content);
  git(wt, ['add', '-A']);
  const msgFile = path.join(git(wt, ['rev-parse', '--absolute-git-dir']), 'COMMIT_EDITMSG');
  fs.writeFileSync(msgFile, `${subject}\n`);
  const r = await personGitHook(wt, 'git-prepare-commit-msg', [msgFile, 'message']);
  expect(r.code, r.stderr).toBe(0);
  git(wt, ['commit', '-q', '--no-verify', '-F', msgFile]);
  const pc = await gitHook(wt, 'git-post-commit');
  expect(pc.code, pc.stderr).toBe(0);
  return git(wt, ['rev-parse', 'HEAD']);
}

describe.skipIf(!haveDist)('a commit a session makes in another repository', () => {
  it('carries the trailer, gets the note in its own repo, and reaches the API under the session', async () => {
    const SID = 'e2e-xrepo-claim-0001';
    const SRV = 'e2e-xrepo-srv-claim-0001';
    const attaches: any[] = [];
    const h = await createHarness(SID, SRV, {
      respond: (method, url, body) => {
        if (method === 'POST' && url === `/api/mcp/session/${SRV}/attach-repo`) {
          attaches.push(body);
          return { ok: true, attached: true, repoId: B_REPO_ID };
        }
        return undefined;
      },
    });
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      await h.startSession('move the missing blog posts to the new site');

      // Looks around in B first, as the prod session did.
      await h.agentRuns('tu-look', `cd ${b.wt} && ls blog`, () => { /* read-only */ });
      const sha = await agentCommitsIn(h.agentRuns, 'tu-commit', b.wt, 'blog/new-post.md', 'A new post.\n', 'Blog: import the two posts');

      // The trailer, in B's commit.
      const message = git(b.wt, ['log', '-1', '--format=%B', sha]);
      expect(message, h.hooksLog().split('\n').filter((l) => /prepare-commit-msg|git-hook-sessions/.test(l)).join('\n'))
        .toMatch(new RegExp(`^Origin-Session: ${SRV.slice(0, 12)}`, 'm'));
      // The note, in B.
      expect(noteOf(b.wt, sha)).toContain(SRV);
      // B is linked to the session — the commit's own repo, by its remote.
      expect(attaches).toHaveLength(1);
      expect(attaches[0].repoPath).toBe(fs.realpathSync.native(b.prod));
      expect(attaches[0].repoUrl).toBe(RHODECODE_URL);
      // The commit reaches the API under the session, filed in B.
      const carriers = h.hits.filter((x) => x.method === 'PATCH' && x.url === `/api/mcp/session/${SRV}`
        && (x.body?.gitCapture?.commitShas || []).includes(sha));
      expect(carriers.length, 'no session PATCH carried the commit').toBeGreaterThan(0);
      for (const c of carriers) {
        expect(c.body.gitCapture.repoId, 'a carrier without B\'s id files the commit in A').toBe(B_REPO_ID);
        // B's branch is not the session's.
        expect(c.body.branch).toBeUndefined();
      }
      const stamped = carriers.flatMap((c) => c.body.promptChanges || []).filter((pc: any) => pc.commitSha === sha);
      expect(stamped.length, 'the committing turn was not stamped with the commit').toBeGreaterThan(0);
      expect(stamped[0].filesChanged).toEqual(['blog/new-post.md']);

      // State: kept apart from the session's own commits, and none written into B.
      const st = JSON.parse(fs.readFileSync(path.join(h.repo, '.git', `origin-session-${SID.slice(0, 12)}.json`), 'utf-8'));
      expect((st.crossRepoCommits || []).map((c: any) => c.sha)).toContain(sha);
      expect(st.sessionCommitShas || []).not.toContain(sha);
      expect(fs.readdirSync(path.join(b.prod, '.git')).filter((f) => f.startsWith('origin-session'))).toEqual([]);

      // pre-push publishes the note to B's RhodeCode origin.
      const push = await gitHook(b.wt, 'git-pre-push');
      expect(push.code, push.stderr).toBe(0);
      expect(git(b.bare, ['for-each-ref', '--format=%(refname)', 'refs/notes/origin'])).toBe('refs/notes/origin');
      expect(git(b.bare, ['notes', '--ref=origin', 'show', sha])).toContain(SRV);

      h.reply('Imported both posts.');
      await h.stop();
      // Nothing after the commit's own carrier sends it without B's id.
      for (const x of h.hits.filter((y) => y.method === 'PATCH' && y.url.startsWith(`/api/mcp/session/${SRV}`))) {
        const gc = x.body?.gitCapture;
        const names = [...(gc?.commitShas || []), ...((gc?.commitDetails || []).map((d: any) => d.sha))];
        if (names.includes(sha)) expect(gc.repoId).toBe(B_REPO_ID);
      }
      // …and Stop leaves the committing turn holding it.
      const turn0 = h.rows().find((r: any) => r.promptIndex === 0);
      expect(turn0?.commitSha, JSON.stringify(turn0)).toBe(sha);
      expect(turn0.filesChanged).toEqual(['blog/new-post.md']);
      expect(turn0.linesAdded).toBe(1);

      // A later turn and its Stop leave it there.
      await h.submit('thanks — anything else to move?');
      h.reply('No, that was all of them.');
      await h.stop();
      const again = h.rows().find((r: any) => r.promptIndex === 0);
      expect(again?.commitSha, JSON.stringify(again)).toBe(sha);
      expect(again.filesChanged).toEqual(['blog/new-post.md']);
      const turn1 = h.rows().find((r: any) => r.promptIndex === 1);
      expect(turn1?.commitSha ?? null).toBeNull();
      expect(turn1?.filesChanged || []).toEqual([]);

      // The turn has closed: a later commit in B made by hand is nobody's.
      await sleep(200);
      fs.writeFileSync(path.join(b.wt, 'blog', 'by-hand.md'), 'typed by a person\n');
      git(b.wt, ['add', '-A']);
      const msgFile = path.join(git(b.wt, ['rev-parse', '--absolute-git-dir']), 'COMMIT_EDITMSG');
      fs.writeFileSync(msgFile, 'by hand\n');
      const r = await gitHook(b.wt, 'git-prepare-commit-msg', [msgFile, 'message']);
      expect(r.code, r.stderr).toBe(0);
      expect(fs.readFileSync(msgFile, 'utf-8')).not.toContain('Origin-Session:');
    } finally {
      await h.close();
    }
  }, T);

  it('two sessions that both reached the checkout are not guessed between', async () => {
    const SID = 'e2e-xrepo-two-0001';
    const SRV = 'e2e-xrepo-srv-two-0001';
    const h = await createHarness(SID, SRV, {
      respond: (method, url) => (method === 'POST' && url.endsWith('/attach-repo') ? { ok: true, attached: true, repoId: B_REPO_ID } : undefined),
    });
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      await h.startSession('move the missing blog posts to the new site');
      const other = await h.sibling('e2e-sibling-xrepo-0002');
      await other.submit('check the blog in the new site');
      await other.agentRuns('s-look', `cd ${b.wt} && ls blog`, () => { /* read-only */ });

      await h.agentRuns('tu-look', `cd ${b.wt} && ls blog`, () => { /* read-only */ });
      const sha = await agentCommitsIn(h.agentRuns, 'tu-commit', b.wt, 'blog/new-post.md', 'A new post.\n', 'Blog: import the two posts');

      expect(git(b.wt, ['log', '-1', '--format=%B', sha])).not.toContain('Origin-Session:');
      expect(noteOf(b.wt, sha)).toBe('');
      expect(h.hooksLog()).toMatch(/several sessions from other repositories worked in this checkout — not guessing/);
      const carried = h.hits.filter((x) => x.method === 'PATCH'
        && JSON.stringify(x.body?.gitCapture || {}).includes(sha));
      expect(carried).toEqual([]);
    } finally {
      await h.close();
    }
  }, T);
  // Control for the regression below: with no session from another repository
  // in play (`none`), the forced single Codex process IS used — so the fake
  // pgrep is effective and the regression cannot pass vacuously.
  it('with no foreign session, a lone agent process still tags the commit', async () => {
    const SID = 'e2e-xrepo-none-0001';
    const SRV = 'e2e-xrepo-srv-none-0001';
    const h = await createHarness(SID, SRV);
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      await h.startSession('work on repository A only');

      // hooks.log is shared by every test in this worker: read only this commit's part.
      const logStart = h.hooksLog().length;
      const sha = await withOnlyCodexRunning(path.dirname(h.repo), () =>
        commitByHand(b.wt, 'blog/by-hand.md', 'typed by a person\n', 'by hand'));

      expect(h.hooksLog().slice(logStart)).toMatch(/no active session but detected AI process/);
      expect(noteOf(b.wt, sha)).toContain('detected-codex-');
    } finally {
      await h.close();
    }
  }, T);

  it('an ambiguous foreign lookup is not overridden by a lone agent process', async () => {
    const SID = 'e2e-xrepo-ambig-0001';
    const SRV = 'e2e-xrepo-srv-ambig-0001';
    const h = await createHarness(SID, SRV, {
      respond: (method, url) => (method === 'POST' && url.endsWith('/attach-repo') ? { ok: true, attached: true, repoId: B_REPO_ID } : undefined),
    });
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      await h.startSession('move the missing blog posts to the new site');
      const other = await h.sibling('e2e-sibling-xrepo-ambig-0002');
      await other.submit('check the blog in the new site');
      await other.agentRuns('s-look', `cd ${b.wt} && ls blog`, () => { /* read-only */ });
      await h.agentRuns('tu-look', `cd ${b.wt} && ls blog`, () => { /* read-only */ });

      // hooks.log is shared by every test in this worker: read only this commit's part.
      const logStart = h.hooksLog().length;
      const sha = await withOnlyCodexRunning(path.dirname(h.repo), () =>
        agentCommitsIn(h.agentRuns, 'tu-commit', b.wt, 'blog/new-post.md', 'A new post.\n', 'Blog: import the two posts'));

      const log = h.hooksLog().slice(logStart);
      expect(log).toMatch(/several sessions from other repositories worked in this checkout — not guessing/);
      expect(log).toMatch(/no process fallback — sessions from other repositories are ambiguous for this commit/);
      expect(log).not.toMatch(/no active session but detected AI process/);
      // No trailer, no note, no API ownership — neither for a session nor for
      // a synthetic `detected-*` stand-in.
      expect(git(b.wt, ['log', '-1', '--format=%B', sha])).not.toContain('Origin-Session:');
      expect(noteOf(b.wt, sha)).toBe('');
      expect(JSON.stringify(h.hits)).not.toContain('detected-');
      const carried = h.hits.filter((x) => x.method === 'PATCH'
        && JSON.stringify(x.body?.gitCapture || {}).includes(sha));
      expect(carried).toEqual([]);
    } finally {
      await h.close();
    }
  }, T);

  // The `unique` twin of the case above. One session from repository A is the
  // only candidate: its running prompt reached B, but only to look (a read opens
  // no turn), and its one recorded turn wrote a file in A. The commit is typed by
  // hand and touches neither, so the lone-session check refuses the session and
  // empties the candidate list — which must not read as "there was never a
  // candidate" and hand the commit to whichever agent process is running.
  it('a refused lone foreign session is not overridden by a lone agent process', async () => {
    const SID = 'e2e-xrepo-refused-0001';
    const SRV = 'e2e-xrepo-srv-refused-0001';
    const h = await createHarness(SID, SRV, {
      respond: (method, url) => (method === 'POST' && url.endsWith('/attach-repo') ? { ok: true, attached: true, repoId: B_REPO_ID } : undefined),
    });
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      await h.startSession('write the release notes');
      await h.agentWrites('tu-notes', 'notes.md', 'Release notes.\n');
      h.reply('Wrote the notes.');
      await h.stop();
      await h.submit('check the blog in the new site');
      await h.agentRuns('tu-look', `cd ${b.wt} && ls blog`, () => { /* read-only */ });

      // hooks.log is shared by every test in this worker: read only this commit's part.
      const logStart = h.hooksLog().length;
      const sha = await withOnlyCodexRunning(path.dirname(h.repo), () =>
        commitByHand(b.wt, 'blog/by-hand.md', 'typed by a person\n', 'by hand'));

      const log = h.hooksLog().slice(logStart);
      expect(log).toMatch(/session from another repository worked in this checkout/);
      expect(log).toMatch(/SKIP: the only live session shows no evidence for this commit/);
      expect(log).toMatch(/no process fallback — the candidate sessions were refused for this commit/);
      expect(log).not.toMatch(/no active session but detected AI process/);
      // No trailer, no note, no API ownership — neither for the session nor for
      // a synthetic `detected-*` stand-in.
      expect(git(b.wt, ['log', '-1', '--format=%B', sha])).not.toContain('Origin-Session:');
      expect(noteOf(b.wt, sha)).toBe('');
      expect(JSON.stringify(h.hits)).not.toContain('detected-');
      const carried = h.hits.filter((x) => x.method === 'PATCH'
        && JSON.stringify(x.body?.gitCapture || {}).includes(sha));
      expect(carried).toEqual([]);
    } finally {
      await h.close();
    }
  }, T);

  // Prod 08705ba (PR #3076, 2026-11-03): a Claude Code session homed in `origin`
  // wrote a patch in the sibling RhodeCode checkout, its turn closed, and an hour
  // later a person committed that work from PyCharm on the same branch name. The
  // lookup wanted the turn still running, answered `none`, and the process
  // fallback wrote a `detected-codex-*` note: PR #3076 had no session.
  it('a commit a person makes later, of work the session wrote there, is the session\'s', async () => {
    const SID = 'e2e-xrepo-later-0001';
    const SRV = 'e2e-xrepo-srv-later-0001';
    const attaches: any[] = [];
    const h = await createHarness(SID, SRV, {
      respond: (method, url, body) => {
        if (method === 'POST' && url === `/api/mcp/session/${SRV}/attach-repo`) {
          attaches.push(body);
          return { ok: true, attached: true, repoId: B_REPO_ID };
        }
        return undefined;
      },
    });
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      git(h.repo, ['checkout', '-q', '-b', 'OR-27-isolate']);
      git(b.wt, ['checkout', '-q', '-b', 'OR-27-isolate']);
      await h.startSession('isolate the core patch');
      await h.agentWrites('tu-patch', path.relative(h.repo, path.join(b.wt, 'FORK_PATCH.md')), 'the patch\n');
      h.reply('Wrote the patch. Commit it yourself.');
      await h.stop();
      await sleep(200);
      // A later turn about something else: the commit is not its work.
      await h.submit('now the release notes');
      await h.agentWrites('tu-notes', 'notes.md', 'Release notes.\n');
      h.reply('Wrote the notes.');
      await h.stop();
      await sleep(200);

      // hooks.log is shared by every test in this worker: read only this commit's part.
      const logStart = h.hooksLog().length;
      const sha = await withOnlyCodexRunning(path.dirname(h.repo), () =>
        commitByHand(b.wt, 'FORK_PATCH.md', 'the patch, checked by a person\n', 'OR-27 isolate the core patch'));

      const log = h.hooksLog().slice(logStart);
      expect(log).not.toMatch(/no active session but detected AI process/);
      expect(git(b.wt, ['log', '-1', '--format=%B', sha])).toMatch(new RegExp(`^Origin-Session: ${SRV.slice(0, 12)}`, 'm'));
      expect(noteOf(b.wt, sha)).toContain(SRV);
      expect(attaches.length).toBeGreaterThan(0);
      const carriers = h.hits.filter((x) => x.method === 'PATCH' && x.url === `/api/mcp/session/${SRV}`
        && (x.body?.gitCapture?.commitShas || []).includes(sha));
      expect(carriers.length, 'no session PATCH carried the commit').toBeGreaterThan(0);
      for (const c of carriers) expect(c.body.gitCapture.repoId).toBe(B_REPO_ID);

      // It lands on the turn that wrote the file, and leaves the later turn alone.
      const sent = carriers.flatMap((c) => c.body.promptChanges || []).filter((pc: any) => pc.commitSha === sha);
      expect(sent.map((pc: any) => pc.promptIndex)).toEqual([0]);
      const rows = h.rows();
      expect(rows.find((r: any) => r.promptIndex === 0)?.commitSha).toBe(sha);
      expect(rows.find((r: any) => r.promptIndex === 1)?.commitSha ?? null).toBeNull();
      expect(rows.find((r: any) => r.promptIndex === 1)?.filesChanged).toEqual(['notes.md']);
      const st = JSON.parse(fs.readFileSync(path.join(h.repo, '.git', `origin-session-${SID.slice(0, 12)}.json`), 'utf-8'));
      const turn0Id = st.completedPromptMappings?.find((m: any) => m.promptIndex === 0)?.turnId;
      const recorded = (st.crossRepoCommits || []).find((c: any) => c.sha === sha);
      if (turn0Id) expect(recorded?.turnId).toBe(turn0Id);

      // A file the session never touched, same branch, stays nobody's.
      const other = await withOnlyCodexRunning(path.dirname(h.repo), () =>
        commitByHand(b.wt, 'by-hand.py', 'typed by a person\n', 'by hand'));
      expect(git(b.wt, ['log', '-1', '--format=%B', other])).not.toContain('Origin-Session:');
      expect(noteOf(b.wt, other)).not.toContain(SRV);
    } finally {
      await h.close();
    }
  }, T);

  // Prod fe9fc5ad (OR-61): the session stayed on main in its own repository and
  // switched branch only in the other one, wrote there, and the person committed.
  it('a later commit by hand is the session\'s when only the other checkout switched branch', async () => {
    const SID = 'e2e-xrepo-switch-0001';
    const SRV = 'e2e-xrepo-srv-switch-0001';
    const h = await createHarness(SID, SRV, {
      respond: (method, url) => (method === 'POST' && url.endsWith('/attach-repo') ? { ok: true, attached: true, repoId: B_REPO_ID } : undefined),
    });
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      await h.startSession('narrow the skip in the other repository');
      await h.agentRuns('tu-switch', `cd ${b.wt} && git switch -c OR-61-narrow`, () => { git(b.wt, ['switch', '-q', '-c', 'OR-61-narrow']); });
      await h.agentWrites('tu-fix', path.relative(h.repo, path.join(b.wt, 'test_repository.py')), 'the fix\n');
      h.reply('Fixed. Commit it yourself.');
      await h.stop();
      await sleep(200);

      const logStart = h.hooksLog().length;
      const sha = await withOnlyCodexRunning(path.dirname(h.repo), () =>
        commitByHand(b.wt, 'test_repository.py', 'the fix, checked by a person\n', 'OR-61 narrow the skip'));

      expect(h.hooksLog().slice(logStart)).not.toMatch(/no active session but detected AI process/);
      expect(git(b.wt, ['log', '-1', '--format=%B', sha])).toMatch(new RegExp(`^Origin-Session: ${SRV.slice(0, 12)}`, 'm'));
      expect(noteOf(b.wt, sha)).toContain(SRV);
    } finally {
      await h.close();
    }
  }, T);

  /** A session that switched B to OR-53, then wrote `files` there through the shell only. */
  async function sessionWritesThroughShell(h: Harness, b: { wt: string }, files: string[]): Promise<void> {
    await h.startSession('add the bot user');
    await h.agentRuns('tu-switch', `cd ${b.wt} && git switch -c OR-53-bot`, () => { git(b.wt, ['switch', '-q', '-c', 'OR-53-bot']); });
    await h.agentRuns('tu-py', `cd ${b.wt} && python3 - <<'EOF'\nopen('x','w')\nEOF`, () => {
      for (const f of files) fs.writeFileSync(path.join(b.wt, f), `${f} written by the session\n`);
    }, {});
    h.reply('Done. Commit it yourself.');
    await h.stop();
    await sleep(200);
  }

  /** Commit what is in the tree, by hand: no file written here, unlike commitByHand. */
  async function commitTreeByHand(wt: string, subject: string): Promise<string> {
    git(wt, ['add', '-A']);
    const msgFile = path.join(git(wt, ['rev-parse', '--absolute-git-dir']), 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, `${subject}\n`);
    const r = await personGitHook(wt, 'git-prepare-commit-msg', [msgFile, 'message']);
    expect(r.code, r.stderr).toBe(0);
    git(wt, ['commit', '-q', '--no-verify', '-F', msgFile]);
    const pc = await gitHook(wt, 'git-post-commit');
    expect(pc.code, pc.stderr).toBe(0);
    return git(wt, ['rev-parse', 'HEAD']);
  }

  /** End it as the daemon does (Claude's SessionEnd hook is only a Stop); returns the ended state. */
  function endSession(h: Harness, sid: string, srv: string): any {
    const mirrorDir = path.join(os.homedir(), '.origin', 'sessions');
    const live = path.join(h.repo, '.git', `origin-session-${sid.slice(0, 12)}.json`);
    const ended = { ...JSON.parse(fs.readFileSync(live, 'utf-8')), status: 'ENDED', endedAt: new Date().toISOString() };
    fs.writeFileSync(live, JSON.stringify(ended));
    const mirrors = fs.readdirSync(mirrorDir).filter((f) => f.endsWith('.json') && fs.readFileSync(path.join(mirrorDir, f), 'utf-8').includes(srv));
    expect(mirrors.length).toBeGreaterThan(0);
    for (const m of mirrors) fs.writeFileSync(path.join(mirrorDir, m), JSON.stringify(ended));
    return ended;
  }

  const attachOk = (method: string, url: string) => (method === 'POST' && url.endsWith('/attach-repo') ? { ok: true, attached: true, repoId: B_REPO_ID } : undefined);

  // Prod 2419a3eb: 53 Bash calls and 2 Writes in the sibling checkout. A shell
  // write leaves no file record, so the commit had no evidence to match.
  it('a later commit by hand of files the session wrote through the shell is the session\'s', async () => {
    // (and one that is mostly a person's is not: see below)
    const SID = 'e2e-xrepo-shell-0001';
    const SRV = 'e2e-xrepo-srv-shell-0001';
    const h = await createHarness(SID, SRV, { respond: attachOk });
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      await sessionWritesThroughShell(h, b, ['user_avatar.py', 'test_user_avatar.py']);

      const sha = await withOnlyCodexRunning(path.dirname(h.repo), () => commitTreeByHand(b.wt, 'OR-53 add the bot user'));

      expect(git(b.wt, ['log', '-1', '--format=%B', sha])).toMatch(new RegExp(`^Origin-Session: ${SRV.slice(0, 12)}`, 'm'));
      expect(noteOf(b.wt, sha)).toContain(SRV);

      // Mostly a person's files: the trailer names one session for the whole commit.
      for (const f of ['p1.py', 'p2.py']) fs.writeFileSync(path.join(b.wt, f), 'typed by a person\n');
      fs.writeFileSync(path.join(b.wt, 'user_avatar.py'), 'touched again\n');
      const mostly = await withOnlyCodexRunning(path.dirname(h.repo), () => commitTreeByHand(b.wt, 'mostly by hand'));
      expect(git(b.wt, ['log', '-1', '--format=%B', mostly])).not.toContain('Origin-Session:');
    } finally {
      await h.close();
    }
  }, T);

  // Prod fa5c0f8b: the session ended at 16:54 and the person committed at 18:44.
  it('a commit by hand after the session ended carries its trailer, and no process guess', async () => {
    const SID = 'e2e-xrepo-ended-0001';
    const SRV = 'e2e-xrepo-srv-ended-0001';
    const h = await createHarness(SID, SRV, { respond: attachOk });
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      await sessionWritesThroughShell(h, b, ['user_avatar.py', 'test_user_avatar.py']);
      const ended = endSession(h, SID, SRV);
      expect(ended.foreignTrees[0].files.map((f: any) => f.file).sort()).toEqual(['test_user_avatar.py', 'user_avatar.py']);

      const logStart = h.hooksLog().length;
      const sha = await withOnlyCodexRunning(path.dirname(h.repo), () => commitTreeByHand(b.wt, 'OR-53 add the bot user'));

      expect(git(b.wt, ['log', '-1', '--format=%B', sha]), h.hooksLog().slice(logStart)).toMatch(new RegExp(`^Origin-Session: ${SRV.slice(0, 12)}`, 'm'));
      expect(h.hooksLog().slice(logStart)).toMatch(/attributed to an ended session/);
      expect(h.hooksLog().slice(logStart)).not.toMatch(/no active session but detected AI process/);
      expect(noteOf(b.wt, sha)).not.toContain('detected-');

      // Mostly a person's files: the trailer names one session for the whole
      // commit, so it must hold most of it.
      for (const f of ['p1.py', 'p2.py']) fs.writeFileSync(path.join(b.wt, f), 'typed by a person\n');
      fs.writeFileSync(path.join(b.wt, 'user_avatar.py'), 'touched again\n');
      const mostly = await commitTreeByHand(b.wt, 'mostly by hand');
      expect(git(b.wt, ['log', '-1', '--format=%B', mostly]), h.hooksLog().slice(logStart)).not.toContain('Origin-Session:');
    } finally {
      await h.close();
    }
  }, T);

  // main and master are on every clone, so the session having seen one is no
  // evidence, and a wrong trailer stays in git history.
  it('a commit by hand on master is not an ended session\'s, even of files it wrote', async () => {
    const SID = 'e2e-xrepo-master-0001';
    const SRV = 'e2e-xrepo-srv-master-0001';
    const h = await createHarness(SID, SRV, { respond: attachOk });
    try {
      commitFiles(h, { 'README.md': '# A\n' }, 'base');
      const b = makeRepoB(h);
      await h.startSession('edit the blog');
      await h.agentRuns('tu-py', `cd ${b.prod} && python3 - <<'EOF'\nopen('x','w')\nEOF`, () => {
        fs.writeFileSync(path.join(b.prod, 'post.py'), 'written by the session\n');
      }, {});
      h.reply('Done. Commit it yourself.');
      await h.stop();
      await sleep(200);
      const ended = endSession(h, SID, SRV);
      expect(ended.foreignTrees[0].branches).toContain('master');
      expect(ended.foreignTrees[0].files.map((f: any) => f.file)).toEqual(['post.py']);

      const logStart = h.hooksLog().length;
      const sha = await commitTreeByHand(b.prod, 'a person edits the blog');

      expect(git(b.prod, ['log', '-1', '--format=%B', sha]), h.hooksLog().slice(logStart)).not.toContain('Origin-Session:');
      expect(h.hooksLog().slice(logStart)).not.toMatch(/attributed to an ended session/);
    } finally {
      await h.close();
    }
  }, T);
});
