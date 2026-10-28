// `origin issue start <id>` — hand an issue to an agent.
//
//   1. Resolve the issue: the API (by shortId, in the org this repo's captures
//      go to), else this repo's `.origin/issues`, else an open repo-memory TODO.
//   2. Check out `issue/<shortId>-<slug>` from the default branch — refused on
//      a dirty tree, never stashed (`--no-branch` stays where you are).
//   3. Build the prompt (issue-prompt.ts, shared with the API's /prompt route)
//      with the slice of repo memory that bears on the issue.
//   4. Leave a one-shot link in this checkout so the agent's session links
//      itself to the issue when it starts (issue-link.ts).
//   5. Launch the agent with argv (never a shell string), or print the prompt
//      for an editor agent / a missing binary.
import chalk from 'chalk';
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { freshAgentEnv, headlessAgentEnv } from '../agent-env.js';
import { antigravityBackgroundNote, createBackgroundProject, removeBackgroundProject } from '../antigravity-scope.js';
import { cursorBackgroundNote, removeCursorScope, writeCursorScope } from '../cursor-scope.js';
import { DEFAULT_BACKGROUND_TIMEOUT_MIN } from '../background-supervisor.js';
import {
  ISSUE_AGENTS, issueBusy, type IssueBusy, agentBackgroundArgv, agentLaunchArgv, buildIssuePrompt, buildPreflightPrompt, buildResumePrompt, isIssueAgent, issueBranchName, mentionedPaths, PREFLIGHT_AGENTS,
  type IssueAgent,
} from '../issue-prompt.js';
import { writePendingIssueLink } from '../issue-link.js';
import { describePublish, publishIssueBranch, type PublishInput } from '../issue-publish.js';
import { launchTarget } from '../windows-shim.js';
import { askInTerminal, pickResume, questionsOf, runPreflight, sessionOnThisComputer, type IssueQuestion, type PreflightResult } from '../issue-clarify.js';

export interface ResolvedIssue {
  shortId: string;
  title: string;
  description?: string | null;
  type?: string | null;
  status?: string | null;
  /** Where it was found. */
  origin: 'api' | 'local' | 'memory-todo';
  /** API repo id, when the issue lives on the API. */
  repoId?: string | null;
  /** The repo-memory TODO id this issue is, if any. */
  memoryTodoId?: string | null;
  /** A review fix: the branch of the pull request it updates. */
  workBranch?: string | null;
  /** …and that pull request's number. */
  pullRequest?: number | null;
  /** The GitHub / GitLab issue it was imported from: the prompt names it #<number>. */
  hostIssue?: { provider: 'github' | 'gitlab'; number: number; url?: string | null } | null;
  /** The epic (or parent) it is part of, and for an epic its own issues — as the API serves them. */
  parent?: { shortId: string; title: string; type?: string | null } | null;
  children?: Array<{ shortId: string; title: string; status: string }>;
  /** A prompt a person edited on the issue page: handed over as written. */
  agentPrompt?: string | null;
  /** Who is already on it (API issues): a live session, or a run that hasn't ended. */
  busy?: IssueBusy[];
  /** What agents asked about it and what people answered, oldest first (API issues). */
  questions?: IssueQuestion[];
  /** The Origin session of the issue's newest run; null = it linked none; undefined = not known. */
  latestRunSessionId?: string | null;
}

export interface IssueStartOptions {
  agent?: string;
  branch?: string | boolean; // commander: --no-branch sets branch=false
  /** Work in a linked worktree: true = the default place beside the repo, a string = that path. */
  worktree?: string | boolean;
  /** Run the agent headless, detached, output to a log — no terminal. Implies --worktree. */
  background?: boolean;
  /** A background run's time limit in minutes (default 120); 0 = none. */
  timeout?: string | number;
  /** commander: --no-publish sets false. When the agent exits cleanly, push its branch and open the PR. */
  publish?: boolean;
  /** Start even though someone is already on the issue. */
  force?: boolean;
  /** commander: --no-resume sets false. A background run goes on with the agent session that stopped on a question, once it is answered. */
  resume?: boolean;
  /** commander: --no-preflight sets false. A background run first checks the issue against the code, and asks what it can't settle. */
  preflight?: boolean;
  /** One arm of `origin issue race`: work on `<issue branch>-<suffix>` (not a CLI flag). */
  branchSuffix?: string;
  json?: boolean;
}

/** Everything that touches the world, so tests can stand in for it. */
export interface IssueStartDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  log: (line: string) => void;
  error: (line: string) => void;
  connected: () => boolean;
  api: {
    previewRoute: (data: { repoPath: string; repoUrl?: string }) => Promise<any>;
    getIssue: (repoId: string, shortId: string) => Promise<any>;
    updateIssue: (repoId: string, shortId: string, data: Record<string, unknown>) => Promise<any>;
    /** Optional: reports the run to the issue's Start dialog. */
    startIssueRun?: (repoId: string, shortId: string, data: { agent: string; branch: string | null; background: boolean; hostname: string }) => Promise<any>;
    endIssueRun?: (repoId: string, shortId: string, runId: string, data: { status: 'done' | 'failed' | 'timed_out'; exitCode: number; detail: string | null }) => Promise<any>;
    /** Optional: puts the pre-start pass's questions (answered or not) on the issue. */
    postIssueQuestions?: (repoId: string, shortId: string, data: { questions: Array<{ question: string; answer: string | null }>; agent: string }) => Promise<any>;
  } | null;
  memoryLines: (repoPath: string, issue: ResolvedIssue) => string[];
  openTodos: (repoPath: string) => Array<{ id: string; text: string }>;
  /** Runs the agent; resolves with its exit code. */
  run: (bin: string, args: string[], cwd: string) => Promise<number>;
  /**
   * Starts the run's supervisor detached (`origin issue run-supervise
   * <record>`, background-supervisor.ts): it runs the agent, enforces the time
   * limit and ends the run's Origin session. Returns the supervisor's pid.
   */
  spawnBackground: (record: string, cwd: string, self: [string, string]) => number;
  /** How the run's supervisor runs this CLI again: node, then the entry script. */
  self: [string, string];
  /** Where background runs keep their logs and records. */
  runsDir: string;
  /** Pushes the run's branch and opens its pull request (issue-publish.ts); returns one line saying what it did. */
  publish: (input: PublishInput) => string;
  copy: (text: string) => boolean;
  /**
   * Optional: is `agent` signed in on this computer? false = signed out,
   * null = can't tell. A background run has nobody to answer a login prompt.
   */
  signedIn?: (agent: IssueAgent) => Promise<boolean | null>;
  /** Optional: the pre-start pass (issue-clarify.ts). Null = it could not tell; the run starts without it. */
  preflight?: (agent: IssueAgent, prompt: string, cwd: string, exe: string) => Promise<PreflightResult | null>;
  /** Optional: asks one question in the terminal; null = no terminal, or no answer. */
  ask?: (question: string) => Promise<string | null>;
  /** Optional: is that agent session on this computer, so a resume can find it? */
  hasSession?: (agent: IssueAgent, agentSessionId: string, work: string) => Promise<boolean>;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function gitOk(args: string[], cwd: string): boolean {
  try { git(args, cwd); return true; } catch { return false; }
}

