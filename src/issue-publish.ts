// After a Start run: push the issue's branch and open its pull request.
//
// An agent started from an issue commits on the issue's branch and stops
// there. None of them pushes, so the fix sat on one machine and the issue
// waited in "in progress" for a merge nobody could make (e31db5e2,
// 2026-10-13: Codex committed bd01843 in its worktree; the branch was never
// pushed). When the agent exits cleanly, Origin pushes the branch and, on
// GitHub, opens the pull request through `gh` — or finds the one already
// open. It never merges and never force-pushes.
import { execFileSync } from 'child_process';

export interface PublishInput {
  /** The run's checkout (its worktree, or the repo it ran in). */
  cwd: string;
  branch: string;
  shortId: string;
  title: string;
  agent: string;
  /** A review fix: the pull request the branch already belongs to. */
  pullRequest?: number | null;
  /** The GitHub / GitLab issue it came from: a GitHub one gets `Fixes #N`. */
  hostIssue?: { provider: 'github' | 'gitlab'; number: number } | null;
}

export type PublishResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'pushed'; note: string }
  | { kind: 'pr'; url: string; created: boolean };

export interface Exec {
  (cmd: string, args: string[], cwd: string, timeoutMs?: number): { ok: boolean; stdout: string; stderr: string };
}

const defaultExec: Exec = (cmd, args, cwd, timeoutMs = 60_000) => {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd, encoding: 'utf-8', windowsHide: true, timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Never stop to ask: nobody is at a background run's terminal.
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (err: any) {
    return { ok: false, stdout: String(err?.stdout ?? '').trim(), stderr: String(err?.stderr ?? err?.message ?? '').trim() };
  }
};

/** `owner/repo` of a github.com remote URL, else null. Pure. */
export function githubRepoOf(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function lastLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'no output';
}

/** The pull request's body. Pure. */
export function pullRequestBody(input: PublishInput, commits: string[]): string {
  const lines: string[] = [];
  if (input.hostIssue?.provider === 'github') lines.push(`Fixes #${input.hostIssue.number}`, '');
  lines.push(`Origin issue \`${input.shortId}\`: ${input.title}`, '');
  if (commits.length) lines.push('Commits:', ...commits.map((c) => `- ${c}`), '');
  lines.push(`Opened by Origin after a ${input.agent} run started from the issue. Review it before merging.`);
  return lines.join('\n');
}

/** Push the run's branch and open (or find) its pull request. Never throws. */
export function publishIssueBranch(input: PublishInput, exec: Exec = defaultExec): PublishResult {
  try {
    const git = (args: string[], timeoutMs?: number) => exec('git', args, input.cwd, timeoutMs);

    const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!head.ok) return { kind: 'skipped', reason: 'not a git checkout' };
    if (head.stdout !== input.branch) return { kind: 'skipped', reason: `the checkout is on ${head.stdout}, not ${input.branch}` };
    const remote = git(['remote', 'get-url', 'origin']);
    if (!remote.ok || !remote.stdout) return { kind: 'skipped', reason: 'the repo has no origin remote' };

    // The default branch, as the remote names it.
    let baseName = '';
    const sym = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (sym.ok && sym.stdout) baseName = sym.stdout.replace(/^origin\//, '');
    if (!baseName) baseName = ['main', 'master'].find((b) => git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]).ok) || '';
    if (!baseName) return { kind: 'skipped', reason: 'could not tell the default branch' };
    if (baseName === input.branch) return { kind: 'skipped', reason: `${input.branch} is the default branch` };

    const log = git(['log', '--format=%s (%h)', `origin/${baseName}..HEAD`]);
    const commits = log.ok && log.stdout ? log.stdout.split('\n').filter(Boolean) : [];
    if (commits.length === 0) return { kind: 'skipped', reason: `no commits on ${input.branch} beyond ${baseName}` };

    const push = git(['push', '-u', 'origin', input.branch], 120_000);
    if (!push.ok) return { kind: 'skipped', reason: `git push failed: ${lastLine(push.stderr)}` };

    if (input.pullRequest) return { kind: 'pushed', note: `pushed ${input.branch}; pull request #${input.pullRequest} updates` };
    const repo = githubRepoOf(remote.stdout);
    if (!repo) return { kind: 'pushed', note: `pushed ${input.branch}; not a GitHub repo, so open its pull request by hand` };
    const gh = (args: string[]) => exec('gh', args, input.cwd);

    const open = gh(['pr', 'list', '--repo', repo, '--head', input.branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // empty']);
    if (!open.ok) return { kind: 'pushed', note: `pushed ${input.branch}; gh is missing or not signed in, so open its pull request by hand` };
    if (open.stdout) return { kind: 'pr', url: open.stdout, created: false };

    const title = commits.length === 1
      ? commits[0].replace(/ \([0-9a-f]+\)$/, '')
      : `${input.title.replace(/\s+/g, ' ').trim().slice(0, 200)} (${input.shortId})`;
    const created = gh(['pr', 'create', '--repo', repo, '--base', baseName, '--head', input.branch, '--title', title, '--body', pullRequestBody(input, commits)]);
    const url = created.stdout.split('\n').map((l) => l.trim()).find((l) => /^https?:\/\//.test(l));
    if (!created.ok || !url) return { kind: 'pushed', note: `pushed ${input.branch}; gh pr create failed: ${lastLine(created.stderr || created.stdout)}` };
    return { kind: 'pr', url, created: true };
  } catch (err: any) {
    return { kind: 'skipped', reason: err?.message || String(err) };
  }
}

/** One line for the run's log and the issue's Start dialog. Pure. */
export function describePublish(r: PublishResult): string {
  if (r.kind === 'pr') return `${r.created ? 'Opened' : 'Pushed to'} pull request ${r.url}`;
  if (r.kind === 'pushed') return r.note.charAt(0).toUpperCase() + r.note.slice(1);
  return `Did not push: ${r.reason}`;
}
