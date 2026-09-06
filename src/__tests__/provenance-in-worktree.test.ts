/**
 * Regression: `origin why`, `origin prompts`, `origin blame` and
 * `origin ask --file` must answer from inside a linked git worktree.
 *
 * User-reported, running in a Claude Code worktree at
 * `<repo>/.claude/worktrees/<name>`:
 *
 *   origin prompts apps/api/src/routes/mcp.ts
 *   →  No commits found for .claude/worktrees/session-…/apps/api/src/routes/mcp.ts
 *
 *   origin why apps/api/src/routes/mcp.ts:1666
 *   →  Uncommitted change — not yet attributed.
 *
 * …for a file with years of history. Both commands resolved the argument
 * against `getGitRoot`, which deliberately COLLAPSES a linked worktree onto its
 * main checkout (repo identity). Because worktrees live under the repo, that
 * produced a path git knows nothing about — the worktree is untracked dirt in
 * the main checkout — rather than an obviously-broken one. The data was fine;
 * the lookup key was wrong.
 *
 * `blame` and `ask --file` failed the other way: they handed the raw argument
 * to git with the canonical root as cwd, so from a worktree they blamed the
 * MAIN checkout's branch — a wrong answer rather than an empty one.
 *
 * The fix is the same working-vs-canonical split as the capture path (#510) and
 * the agy handler (#1226): resolve and read in `getWorkingGitRoot`, keep
 * `getGitRoot` for repo identity.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { resolveQueryTarget } from '../session-worktree.js';
import { promptsCommand } from '../commands/prompts.js';
import { whyCommand } from '../commands/why.js';
import { blameCommand } from '../commands/blame.js';
import { askCommand } from '../commands/ask.js';

// The suite isolates HOME, so the CLI is not logged in and both commands take
// their offline git-notes path. Pin it anyway: a machine-dependent connected
// mode would put a network call in the middle of a filesystem test.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isConnectedMode: () => false,
}));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const FILE = path.join('apps', 'api', 'src', 'routes', 'mcp.ts');
const POSIX_FILE = FILE.split(path.sep).join('/');
const SESSION_ID = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
const WT_SESSION_ID = 'bb22cc33-dd44-ee55-ff66-778899aabbcc';
const WT_ONLY_LINE = 'export const reuseAgeFloor = undefined;';

/**
 * A repo with one AI-attributed commit, plus a linked worktree INSIDE it —
 * `<repo>/.claude/worktrees/<name>`, exactly where Claude Code puts one. The
 * location is the whole point: a worktree beside the repo resolves to a `../`
 * path that fails loudly, while one under the repo resolves to a plausible
 * `.claude/worktrees/…` path that fails silently.
 */
function makeRepoWithWorktree(): { tmp: string; main: string; wt: string; sha: string; wtSha: string } {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-provenance-')));
  const main = path.join(tmp, 'kotleta');
  fs.mkdirSync(main);
  git(main, ['init', '-q', '-b', 'main']);
  git(main, ['config', 'user.email', 't@t.co']);
  git(main, ['config', 'user.name', 'T']);

  fs.mkdirSync(path.join(main, path.dirname(FILE)), { recursive: true });
  fs.writeFileSync(path.join(main, FILE), 'const reuseAgeCutoff = 12;\nexport default reuseAgeCutoff;\n');
  git(main, ['add', '-A']);
  git(main, ['commit', '-q', '-m', 'feat(api): the session reuse ladder']);
  const sha = git(main, ['rev-parse', 'HEAD']);

  // The Origin note both commands read to turn a commit into a session.
  git(main, ['notes', '--ref=origin', 'add', '-m',
    JSON.stringify({ sessionId: SESSION_ID, model: 'claude-opus-5', agent: 'claude-code' }), sha]);

  const wt = path.join(main, '.claude', 'worktrees', 'session-reuse-old-agent-f7056f');
  git(main, ['worktree', 'add', '-q', '-b', 'claude/session-reuse', wt]);

  // The worktree branch moves the file on: a line main does not have, in a
  // commit main does not have. Blaming the wrong tree now gives a DIFFERENT
  // answer instead of the same one, which is the only way to tell them apart.
  fs.appendFileSync(path.join(wt, FILE), WT_ONLY_LINE + '\n');
  git(wt, ['config', 'user.email', 't@t.co']);
  git(wt, ['config', 'user.name', 'T']);
  git(wt, ['commit', '-q', '-am', 'feat(api): worktree-only change']);
  const wtSha = git(wt, ['rev-parse', 'HEAD']);
  git(wt, ['notes', '--ref=origin', 'add', '-m',
    JSON.stringify({ sessionId: WT_SESSION_ID, model: 'claude-opus-5', agent: 'claude-code' }), wtSha]);
  return { tmp, main, wt, sha, wtSha };
}