export function toplevel(cwd: string): string | null {
  try { return git(['rev-parse', '--show-toplevel'], cwd) || null; } catch { return null; }
}

/** The main checkout when `cwd` is a linked worktree — where `.origin/issues` lives. */
export function canonicalRoot(work: string): string {
  try {
    const common = git(['rev-parse', '--git-common-dir'], work);
    const abs = path.isAbsolute(common) ? common : path.resolve(work, common);
    if (path.basename(abs) === '.git') return path.dirname(abs);
  } catch { /* fall through */ }
  return work;
}

// ── Issue resolution ────────────────────────────────────────────────────────

const HEX8 = /^[0-9a-f]{8}$/;

function memoryTodoIdFor(issue: { shortId: string; source?: string | null; title: string; description?: string | null }, todos: Array<{ id: string; text: string }>): string | null {
  if (issue.source !== 'memory') return null;
  // A memory issue's shortId IS the TODO's id, except when two texts collided
  // on it and the sync fell back to `mem-<hash>` — then match the text.
  if (HEX8.test(issue.shortId)) return issue.shortId;
  const text = (issue.description || issue.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return todos.find((t) => t.text.trim().toLowerCase().replace(/\s+/g, ' ') === text)?.id ?? null;
}

/** An API issue imported from GitHub / GitLab, as the prompt names it. */
function hostIssueOf(it: any): ResolvedIssue['hostIssue'] {
  return (it?.provider === 'github' || it?.provider === 'gitlab') && typeof it.hostNumber === 'number'
    ? { provider: it.provider, number: it.hostNumber, url: typeof it.hostUrl === 'string' ? it.hostUrl : null }
    : null;
}

/** An issue as the API serves it. */
function apiIssue(it: any, repoId: string): ResolvedIssue {
  return {
    shortId: it.shortId, title: it.title, description: it.description, type: it.type, status: it.status,
    origin: 'api', repoId,
    // A review fix: the PR it updates, and that PR's branch.
    workBranch: typeof it.workBranch === 'string' ? it.workBranch : null,
    pullRequest: typeof it.workPrNumber === 'number' ? it.workPrNumber : null,
    hostIssue: hostIssueOf(it),
    // The epic it is part of, and an epic's own issues (the API's `parent` / `childIssues`).
    parent: it?.parent && typeof it.parent.shortId === 'string'
      ? { shortId: it.parent.shortId, title: String(it.parent.title ?? ''), type: typeof it.parent.type === 'string' ? it.parent.type : null }
      : null,
    children: Array.isArray(it?.childIssues)
      ? it.childIssues.filter((c: any) => c && typeof c.shortId === 'string').map((c: any) => ({ shortId: c.shortId, title: String(c.title ?? ''), status: String(c.status ?? 'open') }))
      : [],
    agentPrompt: typeof it.agentPrompt === 'string' && it.agentPrompt.trim() ? it.agentPrompt : null,
    busy: issueBusy(it, Date.now()),
    questions: questionsOf(it),
    latestRunSessionId: Array.isArray(it?.runs) ? (it.runs.length > 0 ? (typeof it.runs[0]?.sessionId === 'string' ? it.runs[0].sessionId : null) : undefined) : undefined,
  };
}

/** Why Origin could not be asked, when it couldn't: resolveIssue fills it in. */
export interface IssueLookup {
  originUnreachable?: string;
}

/** An API error in words: a timeout reads as one, not as the raw abort message. */
function apiFailure(err: any): string {
  const msg = String(err?.message || err || 'no answer');
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /operation was aborted|timed? ?out/i.test(msg)) return 'it did not answer in time';
  return err?.status ? `HTTP ${err.status}: ${msg}` : msg;
}

export async function resolveIssue(
  id: string,
  roots: { work: string; canonical: string },
  deps: Pick<IssueStartDeps, 'api' | 'connected' | 'openTodos' | 'error'>,
  lookup: IssueLookup = {},
): Promise<ResolvedIssue | null> {
  let todos: Array<{ id: string; text: string }> | null = null;
  const loadTodos = () => {
    if (todos) return todos;
    try { todos = deps.openTodos(roots.canonical); } catch { todos = []; }
    return todos;
  };

  // 1. The API, in the org this repo's captures go to.
  let repoId: string | null = null;
  if (deps.api && deps.connected()) {
    try {
      let remote = '';
      try { remote = git(['remote', 'get-url', 'origin'], roots.canonical); } catch { /* no remote */ }
      const route = await deps.api.previewRoute({ repoPath: roots.canonical, ...(remote ? { repoUrl: remote } : {}) });
      repoId = route?.repo?.id ?? null;
    } catch (err: any) {
      // Offline, slow or an older server: look locally, and say so if that finds nothing.
      lookup.originUnreachable = apiFailure(err);
    }
    if (repoId) {
      try {
        const it = await deps.api.getIssue(repoId, id);
        if (it && typeof it.shortId === 'string') {
          return { ...apiIssue(it, repoId), memoryTodoId: memoryTodoIdFor(it, it.source === 'memory' ? loadTodos() : []) };
        }
      } catch (err: any) {
        // A 404 is an answer (no such issue there); anything else — a timeout
        // included — means Origin was not really asked.
        if (err?.status !== 404) {
          lookup.originUnreachable = apiFailure(err);
          deps.error(chalk.yellow(`Could not read ${id} from Origin (${lookup.originUnreachable}); looking locally.`));
        }
      }
    }
  }

  // 2. This repo's local issue store (`origin issue create`).
  const dir = path.join(roots.canonical, '.origin', 'issues');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const exact = files.find((f) => f === `${id}.json`);
    const pick = exact ?? files.find((f) => f.startsWith(id));
    if (pick) {
      const it = JSON.parse(fs.readFileSync(path.join(dir, pick), 'utf-8'));
      return { shortId: it.id, title: it.title, description: it.description, type: it.type, status: it.status, origin: 'local' };
    }
  } catch { /* no local store */ }

  // 3. An open repo-memory TODO (the id `origin todo list` prints).
  const todo = loadTodos().find((t) => t.id === id) ?? loadTodos().find((t) => t.id.startsWith(id));
  if (todo) {
    // Synced to the API as an issue under the same id? Then the session links there.
    if (repoId && deps.api && todo.id !== id) {
      try {
        const it = await deps.api.getIssue(repoId, todo.id);
        if (it && typeof it.shortId === 'string') {
          return { ...apiIssue(it, repoId), memoryTodoId: todo.id };
        }
      } catch { /* not synced yet */ }
    }
    const title = todo.text.length > 200 ? `${todo.text.slice(0, 197)}…` : todo.text;
    return {
      shortId: todo.id, title, description: todo.text.length > 200 ? todo.text : null,
      origin: 'memory-todo', memoryTodoId: todo.id,
    };
  }
  return null;
}

