/**
 * `origin pr create`: open a pull request for the current branch through
 * Origin and print its Origin link.
 *
 * Made for agents in Origin-hosted repos. Their git remote is the Git server
 * Origin stores the code on, so with no command of Origin's an agent opened
 * that server's own web form and gave the user its link (test2, PR !3082).
 * The server opens the PR on whatever host the repo lives on (POST
 * /api/repos/:id/pull-requests), so this works for any repo on Origin.
 */
import chalk from 'chalk';
import fs from 'fs';

export interface PrCreateOptions {
  title?: string;
  body?: string;
  bodyFile?: string;
  base?: string;
  head?: string;
  draft?: boolean;
  json?: boolean;
}

export interface PrCreateDeps {
  connected: () => boolean;
  repoRoot: (cwd: string) => string | null;
  currentBranch: (root: string) => string | null;
  remoteUrl: (root: string) => string | null;
  /** True when the branch exists on the `origin` remote, null when that can't be told. */
  branchOnRemote: (root: string, branch: string) => boolean | null;
  readFile: (file: string) => string;
  previewRoute: (data: { repoPath: string; repoUrl?: string }) => Promise<any>;
  openPullRequest: (repoId: string, data: { head: string; base?: string; title: string; body: string; draft: boolean }) => Promise<any>;
  appUrl: () => string;
  out: (s: string) => void;
}

export type PrCreateResult =
  | { ok: true; id: string; number: number; url: string; hostUrl: string | null }
  | { ok: false; message: string };

/** Pure apart from the deps; returns what happened instead of exiting. */
export async function prCreate(opts: PrCreateOptions, cwd: string, deps: PrCreateDeps): Promise<PrCreateResult> {
  const fail = (message: string): PrCreateResult => ({ ok: false, message });
  const title = (opts.title ?? '').trim();
  if (!title) return fail('A title is required: origin pr create --title "<title>"');
  if (opts.body !== undefined && opts.bodyFile !== undefined) return fail('Pass --body or --body-file, not both.');
  let body = opts.body ?? '';
  if (opts.bodyFile !== undefined) {
    try { body = deps.readFile(opts.bodyFile); } catch (err: any) { return fail(`Could not read ${opts.bodyFile}: ${err?.message ?? err}`); }
  }
  if (!deps.connected()) return fail('Not signed in to Origin. Run `origin login` first.');
  const root = deps.repoRoot(cwd);
  if (!root) return fail('Not inside a git repository.');
  const head = (opts.head ?? '').trim() || deps.currentBranch(root);
  if (!head) return fail('Not on a branch. Check out the branch to open the pull request from, or pass --head <branch>.');
  if (opts.base && opts.base.trim() === head) return fail(`--base and the branch are both ${head}.`);
  if (deps.branchOnRemote(root, head) === false) {
    return fail(`${head} is not on the remote yet. Push it first: git push -u origin ${head}`);
  }

  let repoId: string | undefined;
  try {
    const remote = deps.remoteUrl(root);
    const route = await deps.previewRoute({ repoPath: root, ...(remote ? { repoUrl: remote } : {}) });
    repoId = route?.repo?.id;
  } catch (err: any) {
    return fail(`Could not reach Origin: ${err?.message ?? err}`);
  }
  if (!repoId) return fail('This repo is not on Origin yet.');

  try {
    const res = await deps.openPullRequest(repoId, {
      head, ...(opts.base?.trim() ? { base: opts.base.trim() } : {}), title, body, draft: opts.draft === true,
    });
    const id = typeof res?.id === 'string' ? res.id : '';
    if (!id) return fail('Origin opened the pull request but did not say which one.');
    const url = `${deps.appUrl().replace(/\/$/, '')}/pull-requests/${id}`;
    return { ok: true, id, number: Number(res.number), url, hostUrl: typeof res.url === 'string' ? res.url : null };
  } catch (err: any) {
    return fail(`Origin could not open the pull request: ${err?.serverMessage || err?.message || err}`);
  }
}

async function defaultDeps(): Promise<PrCreateDeps> {
  const [{ api }, { isConnectedMode, loadConfig }, { execFileSync }] = await Promise.all([
    import('../api.js'), import('../config.js'), import('child_process'),
  ]);
  const git = (root: string, args: string[]): string | null => {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim(); } catch { return null; }
  };
  return {
    connected: isConnectedMode,
    repoRoot: (cwd) => git(cwd, ['rev-parse', '--show-toplevel']) || null,
    currentBranch: (root) => {
      const b = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      return b || null;
    },
    remoteUrl: (root) => git(root, ['remote', 'get-url', 'origin']) || null,
    branchOnRemote: (root, branch) => {
      const out = git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
      return out === null ? null : out.length > 0;
    },
    readFile: (file) => file === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(file, 'utf-8'),
    previewRoute: api.previewRoute,
    openPullRequest: api.openPullRequest,
    appUrl: () => loadConfig()?.apiUrl || 'https://getorigin.io',
    out: (s) => console.log(s),
  };
}

export async function prCreateCommand(opts: PrCreateOptions, injected?: PrCreateDeps): Promise<void> {
  const deps = injected ?? await defaultDeps();
  const result = await prCreate(opts, process.cwd(), deps);
  if (opts.json) {
    deps.out(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    console.error(chalk.red(result.message));
    process.exitCode = 1;
    return;
  }
  deps.out(`Opened pull request #${result.number}: ${result.url}`);
}