describe('provenance commands inside a linked worktree', () => {
  let logs: string[] = [];
  const origCwd = process.cwd();
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    spy.mockRestore();
    process.chdir(origCwd);
  });

  // Strip chalk styling so assertions read the text, not the escapes.
  const output = () => logs.join('\n').replace(/\[[0-9;]*m/g, '');

  it('origin prompts finds the file history from the worktree', async () => {
    const { tmp, wt, sha } = makeRepoWithWorktree();
    try {
      process.chdir(wt);
      await promptsCommand(FILE, {});

      const out = output();
      expect(out).not.toContain('No commits found');
      expect(out).not.toContain('.claude/worktrees'); // the wrong key, printed back at the user
      expect(out).toContain(POSIX_FILE);
      expect(out).toContain(sha.slice(0, 8));
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('origin why attributes a line from the worktree', async () => {
    const { tmp, wt, sha } = makeRepoWithWorktree();
    try {
      process.chdir(wt);
      await whyCommand(`${POSIX_FILE}:1`);

      const out = output();
      expect(out).not.toContain('Uncommitted change');
      expect(out).toContain(`Line 1 in ${POSIX_FILE}`);
      expect(out).toContain(SESSION_ID.slice(0, 8));
      expect(out).toContain(sha.slice(0, 8));
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('origin blame blames the worktree branch, not the main checkout', async () => {
    const { tmp, wt } = makeRepoWithWorktree();
    try {
      process.chdir(wt);
      await blameCommand(FILE, { json: true });

      const parsed = JSON.parse(output());
      // The line only the worktree branch has must be present and credited
      // to the worktree commit's session. Against the main checkout it does
      // not exist at all — the pre-fix blame simply never saw it.
      const wtLine = parsed.lines.find((l: any) => l.content === WT_ONLY_LINE);
      expect(wtLine).toBeDefined();
      expect(wtLine.sessionId).toBe(WT_SESSION_ID);
      expect(Object.keys(parsed.sessions)).toContain(WT_SESSION_ID);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('origin ask --file reads the worktree branch history', async () => {
    const { tmp, wt } = makeRepoWithWorktree();
    try {
      process.chdir(wt);
      await askCommand('reuse', { file: FILE });

      const out = output();
      expect(out).not.toContain('No commits found');
      // Both sessions touched the file on this branch: main's commit and the
      // worktree-only one. Standing in main, the second would be invisible.
      expect(out).toContain('Sessions that modified this file: 2');
      expect(out).toContain(WT_SESSION_ID.slice(0, 12));
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still works in the main checkout', async () => {
    const { tmp, main, sha } = makeRepoWithWorktree();
    try {
      process.chdir(main);
      await promptsCommand(FILE, {});
      expect(output()).toContain(sha.slice(0, 8));

      logs = [];
      await blameCommand(FILE, { json: true });
      // main never got the worktree commit; its blame must not show that line.
      const parsed = JSON.parse(output());
      expect(parsed.lines.find((l: any) => l.content === WT_ONLY_LINE)).toBeUndefined();
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('resolveQueryTarget', () => {
  const main = path.resolve('/w/kotleta');
  const wt = path.join(main, '.claude', 'worktrees', 'wt-1');
  const roots = { workRoot: wt, canonicalRoot: main };

  it('resolves a relative argument against the tree the user stands in', () => {
    expect(resolveQueryTarget(FILE, roots, wt)).toEqual({ relPath: POSIX_FILE, root: wt });
  });

  it('sends an absolute path in the main checkout to the canonical root', () => {
    // Standing in the worktree, asking about the main checkout's copy: it
    // escapes workRoot, so the canonical root is the one that can answer.
    expect(resolveQueryTarget(path.join(main, FILE), roots, wt)).toEqual({ relPath: POSIX_FILE, root: main });
  });

  it('is a no-op outside a worktree (both roots the same)', () => {
    const plain = { workRoot: main, canonicalRoot: main };
    expect(resolveQueryTarget(FILE, plain, main)).toEqual({ relPath: POSIX_FILE, root: main });
  });
});