// ── Branch ──────────────────────────────────────────────────────────────────

/** Tracked changes only: untracked files survive a checkout untouched. */
export function trackedChanges(cwd: string): string[] {
  const out = git(['status', '--porcelain', '--untracked-files=no'], cwd);
  return out ? out.split('\n').filter(Boolean) : [];
}

export function defaultBaseRef(cwd: string): string {
  let name = '';
  try { name = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).replace(/^origin\//, ''); } catch { /* no remote HEAD */ }
  const candidates = name ? [name] : ['main', 'master'];
  // A new branch starts from the default branch as it is now, not as this
  // clone last fetched it: an agent on a stale base redoes merged work.
  for (const b of candidates) {
    if (gitOk(['fetch', '--quiet', 'origin', `refs/heads/${b}:refs/remotes/origin/${b}`], cwd)) break;
  }
  for (const b of candidates) {
    if (gitOk(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], cwd)) return `origin/${b}`;
    if (gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], cwd)) return b;
  }
  return 'HEAD';
}

/**
 * Put the checkout on the issue's branch: create it from the default branch,
 * or switch to it when an earlier start already made it. Throws with a
 * message the user can act on; never stashes.
 */
export function checkoutIssueBranch(cwd: string, branch: string): { created: boolean; base: string | null } {
  if (!gitOk(['check-ref-format', '--branch', branch], cwd)) {
    throw new Error(`"${branch}" is not a valid branch name.`);
  }
  let current = '';
  try { current = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd); } catch { /* unborn */ }
  if (current === branch) return { created: false, base: null };
  const dirty = trackedChanges(cwd);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).map((l) => `    ${l}`).join('\n');
    throw new Error(
      `This checkout has uncommitted changes, so Origin won't switch it to ${branch}:\n${shown}` +
      `${dirty.length > 5 ? `\n    … and ${dirty.length - 5} more` : ''}\n` +
      `  Commit or set them aside yourself, run again with --worktree to work on it in a separate checkout,\n` +
      `  or with --no-branch to start on ${current || 'the current branch'}.`,
    );
  }
  if (gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd)) {
    git(['checkout', branch], cwd);
    return { created: false, base: null };
  }
  // The branch may exist only on the remote — a pull request's branch, for a
  // fix asked for in its review. Track it: creating it from the default branch
  // would start a second branch of the same name with none of the PR's work.
  gitOk(['fetch', '--quiet', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`], cwd);
  if (gitOk(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], cwd)) {
    if (!gitOk(['checkout', '--track', '-b', branch, `origin/${branch}`], cwd)) {
      // A single-branch clone's fetch refspec doesn't cover this branch, so
      // git won't call it a tracking branch. Set the upstream by hand.
      git(['checkout', '--no-track', '-b', branch, `origin/${branch}`], cwd);
      git(['config', `branch.${branch}.remote`, 'origin'], cwd);
      git(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], cwd);
    }
    return { created: false, base: `origin/${branch}` };
  }
  const base = defaultBaseRef(cwd);
  git(['checkout', '--no-track', '-b', branch, base], cwd);
  return { created: true, base };
}

// ── Worktree ────────────────────────────────────────────────────────────────

/** Where `--worktree` puts an issue's checkout: `<repo>-worktrees/<branch>` beside the repo. */
export function issueWorktreePath(canonical: string, branch: string): string {
  const leaf = branch.replace(/^issue\//, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'issue';
  return path.join(path.dirname(canonical), `${path.basename(canonical)}-worktrees`, leaf);
}

/** The worktree `branch` is checked out in, if any. */
export function worktreeOfBranch(cwd: string, branch: string): string | null {
  let out = '';
  try { out = git(['worktree', 'list', '--porcelain'], cwd); } catch { return null; }
  let at: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && at) return at;
  }
  return null;
}

/**
 * A separate checkout of the issue's branch, so the agent never needs this
 * one clean and agents on different issues don't share a working tree. The
 * branch's existing worktree when it has one; else a new one at `at`, on the
 * local branch, the remote one (a PR's branch, tracked), or a new branch from
 * the default branch.
 */
export function worktreeForIssueBranch(canonical: string, branch: string, at?: string | null): { path: string; created: boolean; base: string | null; reused: boolean } {
  if (!gitOk(['check-ref-format', '--branch', branch], canonical)) {
    throw new Error(`"${branch}" is not a valid branch name.`);
  }
  // A worktree folder deleted by hand stays registered until pruned: it would
  // be "reused" at a path that is gone, and block adding one for the branch.
  gitOk(['worktree', 'prune'], canonical);
  const existing = worktreeOfBranch(canonical, branch);
  if (existing) return { path: existing, created: false, base: null, reused: true };

  const target = path.resolve(at || issueWorktreePath(canonical, branch));
  let entries: string[] = [];
  try { entries = fs.readdirSync(target); } catch { /* not there: good */ }
  if (entries.length > 0) throw new Error(`${target} already exists and is not a worktree of ${branch}. Pass --worktree <path> to use another place.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], canonical)) {
    git(['worktree', 'add', target, branch], canonical);
    return { path: target, created: false, base: null, reused: false };
  }
  // A pull request's branch that exists only on the remote: track it.
  gitOk(['fetch', '--quiet', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`], canonical);
  if (gitOk(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], canonical)) {
    git(['worktree', 'add', '--no-track', '-b', branch, target, `origin/${branch}`], canonical);
    git(['config', `branch.${branch}.remote`, 'origin'], canonical);
    git(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], canonical);
    return { path: target, created: false, base: `origin/${branch}`, reused: false };
  }
  const base = defaultBaseRef(canonical);
  git(['worktree', 'add', '--no-track', '-b', branch, target, base], canonical);
  return { path: target, created: true, base, reused: false };
}

// ── Launch ──────────────────────────────────────────────────────────────────

/** The executable `bin` resolves to on PATH, or null. */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, bin + ext.toLowerCase());
      const P = path.join(d, bin + ext);
      for (const cand of platform === 'win32' ? [P, p] : [p]) {
        try {
          const st = fs.statSync(cand);
          if (!st.isFile()) continue;
          if (platform !== 'win32') fs.accessSync(cand, fs.constants.X_OK);
          return cand;
        } catch { /* keep looking */ }
      }
    }
  }
  return null;
}

function defaultCopy(text: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const tools: Array<[string, string[]]> = platform === 'darwin'
    ? [['pbcopy', []]]
    : platform === 'win32'
      ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [bin, args] of tools) {
    const exe = findOnPath(bin, env, platform);
    if (!exe) continue;
    try {
      const r = spawnSync(exe, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000, windowsHide: true });
      if (r.status === 0) return true;
    } catch { /* try the next one */ }
  }
  return false;
}

function defaultRun(bin: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // An npm-installed agent on Windows is a .cmd shim: run what it points at (windows-shim.ts).
    const t = launchTarget(bin, args);
    const child = spawn(t.file, t.args, { cwd, stdio: 'inherit', shell: false, env: freshAgentEnv(process.env) });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Start the run's supervisor, detached from this process (see background-supervisor.ts). */
function defaultSpawnBackground(record: string, cwd: string, self: [string, string]): number {
  const child = spawn(self[0], [self[1], 'issue', 'run-supervise', record], {
    cwd, detached: true, stdio: 'ignore', env: headlessAgentEnv(process.env), windowsHide: true,
  });
  child.unref();
  return child.pid ?? 0;
}

/** The repo's common .git: where a linked worktree's commits land. */
function commonGitDir(cwd: string): string {
  const d = git(['rev-parse', '--git-common-dir'], cwd);
  return path.isAbsolute(d) ? d : path.resolve(cwd, d);
}

/** Repo memory that bears on the issue: entries touching the paths it names, then a history search on its title. */
export function defaultMemoryLines(repoPath: string, issue: ResolvedIssue): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (l: string) => {
    const k = l.toLowerCase();
    if (!l.trim() || seen.has(k)) return;
    seen.add(k);
    lines.push(l);
  };
  const paths = mentionedPaths(`${issue.title}\n${issue.description || ''}`);
  try {
    if (paths.length > 0) {
      const { getRepoMemory } = requireMemory();
      const mem = getRepoMemory({ repoPath, paths, includeDetail: true, sessionLimit: 5, commitLimit: 5 });
      for (const s of [...mem.sessions].reverse()) {
        for (const d of ((s.decisions as unknown[]) || []).slice(0, 3)) {
          const text = typeof d === 'string' ? d : (d as any)?.text;
          if (text) add(`Decision (${s.sessionId}): ${text}`);
        }
        if (s.summary) add(`Session ${s.sessionId} (${s.agent || 'agent'}${s.endedAt ? `, ${String(s.endedAt).slice(0, 10)}` : ''}) on ${((s.files as string[]) || []).slice(0, 3).join(', ')}: ${s.summary}`);
      }
    }
  } catch { /* no memory — the prompt goes without */ }
  try {
    const { searchHistory } = requireHistory();
    const res = searchHistory(repoPath, issue.title, { limit: 5 });
    for (const h of res.hits) {
      if (h.todoId && h.todoId === issue.memoryTodoId) continue; // the issue itself
      add(`${h.kind}${h.sessionId ? ` ${h.sessionId.slice(0, 8)}` : ''}: ${h.title}${h.snippet && h.snippet !== h.title ? ` — ${h.snippet}` : ''}${h.files?.length ? ` (${h.files.slice(0, 3).join(', ')})` : ''}`);
    }
  } catch { /* no history */ }
  return lines;
}

// The memory readers are synchronous modules; loaded once, on first use.
let memoryMod: typeof import('../mcp/repo-memory.js') | null = null;
let historyMod: typeof import('../history-search.js') | null = null;
function requireMemory() { if (!memoryMod) throw new Error('memory module not loaded'); return memoryMod; }
function requireHistory() { if (!historyMod) throw new Error('history module not loaded'); return historyMod; }
export async function loadMemoryModules(): Promise<void> {
  try { memoryMod = await import('../mcp/repo-memory.js'); } catch { memoryMod = null; }
  try { historyMod = await import('../history-search.js'); } catch { historyMod = null; }
}

async function defaultDeps(): Promise<IssueStartDeps> {
  await loadMemoryModules();
  const [{ api }, { isConnectedMode }, { getOpenTodos }] = await Promise.all([
    import('../api.js'), import('../config.js'), import('../todo.js'),
  ]);
  return {
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    connected: isConnectedMode,
    api: { previewRoute: api.previewRoute, getIssue: api.getIssue, updateIssue: api.updateIssue, startIssueRun: api.startIssueRun, endIssueRun: api.endIssueRun, postIssueQuestions: api.postIssueQuestions },
    memoryLines: defaultMemoryLines,
    openTodos: (repoPath) => getOpenTodos(repoPath).map((t) => ({ id: t.id, text: t.text })),
    run: defaultRun,
    spawnBackground: defaultSpawnBackground,
    self: [process.execPath, path.resolve(process.argv[1] || '')],
    runsDir: path.join(os.homedir(), '.origin', 'agent-runs'),
    copy: (text) => defaultCopy(text, process.env, process.platform),
    publish: (input) => describePublish(publishIssueBranch(input)),
    signedIn: defaultSignedIn,
    preflight: (agent, prompt, cwd, exe) => runPreflight(agent, prompt, cwd, exe),
    ask: (q) => askInTerminal(q),
    hasSession: (agent, id, work) => sessionOnThisComputer(agent, id, work),
  };
}

/** The Agents page's own sign-in probe (agent-setup.ts); unknown agents and errors are "can't tell". */
async function defaultSignedIn(agent: IssueAgent): Promise<boolean | null> {
  try {
    const { isSetupAgent, probeAgent, defaultProbeDeps } = await import('../agent-setup.js');
    if (!isSetupAgent(agent)) return null;
    return (await probeAgent(agent, defaultProbeDeps())).signedIn;
  } catch { return null; }
}

// ── The command ─────────────────────────────────────────────────────────────

export interface IssueStartResult {
  issue: ResolvedIssue;
  branch: string | null;
  prompt: string;
  agent: IssueAgent;
  /** What ran: the argv, or null when the prompt was printed instead. */
  launched: string[] | null;
  promptFile: string | null;
  linkFile: string | null;
  /** The worktree the agent ran in, with --worktree. */
  worktree: string | null;
  /** A --background run: its pid and log. */
  background?: { pid: number; log: string; record: string } | null;
  /** What publishing the branch did after a clean foreground run (describePublish); null when nothing was published. */
  published?: string | null;
  exitCode: number;
}

export async function issueStartCommand(
  id: string,
  opts: IssueStartOptions = {},
  injected?: Partial<IssueStartDeps>,
): Promise<IssueStartResult | null> {
  const deps: IssueStartDeps = { ...(await defaultDeps()), ...(injected || {}) };
  const agent = (opts.agent || 'claude').toLowerCase();
  if (!isIssueAgent(agent)) {
    deps.error(chalk.red(`Unknown agent "${opts.agent}". Use one of: ${ISSUE_AGENTS.join(', ')}.`));
    process.exitCode = 2;
    return null;
  }

  let work = toplevel(deps.cwd);
  if (!work) {
    deps.error(chalk.red('Not inside a git repository.'));
    process.exitCode = 1;
    return null;
  }
  const roots = { work, canonical: canonicalRoot(work) };

  // `#123` names a GitHub / GitLab issue by its number, which is its shortId.
  id = id.replace(/^#(?=\d+$)/, '');
  const lookup: IssueLookup = {};
  const issue = await resolveIssue(id, roots, deps, lookup);
  if (!issue) {
    if (lookup.originUnreachable) {
      // Not "no such issue": Origin was never really asked (2026-10-13: a cold
      // route lookup took 41 s, past the request timeout, and this said "No
      // issue matches" for an issue that was there).
      deps.error(chalk.red(`Could not look up "${id}" on Origin: ${lookup.originUnreachable}.`) + chalk.gray(' It is not in .origin/issues or repo memory either. Try again in a moment; `origin status` shows whether Origin is reachable.'));
    } else {
      deps.error(chalk.red(`No issue or open TODO matches "${id}".`) + chalk.gray(' (looked on Origin, in .origin/issues and in repo memory)'));
    }
    process.exitCode = 1;
    return null;
  }
  // Someone is already on it: two agents on one issue duplicate the work and
  // fight over its branch. The web's Start dialog warns and passes --force
  // when the person starts anyway; a terminal start says who and stops.
  if (!opts.force && issue.busy && issue.busy.length > 0) {
    for (const b of issue.busy) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(b.since)) / 60_000));
      deps.error(chalk.yellow(`${b.who === 'You' ? 'You already started' : `${b.who} is already working on ${issue.shortId} with`} ${b.agent} (${mins} min ago)${b.sessionId ? ` — session ${b.sessionId.slice(0, 8)}` : ''}.`));
    }
    deps.error(chalk.gray(`Run again with --force to start another agent on ${issue.shortId} anyway.`));
    process.exitCode = 1;
    return null;
  }
  // The next "Start" from the web finds this checkout for this repo.
  if (issue.repoId) {
    try { (await import('../url-handler.js')).rememberCheckout(issue.repoId, roots.canonical); } catch { /* best-effort */ }
  }
  if (issue.status === 'closed') {
    deps.error(chalk.yellow(`${issue.shortId} is closed — starting on it anyway.`));
  }

  // Branch: checked out here, or in its own worktree.
  let branch: string | null = null;
  let worktree: string | null = null;
  if (opts.background && agent === 'print') {
    deps.error(chalk.red('--background needs an agent to run; print only shows the prompt.'));
    process.exitCode = 2;
    return null;
  }
  // Checked before a worktree is made for it.
  const bgBin = opts.background ? agentBackgroundArgv(agent, '', '')?.[0] ?? null : null;
  if (bgBin && !findOnPath(bgBin, deps.env, deps.platform)) {
    deps.error(chalk.red(missingAgentHint(agent, bgBin)));
    process.exitCode = 1;
    return null;
  }
  // A signed-out agent exits at once ("Not logged in · Please run /login")
  // and the run's session looks finished. Stop here and say so on the issue.
  if (opts.background && deps.signedIn && (await deps.signedIn(agent)) === false) {
    const msg = `${agent} is not signed in on this computer. Sign in with \`origin agents login ${agent}\` (or Settings → Agents in Origin), then start again.`;
    deps.error(chalk.red(msg));
    if (issue.repoId && deps.api?.startIssueRun && deps.api.endIssueRun) {
      try {
        const r = await deps.api.startIssueRun(issue.repoId, issue.shortId, { agent, branch: null, background: true, hostname: os.hostname() });
        if (typeof r?.id === 'string') await deps.api.endIssueRun(issue.repoId, issue.shortId, r.id, { status: 'failed', exitCode: 1, detail: msg });
      } catch { /* the terminal line above still says it */ }
    }
    process.exitCode = 1;
    return null;
  }
  // A background run never shares a checkout: nobody is watching it.
  const wantWorktree = !!opts.background || (opts.worktree !== undefined && opts.worktree !== false);
  if (wantWorktree && opts.branch === false) {
    deps.error(chalk.red('--worktree needs a branch to check out; drop --no-branch.'));
    process.exitCode = 2;
    return null;
  }
  if (opts.branchSuffix) {
    // A race arm: its own branch beside the others. A review fix updates one
    // pull request's branch, so it has nothing to race on.
    if (issue.workBranch) {
      deps.error(chalk.red(`${issue.shortId} updates the branch of PR #${issue.pullRequest ?? '?'} (${issue.workBranch}); a race needs a branch per agent. Start one agent on it instead.`));
      process.exitCode = 2;
      return null;
    }
    branch = `${issueBranchName(issue.shortId, issue.title)}-${opts.branchSuffix}`;
  } else if (opts.branch !== false) {
    branch = typeof opts.branch === 'string' && opts.branch.trim()
      ? opts.branch.trim()
      : issue.workBranch || issueBranchName(issue.shortId, issue.title);
  }
  if (branch && wantWorktree) {
    try {
      const r = worktreeForIssueBranch(roots.canonical, branch, typeof opts.worktree === 'string' && opts.worktree.trim() ? opts.worktree.trim() : null);
      worktree = r.path;
      work = r.path;
      deps.log(r.reused
        ? chalk.green(`✓ ${chalk.bold(branch)} is already checked out in ${r.path} — working there`)
        : chalk.green(`✓ Worktree ${chalk.bold(r.path)} on ${r.created ? `new branch ${chalk.bold(branch)} from ${r.base}` : r.base ? `${chalk.bold(branch)}, tracking ${r.base}` : chalk.bold(branch)}`));
    } catch (err: any) {
      deps.error(chalk.red(err?.message || String(err)));
      process.exitCode = 1;
      return null;
    }
  } else if (branch) {
    try {
      const r = checkoutIssueBranch(work, branch);
      deps.log(r.created
        ? chalk.green(`✓ Created branch ${chalk.bold(branch)} from ${r.base}`)
        : r.base
          ? chalk.green(`✓ On branch ${chalk.bold(branch)}, tracking ${r.base}`)
          : chalk.green(`✓ On branch ${chalk.bold(branch)}`));
    } catch (err: any) {
      deps.error(chalk.red(err?.message || String(err)));
      process.exitCode = 1;
      return null;
    }
  }

  // Prompt: the one edited on the issue page, else built here.
  let memory: string[] = [];
  if (!issue.agentPrompt) {
    try { memory = deps.memoryLines(roots.canonical, issue); } catch { memory = []; }
  } else {
    deps.log(chalk.gray(`Using the prompt edited on Origin for ${issue.shortId}.`));
  }
  // The pull request this branch already updates, if any: then the run only pushes.
  const publishPr = branch && branch === issue.workBranch ? issue.pullRequest ?? null : null;
  let questions = issue.questions ?? [];
  const promptInput = (extra: { brief?: string | null } = {}) => ({
    shortId: issue.shortId, title: issue.title, description: issue.description, type: issue.type,
    branch, memoryTodoId: issue.memoryTodoId, memory, hostIssue: issue.hostIssue ?? null,
    parent: issue.parent ?? null, children: issue.children ?? [],
    // Push to the PR only when the agent is on that PR's branch.
    pullRequest: publishPr,
    // What earlier runs asked and people answered: the run starts from it.
    clarifications: questions,
    ...extra,
  });
  let prompt = issue.agentPrompt ?? buildIssuePrompt(promptInput());

  // A background run has nobody to ask (issue-clarify.ts). Go on with the
  // session that stopped on a question once it is answered; else check the
  // issue against the code first, and ask what can't be settled now.
  let resumeSessionId: string | null = null;
  // Not for a race arm: each arm would ask the same questions (issue-race.ts).
  if (opts.background && !opts.branchSuffix) {
    const resume = opts.resume === false ? null : pickResume(questions, agent, issue.latestRunSessionId);
    if (resume && deps.hasSession && (await deps.hasSession(agent, resume.agentSessionId, work))) {
      resumeSessionId = resume.agentSessionId;
      prompt = buildResumePrompt({ ...promptInput(), clarifications: resume.answers });
      deps.log(chalk.green(`✓ Going on with ${agent} session ${resume.agentSessionId.slice(0, 8)}, with your answer${resume.answers.length === 1 ? '' : 's'}`));
    } else if (resume) {
      deps.log(chalk.gray(`The ${agent} session that asked (${resume.agentSessionId.slice(0, 8)}) is not on this computer — starting fresh, with the answers in the prompt.`));
    }
    const pfBin = !resumeSessionId && opts.preflight !== false && !issue.agentPrompt && deps.preflight && (PREFLIGHT_AGENTS as readonly string[]).includes(agent)
      ? findOnPath(agent === 'claude' ? 'claude' : 'codex', deps.env, deps.platform)
      : null;
    if (pfBin && deps.preflight) {
      deps.log(chalk.gray(`Checking ${issue.shortId} against the code before starting (read-only; --no-preflight skips)…`));
      const pf = await deps.preflight(agent, buildPreflightPrompt(prompt), work, pfBin);
      if (!pf) {
        deps.log(chalk.gray('  The check did not answer — starting without it.'));
      } else {
        const asked: Array<{ question: string; answer: string | null }> = [];
        for (const q of pf.questions) {
          deps.log(chalk.cyan(`? ${q}`));
          const answer = deps.ask ? await deps.ask('  Your answer (empty = answer later on the issue):') : null;
          asked.push({ question: q, answer });
        }
        if (asked.length > 0) {
          let kept = false;
          if (issue.repoId && deps.api?.postIssueQuestions) {
            try {
              const r = await deps.api.postIssueQuestions(issue.repoId, issue.shortId, { questions: asked, agent });
              if (Array.isArray(r?.clarifications)) { questions = questionsOf(r); kept = true; }
            } catch { /* kept below for this run */ }
          }
          if (!kept) {
            questions = [...questions, ...asked.map((a, i) => ({ id: `local-${i}`, question: a.question, answer: a.answer, from: 'preflight' as const, agent, agentSessionId: null, sessionId: null }))];
          }
          const open = asked.filter((a) => !a.answer);
          if (open.length > 0) {
            deps.log(chalk.yellow(`${issue.shortId} needs ${open.length === 1 ? 'an answer' : `${open.length} answers`} before an agent can work on it alone — not starting.`));
            deps.log(chalk.gray(issue.repoId
              ? `  Answer on the issue in Origin, or: origin issue answer ${issue.shortId} "<answer>" — then start again.`
              : '  Add the answers to the issue, then start again.'));
            return null;
          }
        }
        if (pf.brief) deps.log(chalk.gray(`  ${pf.brief.split('\n')[0].slice(0, 160)}${pf.brief.includes('\n') ? ' …' : ''}`));
        prompt = buildIssuePrompt(promptInput({ brief: pf.brief || null }));
      }
    }
  }

  // Mark it started, and leave the link for the agent's session.
  if (issue.origin === 'api' && issue.repoId && deps.api && (issue.status === 'open' || issue.status === 'blocked')) {
    try { await deps.api.updateIssue(issue.repoId, issue.shortId, { status: 'in-progress' }); } catch { /* the link still lands */ }
  } else if (issue.origin === 'local') {
    markLocalInProgress(roots.canonical, issue.shortId);
  }
  let linkFile: string | null = null;
  const writeLink = (runId: string | null) => {
    if (issue.origin === 'memory-todo' && !issue.repoId) return;
    try {
      linkFile = writePendingIssueLink(work, {
        shortId: issue.shortId, repoId: issue.origin === 'api' ? issue.repoId : null,
        title: issue.title, branch, agent,
        // Always present: null tells the server this launch reported no run.
        runId,
      });
    } catch { linkFile = null; }
  };
  writeLink(null);

  // Tell the issue's Start dialog a run began (and, below, how it ended): before
  // this, a run that died before its agent's first hook left the page silent.
  const reportStart = async (background: boolean): Promise<string | null> => {
    if (!issue.repoId || !deps.api?.startIssueRun) return null;
    try {
      const r = await deps.api.startIssueRun(issue.repoId, issue.shortId, { agent, branch, background, hostname: os.hostname() });
      const id = typeof r?.id === 'string' ? r.id : null;
      // The agent is not launched yet: its session-start reads the link with
      // this run in it, and the server records the session on the run.
      if (id && linkFile) writeLink(id);
      return id;
    } catch { return null; }
  };

  // Background: headless and detached, in the worktree.
  if (opts.background) {
    // Antigravity: a project of the run's own scopes what it may do
    // (antigravity-scope.ts); it is removed when the run ends.
    const agyProject = agent === 'antigravity' && findOnPath('agy', deps.env, deps.platform)
      ? createBackgroundProject(work, `${issue.shortId} ${path.basename(work)}`)
      : null;
    // Cursor: a .cursor/cli.json in the run's worktree scopes its commands
    // (cursor-scope.ts); removed when the run ends.
    let cursorScope: string | null = null;
    if (agent === 'cursor' && findOnPath('cursor-agent', deps.env, deps.platform)) {
      try { cursorScope = writeCursorScope(work); } catch { cursorScope = null; }
    }
    const runPrompt = agyProject ? `${prompt}\n\n${antigravityBackgroundNote()}` : cursorScope ? `${prompt}\n\n${cursorBackgroundNote()}` : prompt;
    const bargv = agentBackgroundArgv(agent, runPrompt, commonGitDir(work), { antigravityProject: agyProject?.id, resumeSessionId });
    const bexe = bargv ? findOnPath(bargv[0], deps.env, deps.platform) : null;
    if (!bargv || !bexe) {
      removeBackgroundProject(agyProject?.file);
      removeCursorScope(cursorScope);
      deps.error(chalk.red(missingAgentHint(agent, bargv?.[0] ?? agent)));
      process.exitCode = 1;
      return null;
    }
    // A Windows shim the supervisor could not run without cmd.exe: say so now, not in a log.
    try { launchTarget(bexe, [], { platform: deps.platform, env: deps.env }); } catch (err: any) {
      removeBackgroundProject(agyProject?.file);
      deps.error(chalk.red(`Could not start ${bargv[0]} in the background: ${err?.message || err}.`));
      process.exitCode = 1;
      return null;
    }
    const timeoutMin = opts.timeout === undefined ? DEFAULT_BACKGROUND_TIMEOUT_MIN : Number(opts.timeout);
    if (!Number.isFinite(timeoutMin) || timeoutMin < 0) {
      deps.error(chalk.red(`--timeout takes minutes (0 for no limit), not "${opts.timeout}".`));
      process.exitCode = 2;
      return null;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(deps.runsDir, `${issue.shortId.replace(/[^A-Za-z0-9._-]+/g, '-')}-${agent}-${stamp}`);
    const log = `${base}.log`;
    const record = `${base}.json`;
    // The supervisor reads what to run, where and for how long from here.
    // repoId + serverRunId: the supervisor reports the end to the same run.
    const serverRunId = await reportStart(true);
    const run = {
      shortId: issue.shortId, title: issue.title, agent, pid: 0, log, worktree: work, branch,
      startedAt: new Date().toISOString(), timeoutMin, argv: [bexe, ...bargv.slice(1)],
      repoId: issue.repoId ?? null, serverRunId,
      // Read by the supervisor once the agent exits cleanly (issue-publish.ts).
      publish: opts.publish !== false, pullRequest: publishPr, hostIssue: issue.hostIssue ?? null,
      antigravityProjectFile: agyProject?.file ?? null,
      cursorScopeFile: cursorScope,
    };
    const writeRecord = () => { try { fs.writeFileSync(record, JSON.stringify(run, null, 2) + '\n'); } catch { /* the log is what matters */ } };
    fs.mkdirSync(deps.runsDir, { recursive: true });
    writeRecord();
    const pid = deps.spawnBackground(record, work, deps.self);
    run.pid = pid;
    writeRecord();
    deps.log(chalk.green(`✓ ${bargv[0]} is working on ${issue.shortId} in the background (pid ${pid})`));
    deps.log(chalk.gray(`  in ${work}`));
    deps.log(chalk.gray(`  log: ${log}`));
    deps.log(chalk.gray(timeoutMin > 0 ? `  stopped if still running after ${timeoutMin} min (--timeout)` : '  no time limit'));
    deps.log(chalk.gray('  `origin issue runs` lists background runs; the session shows on the issue in Origin.'));
    return { issue, branch, prompt, agent, launched: [bexe, ...bargv.slice(1)], promptFile: null, linkFile, worktree, background: { pid, log, record }, exitCode: 0 };
  }

  // Launch, or print.
  const argv = agentLaunchArgv(agent, prompt);
  const exe = argv ? findOnPath(argv[0], deps.env, deps.platform) : null;
  if (argv && exe) {
    deps.log(chalk.gray(`Starting ${argv[0]} on ${issue.shortId}…`));
    const serverRunId = await reportStart(false);
    let code = 0;
    let published: string | null = null;
    try {
      code = await deps.run(exe, argv.slice(1), work);
      if (code === 0 && branch && opts.publish !== false) {
        published = deps.publish({ cwd: work, branch, shortId: issue.shortId, title: issue.title, agent, pullRequest: publishPr, hostIssue: issue.hostIssue ?? null });
        deps.log(published.startsWith('Did not push') ? chalk.yellow(published) : chalk.green(`✓ ${published}`));
      }
      if (serverRunId && issue.repoId && deps.api?.endIssueRun) {
        await deps.api.endIssueRun(issue.repoId, issue.shortId, serverRunId, { status: code === 0 ? 'done' : 'failed', exitCode: code, detail: published }).catch(() => {});
      }
    } catch (err: any) {
      deps.error(chalk.yellow(`Could not start ${argv[0]} (${err?.message || err}); here is the prompt instead.`));
      const printed = printPrompt(work, issue, prompt, deps, null, !!linkFile);
      return { issue, branch, prompt, agent, launched: null, promptFile: printed, linkFile, worktree, exitCode: 0 };
    }
    if (code !== 0) process.exitCode = code;
    return { issue, branch, prompt, agent, launched: [exe, ...argv.slice(1)], promptFile: null, linkFile, worktree, published, exitCode: code };
  }
  const hint = argv && !exe ? missingAgentHint(agent, argv[0]) : null;
  const promptFile = printPrompt(work, issue, prompt, deps, hint, !!linkFile);
  return { issue, branch, prompt, agent, launched: null, promptFile, linkFile, worktree, exitCode: 0 };
}

/** What to do when the agent's CLI is not installed. */
export function missingAgentHint(agent: IssueAgent, bin: string): string {
  switch (agent) {
    case 'cursor': return `${bin} is not on your PATH — install Cursor's CLI (https://cursor.com/cli), or paste the prompt into Cursor's chat in this checkout.`;
    case 'copilot': return `${bin} is not on your PATH — install the Copilot CLI (npm install -g @github/copilot), or paste the prompt into Copilot Chat in this checkout.`;
    case 'antigravity': return `${bin} is not on your PATH — paste the prompt into Antigravity's agent in this checkout.`;
    default: return `${bin} is not on your PATH — install it, or paste the prompt into your agent.`;
  }
}

function markLocalInProgress(root: string, shortId: string): void {
  const file = path.join(root, '.origin', 'issues', `${shortId}.json`);
  try {
    const it = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (it.status === 'open' || it.status === 'blocked') {
      it.status = 'in-progress';
      it.updatedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(it, null, 2) + '\n');
    }
  } catch { /* nothing to mark */ }
}

function printPrompt(work: string, issue: ResolvedIssue, prompt: string, deps: IssueStartDeps, hint: string | null, linked: boolean): string | null {
  let file: string | null = path.join(work, '.origin', 'issue-prompts', `${issue.shortId.replace(/[^A-Za-z0-9._-]+/g, '-')}.md`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, prompt + '\n');
  } catch { file = null; }
  const copied = deps.copy(prompt);
  deps.log('');
  deps.log(prompt);
  deps.log('');
  if (file) deps.log(chalk.gray(`Saved to ${path.relative(deps.cwd, file) || file}${copied ? ' and copied to the clipboard' : ''}.`));
  else if (copied) deps.log(chalk.gray('Copied to the clipboard.'));
  if (hint) deps.log(chalk.cyan(hint));
  if (linked) deps.log(chalk.gray(`The next agent session started in this checkout within the hour links to ${issue.shortId}.`));
  return file;
}

// ── `origin issue runs` ─────────────────────────────────────────────────────

export interface BackgroundRun {
  shortId: string; title?: string; agent: string; pid: number; log: string; worktree: string;
  branch?: string | null; startedAt: string;
  /** running | done | failed (exit code) | timed out | gone (ended without saying how). */
  state: string;
  exitCode: number | null;
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** Background runs, newest first, with how each is doing. */
export function listBackgroundRuns(dir: string = path.join(os.homedir(), '.origin', 'agent-runs'), alive: (pid: number) => boolean = pidAlive): BackgroundRun[] {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const runs: BackgroundRun[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      let tail = '';
      try {
        const buf = fs.readFileSync(r.log, 'utf-8');
        tail = buf.slice(-400);
      } catch { /* no log */ }
      const m = /\[origin\] agent exited with code (\d+)\s*$/.exec(tail);
      const exitCode = m ? Number(m[1]) : null;
      const timedOut = /\[origin\] agent timed out after /.test(tail);
      const state = timedOut ? 'timed out' : exitCode !== null ? (exitCode === 0 ? 'done' : 'failed') : alive(r.pid) ? 'running' : 'gone';
      runs.push({ ...r, state, exitCode });
    } catch { /* skip a broken record */ }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function issueRunsAction(opts: { json?: boolean } = {}): Promise<void> {
  const runs = listBackgroundRuns();
  if (opts.json) { console.log(JSON.stringify(runs, null, 2)); return; }
  if (runs.length === 0) { console.log(chalk.gray('No background runs. Start one with `origin issue start <id> --background`.')); return; }
  const color = (s: string) => (s === 'running' ? chalk.cyan(s) : s === 'done' ? chalk.green(s) : chalk.yellow(s));
  for (const r of runs.slice(0, 20)) {
    console.log(`${color(r.state.padEnd(9))} ${chalk.bold(r.shortId)} ${r.agent} ${chalk.gray(r.startedAt.replace('T', ' ').slice(0, 16))}${r.exitCode && r.exitCode !== 0 ? chalk.yellow(` exit ${r.exitCode}`) : ''}`);
    console.log(chalk.gray(`        ${r.worktree}`));
    console.log(chalk.gray(`        tail -f ${r.log}`));
  }
}

// ── `origin issue answer` ───────────────────────────────────────────────────

/** Answer the question an agent asked on the issue: the newest open one, or `--question <id>`. */
export async function issueAnswerAction(id: string, words: string[] | string, opts: { question?: string } = {}): Promise<void> {
  const deps = await defaultDeps();
  const answer = (Array.isArray(words) ? words.join(' ') : String(words || '')).trim();
  if (!answer) { deps.error(chalk.red('Give the answer: origin issue answer <id> "<answer>"')); process.exitCode = 2; return; }
  const work = toplevel(deps.cwd);
  if (!work) { deps.error(chalk.red('Not inside a git repository.')); process.exitCode = 1; return; }
  const issue = await resolveIssue(id.replace(/^#(?=\d+$)/, ''), { work, canonical: canonicalRoot(work) }, deps);
  if (!issue || !issue.repoId) {
    deps.error(chalk.red(`No issue on Origin matches "${id}" — questions and answers live on Origin's issues.`));
    process.exitCode = 1;
    return;
  }
  const { api } = await import('../api.js');
  try {
    const r = await api.answerIssueQuestion(issue.repoId, issue.shortId, { answer, id: opts.question ?? null });
    deps.log(chalk.green(`✓ Answered on ${issue.shortId}: ${chalk.gray(String(r?.answered?.question ?? '').slice(0, 200))}`));
    const left = questionsOf(r).filter((q) => !q.answer);
    if (left.length > 0) deps.log(chalk.yellow(`  ${left.length} question${left.length === 1 ? '' : 's'} still open — answer ${left.length === 1 ? 'it' : 'them'} too before starting.`));
    else deps.log(chalk.gray(`  Start again: origin issue start ${issue.shortId} --background`));
  } catch (err: any) {
    const open = (issue.questions ?? []).filter((q) => !q.answer);
    deps.error(chalk.red(err?.status === 409 ? `${issue.shortId} has no open question to answer.` : `Could not answer: ${apiFailure(err)}`));
    if (err?.status === 409 && open.length === 0 && (issue.questions ?? []).length > 0) {
      for (const q of (issue.questions ?? []).slice(-5)) deps.log(chalk.gray(`  ${q.id}  ${q.question.slice(0, 120)}`));
    }
    process.exitCode = 1;
  }
}

/** Commander's entry: it passes (id, opts, command), and the command is not deps. */
export async function issueStartAction(id: string, opts: IssueStartOptions): Promise<void> {
  await issueStartCommand(id, opts);
}
