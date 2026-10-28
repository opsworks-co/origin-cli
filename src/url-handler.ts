// `getorigin://` — start an agent from the browser.
//
// A web page cannot run a program on your machine, so the CLI registers
// itself as the handler for `getorigin://` links (`origin url-handler
// install`). The issue page's "Start" opens
// `getorigin://issue/start?repo=…&issue=…&agent=…`; the browser asks once,
// hands the link to `origin open-url`, and that opens a new terminal in the
// repo's checkout running `origin issue start <id> --agent <agent>` — the same
// command as typing it: branch, prompt (as edited on the issue page), the
// session's link to the issue, and capture.
//
//   macOS    an AppleScript applet in ~/Applications whose Info.plist claims
//            the scheme; it runs `origin open-url <link>` in the background.
//   Linux    a .desktop file registered with xdg-mime.
//   Windows  HKCU\Software\Classes\getorigin.
//
// The link names an issue, never a prompt or a path: the checkout is found
// here, and the issue is read from the API with your own key.
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LAUNCH_URL_SCHEME, issueRunEpicCommandLine, parseIssueCloudUrl, parseIssueLaunchUrl, parseIssueRaceUrl, parseIssueRunEpicUrl, type IssueCloudRequest, type IssueLaunchRequest, type IssueRaceRequest, type IssueRunEpicRequest } from './issue-prompt.js';
import { UNSET_AGENT_SESSION_ENV_SH, freshAgentEnv } from './agent-env.js';
import { parseAgentSetupUrl, type AgentSetupLink } from './agent-setup.js';
import { parseReviewLaunchUrl, reviewRunCommandText, type ReviewLaunchRequest } from './review-run.js';

/** The `origin issue start` flag a link's mode maps to. */
function modeFlag(req: Pick<IssueLaunchRequest, 'worktree' | 'background' | 'force'>): string {
  return (req.background ? ' --background' : req.worktree ? ' --worktree' : '') + (req.force ? ' --force' : '');
}

const ORIGIN_DIR = path.join(os.homedir(), '.origin');
const KNOWN_REPOS_FILE = path.join(ORIGIN_DIR, 'launch-repos.json');
const LOG_FILE = path.join(ORIGIN_DIR, 'url-handler.log');
const MAC_APP = path.join(os.homedir(), 'Applications', 'Origin Launcher.app');
const MAC_BUNDLE_ID = 'io.getorigin.launcher';
const LINUX_DESKTOP = 'getorigin-launcher.desktop';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/**
 * How to run this CLI from a context with no PATH: node, then the entry
 * script — as invoked, never resolved. `origin upgrade` installs each version
 * into its own `@origin/.cli-<version>-…` folder and repoints the `@origin/cli`
 * symlink, so the resolved path dies with the next upgrade while the bin link
 * (`…/bin/origin`) keeps working.
 */
export function selfCommand(entry: string = process.argv[1]): [string, string] {
  return [process.execPath, path.resolve(entry)];
}

function log(line: string): void {
  try {
    fs.mkdirSync(ORIGIN_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging is best-effort */ }
}

/** POSIX single-quoting. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript string literal. */
function asString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── Install ─────────────────────────────────────────────────────────────────

export interface HandlerStatus {
  installed: boolean;
  where: string | null;
}

export function urlHandlerStatus(platform: NodeJS.Platform = process.platform): HandlerStatus {
  if (platform === 'darwin') {
    return { installed: fs.existsSync(path.join(MAC_APP, 'Contents', 'Info.plist')), where: MAC_APP };
  }
  if (platform === 'win32') {
    const r = spawnSync('reg', ['query', `HKCU\\Software\\Classes\\${LAUNCH_URL_SCHEME}\\shell\\open\\command`], { encoding: 'utf-8', windowsHide: true });
    return { installed: r.status === 0, where: `HKCU\\Software\\Classes\\${LAUNCH_URL_SCHEME}` };
  }
  const file = path.join(os.homedir(), '.local', 'share', 'applications', LINUX_DESKTOP);
  return { installed: fs.existsSync(file), where: file };
}

export function installUrlHandler(platform: NodeJS.Platform = process.platform): string {
  const [node, entry] = selfCommand();
  if (platform === 'darwin') return installMac(node, entry);
  if (platform === 'win32') return installWindows(node, entry);
  return installLinux(node, entry);
}

function installMac(node: string, entry: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-launcher-'));
  try {
    const script = path.join(tmp, 'launcher.applescript');
    const cmd = `${shQuote(node)} ${shQuote(entry)} open-url `;
    fs.writeFileSync(script, [
      'on open location theURL',
      `\tdo shell script ${asString(cmd)} & quoted form of theURL & ${asString(` >> ${shQuote(LOG_FILE)} 2>&1 &`)}`,
      'end open location',
      '',
      'on run',
      `\tdisplay dialog ${asString('Origin Launcher starts agents from Origin\'s issue pages. There is nothing to open here.')} buttons {"OK"} default button "OK" with title "Origin"`,
      'end run',
      '',
    ].join('\n'));
    // Built aside and swapped in: a failed build keeps the handler you had.
    const built = path.join(tmp, 'Origin Launcher.app');
    execFileSync('osacompile', ['-o', built, script], { stdio: 'pipe' });
    const plist = path.join(built, 'Contents', 'Info.plist');
    const set = (args: string[]) => execFileSync('plutil', [...args, plist], { stdio: 'pipe' });
    set(['-replace', 'CFBundleIdentifier', '-string', MAC_BUNDLE_ID]);
    set(['-replace', 'CFBundleName', '-string', 'Origin Launcher']);
    set(['-replace', 'LSUIElement', '-bool', 'YES']);
    set(['-replace', 'CFBundleURLTypes', '-json', JSON.stringify([{ CFBundleURLName: 'Origin issue launcher', CFBundleURLSchemes: [LAUNCH_URL_SCHEME] }])]);
    // Editing Info.plist breaks the applet's ad-hoc signature; sign it again.
    try { execFileSync('codesign', ['--force', '--deep', '--sign', '-', built], { stdio: 'pipe' }); } catch { /* unsigned still runs from ~/Applications */ }
    fs.mkdirSync(path.dirname(MAC_APP), { recursive: true });
    fs.rmSync(MAC_APP, { recursive: true, force: true });
    fs.renameSync(built, MAC_APP);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  try { execFileSync(LSREGISTER, ['-f', MAC_APP], { stdio: 'pipe' }); } catch { /* LaunchServices picks it up on first open */ }
  return MAC_APP;
}

function installLinux(node: string, entry: string): string {
  const dir = path.join(os.homedir(), '.local', 'share', 'applications');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LINUX_DESKTOP);
  // Desktop Entry Exec quoting: double quotes, with " ` $ \ escaped.
  const q = (s: string) => `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Origin Launcher',
    'Comment=Start an agent on an Origin issue',
    `Exec=${q(node)} ${q(entry)} open-url %u`,
    'Terminal=false',
    'NoDisplay=true',
    `MimeType=x-scheme-handler/${LAUNCH_URL_SCHEME};`,
    '',
  ].join('\n'));
  try { execFileSync('xdg-mime', ['default', LINUX_DESKTOP, `x-scheme-handler/${LAUNCH_URL_SCHEME}`], { stdio: 'pipe' }); } catch { /* no xdg-utils */ }
  try { execFileSync('update-desktop-database', [dir], { stdio: 'pipe' }); } catch { /* optional */ }
  return file;
}

function installWindows(node: string, entry: string): string {
  const key = `HKCU\\Software\\Classes\\${LAUNCH_URL_SCHEME}`;
  const reg = (args: string[]) => execFileSync('reg', ['add', ...args, '/f'], { stdio: 'pipe', windowsHide: true });
  reg([key, '/ve', '/d', 'URL:Origin issue launcher']);
  reg([key, '/v', 'URL Protocol', '/d', '']);
  reg([`${key}\\shell\\open\\command`, '/ve', '/d', `"${node}" "${entry}" open-url "%1"`]);
  return key;
}

export function uninstallUrlHandler(platform: NodeJS.Platform = process.platform): boolean {
  const { installed, where } = urlHandlerStatus(platform);
  if (!installed || !where) return false;
  if (platform === 'darwin') {
    try { execFileSync(LSREGISTER, ['-u', MAC_APP], { stdio: 'pipe' }); } catch { /* fine */ }
    fs.rmSync(MAC_APP, { recursive: true, force: true });
  } else if (platform === 'win32') {
    execFileSync('reg', ['delete', where, '/f'], { stdio: 'pipe', windowsHide: true });
  } else {
    fs.rmSync(where, { force: true });
  }
  return true;
}

// ── Finding the checkout ────────────────────────────────────────────────────

function readKnown(): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(KNOWN_REPOS_FILE, 'utf-8'));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** The checkouts Start has launched into, by repo id (`origin review runner` watches them too). */
export function knownCheckouts(): string[] {
  return Object.values(readKnown()).filter((v): v is string => typeof v === 'string' && !!v).filter(isGitCheckout);
}

/** Remember where a repo's checkout is, for the next launch. */
export function rememberCheckout(repoId: string, root: string): void {
  if (!repoId || !root) return;
  const known = readKnown();
  if (known[repoId] === root) return;
  known[repoId] = root;
  try {
    fs.mkdirSync(ORIGIN_DIR, { recursive: true });
    fs.writeFileSync(KNOWN_REPOS_FILE, JSON.stringify(known, null, 2) + '\n');
  } catch { /* best-effort */ }
}

function isGitCheckout(dir: string): boolean {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

/** Checkouts this machine has captured sessions in, most recently used first. */
export function candidateCheckouts(sessionsDir = path.join(ORIGIN_DIR, 'sessions')): string[] {
  const seen = new Map<string, number>();
  let files: string[] = [];
  try { files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  for (const f of files) {
    const file = path.join(sessionsDir, f);
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const root = typeof s.canonicalRepoPath === 'string' && s.canonicalRepoPath ? s.canonicalRepoPath : s.repoPath;
      if (typeof root !== 'string' || !root) continue;
      const t = fs.statSync(file).mtimeMs;
      if ((seen.get(root) ?? -1) < t) seen.set(root, t);
    } catch { /* skip */ }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).filter(isGitCheckout);
}

export function remoteUrl(dir: string): string {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { return ''; }
}

/** Does a remote URL name `owner/name` (any host, ssh or https, .git or not)? */
export function remoteNames(url: string, name: string): boolean {
  const tail = url.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  const want = name.toLowerCase();
  return tail.endsWith(`/${want}`) || tail.endsWith(`:${want}`) || (!want.includes('/') && tail.split(/[/:]/).pop() === want);
}

export interface FindCheckoutDeps {
  known: () => Record<string, string>;
  candidates: () => string[];
  remote: (dir: string) => string;
  /** The API's repo id for a checkout (route-preview), or null when it can't tell. */
  repoIdOf: (dir: string, remote: string) => Promise<string | null>;
}

/**
 * The local checkout of the link's repo: the one remembered for it, else a
 * checkout the API maps to the same repo id — trying those whose remote names
 * the repo first. Null when none matches.
 */
export async function findCheckout(req: Pick<IssueLaunchRequest, 'repoId' | 'repoName'>, deps: FindCheckoutDeps): Promise<string | null> {
  const remembered = deps.known()[req.repoId];
  if (remembered && isGitCheckout(remembered)) return remembered;

  const all = deps.candidates();
  const remotes = new Map(all.map((d) => [d, deps.remote(d)]));
  const named = req.repoName ? all.filter((d) => remoteNames(remotes.get(d)!, req.repoName!)) : [];
  // Asked together: each is a round trip, and the terminal waits on them.
  const ask = async (dirs: string[]) => {
    const ids = await Promise.all(dirs.map((d) => deps.repoIdOf(d, remotes.get(d)!).catch(() => null)));
    return dirs.find((_, i) => ids[i] === req.repoId) ?? null;
  };
  const byName = named.length > 0 ? await ask(named.slice(0, 12)) : null;
  if (byName) return byName;
  const rest = await ask(all.filter((d) => !named.includes(d)).slice(0, 12));
  if (rest) return rest;
  // Offline: one checkout whose remote names the repo is a fair guess.
  return named.length === 1 ? named[0] : null;
}

export async function defaultFindDeps(): Promise<FindCheckoutDeps> {
  const [{ api }, { isConnectedMode }] = await Promise.all([import('./api.js'), import('./config.js')]);
  return {
    known: readKnown,
    candidates: () => candidateCheckouts(),
    remote: remoteUrl,
    repoIdOf: async (dir, remote) => {
      if (!isConnectedMode()) return null;
      const route = await api.previewRoute({ repoPath: dir, ...(remote ? { repoUrl: remote } : {}) });
      return route?.repo?.id ?? null;
    },
  };
}

// ── Opening a terminal ──────────────────────────────────────────────────────

/** The shell script a launch runs: cd, start, then leave a shell open there. */
export function launchScript(dir: string | null, req: IssueLaunchRequest, self: [string, string]): string {
  const start = `${shQuote(self[0])} ${shQuote(self[1])} issue start ${shQuote(req.shortId)} --agent ${shQuote(req.agent)}${modeFlag(req)}`;
  // Terminal may itself have been started from inside an agent session: drop
  // that session's markers so the agent here is a session of its own.
  const lines = ['#!/bin/sh', 'rm -f "$0"', UNSET_AGENT_SESSION_ENV_SH];
  if (dir) {
    lines.push(
      `cd ${shQuote(dir)} || exit 1`,
      `echo ${shQuote(`Origin: starting ${req.agent} on ${req.shortId} in ${dir}`)}`,
      // A login, interactive shell — the agent CLIs live on the PATH your rc
      // files set — exec'd so it owns the terminal: run as a child of this
      // script it is stopped by SIGTTOU, agent and all. It stays open after.
      `exec "\${SHELL:-/bin/sh}" -ilc ${shQuote(`${start}; exec "\${SHELL:-/bin/sh}" -il`)}`,
      '',
    );
    return lines.join('\n');
  }
  const what = req.repoName ? `${req.repoName} (${req.repoId})` : req.repoId;
  lines.push(
    `echo ${shQuote(`Origin could not find a checkout of ${what} on this machine.`)}`,
    `echo ${shQuote('cd into it and run:')}`,
    `echo ${shQuote(`  origin issue start ${req.shortId} --agent ${req.agent}${modeFlag(req)}`)}`,
    `echo ${shQuote('Once a checkout has run that (or `origin url-handler install` inside it), Start finds it.')}`,
  );
  lines.push('exec "${SHELL:-/bin/sh}" -il', '');
  return lines.join('\n');
}

/** The shell script a review link runs: cd into the checkout, `origin review run <ids>`, then a shell there. */
export function reviewLaunchScript(dir: string | null, req: ReviewLaunchRequest, self: [string, string]): string {
  const run = `${shQuote(self[0])} ${shQuote(self[1])} review run ${req.runIds.map(shQuote).join(' ')}`;
  const lines = ['#!/bin/sh', 'rm -f "$0"', UNSET_AGENT_SESSION_ENV_SH];
  if (dir) {
    lines.push(
      `cd ${shQuote(dir)} || exit 1`,
      `echo ${shQuote(`Origin: reviewing PR #${req.prNumber} in ${dir}`)}`,
      `exec "\${SHELL:-/bin/sh}" -ilc ${shQuote(`${run}; exec "\${SHELL:-/bin/sh}" -il`)}`,
      '',
    );
    return lines.join('\n');
  }
  const what = req.repoName ? `${req.repoName} (${req.repoId})` : req.repoId;
  lines.push(
    `echo ${shQuote(`Origin could not find a checkout of ${what} on this machine.`)}`,
    `echo ${shQuote('cd into it and run:')}`,
    `echo ${shQuote(`  ${reviewRunCommandText(req.runIds)}`)}`,
    `echo ${shQuote('Once a checkout has run that (or `origin url-handler install` inside it), Run reviewers finds it.')}`,
  );
  lines.push('exec "${SHELL:-/bin/sh}" -il', '');
  return lines.join('\n');
}

function reviewWindowsScript(dir: string | null, req: ReviewLaunchRequest, self: [string, string]): string {
  const lines = ['@echo off'];
  if (dir) {
    lines.push(`cd /d "${dir}"`, `echo Origin: reviewing PR #${req.prNumber} in ${dir}`, `"${self[0]}" "${self[1]}" review run ${req.runIds.join(' ')}`);
  } else {
    lines.push(`echo Origin could not find a checkout of ${req.repoName || req.repoId} on this machine.`, `echo cd into it and run: ${reviewRunCommandText(req.runIds)}`);
  }
  lines.push('');
  return lines.join('\r\n');
}

function windowsScript(dir: string | null, req: IssueLaunchRequest, self: [string, string]): string {
  const lines = ['@echo off'];
  if (dir) {
    lines.push(`cd /d "${dir}"`, `echo Origin: starting ${req.agent} on ${req.shortId} in ${dir}`, `"${self[0]}" "${self[1]}" issue start ${req.shortId} --agent ${req.agent}${modeFlag(req)}`);
  } else {
    lines.push(`echo Origin could not find a checkout of ${req.repoName || req.repoId} on this machine.`, `echo cd into it and run: origin issue start ${req.shortId} --agent ${req.agent}${modeFlag(req)}`);
  }
  lines.push('');
  return lines.join('\r\n');
}

function openTerminal(script: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  const detach = (bin: string, args: string[]) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => { /* tried; the log says which */ });
    child.unref();
  };
  if (platform === 'darwin') {
    // A .command file opens in the user's terminal of choice for that type;
    // ORIGIN_TERMINAL names an app to use instead (e.g. iTerm).
    const app = env.ORIGIN_TERMINAL;
    execFileSync('open', app ? ['-a', app, script] : [script], { stdio: 'pipe' });
    return;
  }
  if (platform === 'win32') {
    // `start` takes its first quoted argument as the window title, so the
    // line is passed verbatim rather than re-quoted by node.
    const child = spawn('cmd.exe', ['/c', `start "Origin" cmd.exe /k "${script}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true });
    child.on('error', () => { /* logged by the caller's catch */ });
    child.unref();
    return;
  }
  const terms: Array<[string, string[]]> = [
    ...(env.ORIGIN_TERMINAL ? [[env.ORIGIN_TERMINAL, ['-e', 'sh', script]] as [string, string[]]] : []),
    ['x-terminal-emulator', ['-e', 'sh', script]],
    ['gnome-terminal', ['--', 'sh', script]],
    ['konsole', ['-e', 'sh', script]],
    ['xfce4-terminal', ['-x', 'sh', script]],
    ['kitty', ['sh', script]],
    ['alacritty', ['-e', 'sh', script]],
    ['wezterm', ['start', '--', 'sh', script]],
    ['xterm', ['-e', 'sh', script]],
  ];
  for (const [bin, args] of terms) {
    const found = spawnSync('sh', ['-c', `command -v ${shQuote(bin)}`], { stdio: 'ignore' }).status === 0;
    if (found) { detach(bin, args); return; }
  }
  throw new Error('no terminal emulator found (set ORIGIN_TERMINAL)');
}

/**
 * The user's login shell. A handler started by the OS may have no SHELL set,
 * and /bin/sh would not read the zsh/bash rc files that put the agent CLIs
 * on PATH, so ask the user record.
 */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELL) return env.SHELL;
  try { const s = os.userInfo().shell; if (s) return s; } catch { /* no passwd entry */ }
  return '/bin/sh';
}

/**
 * A background run: no terminal. `origin issue start --background` runs in a
 * login shell (for the PATH that finds the agent CLIs) with no tty, detached;
 * it spawns the agent headless and returns. Its own output goes to the
 * handler log, and macOS shows a notification saying where the run is.
 */
function startInBackground(dir: string, req: IssueLaunchRequest, self: [string, string], platform: NodeJS.Platform): void {
  const start = `${shQuote(self[0])} ${shQuote(self[1])} issue start ${shQuote(req.shortId)} --agent ${shQuote(req.agent)}${modeFlag(req)}`;
  fs.mkdirSync(ORIGIN_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  try {
    const child = platform === 'win32'
      ? spawn(self[0], [self[1], 'issue', 'start', req.shortId, '--agent', req.agent, '--background', ...(req.force ? ['--force'] : [])], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true })
      : spawn(loginShell(), ['-ilc', start], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true });
    child.on('error', () => { /* logged below by the exit path */ });
    child.unref();
  } finally {
    fs.closeSync(out);
  }
  log(`background ${req.agent} on ${req.shortId} in ${dir}`);
  if (platform === 'darwin') {
    const msg = `${req.agent} is working on ${req.shortId} in the background. origin issue runs shows it.`;
    try { spawnSync('osascript', ['-e', `display notification ${asString(msg)} with title "Origin"`], { stdio: 'ignore', timeout: 3000 }); } catch { /* optional */ }
  }
}

/** The command a race link runs, as a shell line (macOS / Linux). */
export function raceCommandLine(req: IssueRaceRequest, self: [string, string]): string {
  return `${shQuote(self[0])} ${shQuote(self[1])} issue race ${shQuote(req.shortId)} --agents ${shQuote(req.agents.join(','))}${req.force ? ' --force' : ''}`;
}

/** A race: like a background start, `origin issue race` detached in the checkout. */
function startRaceInBackground(dir: string, req: IssueRaceRequest, self: [string, string], platform: NodeJS.Platform): void {
  fs.mkdirSync(ORIGIN_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  try {
    const child = platform === 'win32'
      ? spawn(self[0], [self[1], 'issue', 'race', req.shortId, '--agents', req.agents.join(','), ...(req.force ? ['--force'] : [])], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true })
      : spawn(loginShell(), ['-ilc', raceCommandLine(req, self)], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true });
    child.on('error', () => { /* logged below */ });
    child.unref();
  } finally {
    fs.closeSync(out);
  }
  log(`race ${req.agents.join(',')} on ${req.shortId} in ${dir}`);
  notify(`${req.agents.join(', ')} are racing on ${req.shortId} in the background. origin issue runs shows them.`, platform);
}

function notify(msg: string, platform: NodeJS.Platform): void {
  if (platform !== 'darwin') return;
  try { spawnSync('osascript', ['-e', `display notification ${asString(msg)} with title "Origin"`], { stdio: 'ignore', timeout: 3000 }); } catch { /* optional */ }
}

async function openRaceUrl(url: string, req: IssueRaceRequest, injected?: Partial<FindCheckoutDeps>): Promise<void> {
  if (isRepeatLaunch(url)) {
    log(`ignored a repeat of ${url} within ${REPEAT_MS / 1000}s`);
    return;
  }
  const deps = { ...(await defaultFindDeps()), ...(injected || {}) };
  const dir = await findCheckout(req, deps);
  if (!dir) {
    log(`race on ${req.shortId}: no checkout of ${req.repoName || req.repoId} found`);
    notify(`Origin could not find a checkout of ${req.repoName || req.repoId}. cd into it and run: origin issue race ${req.shortId} --agents ${req.agents.join(',')}`, process.platform);
    process.exitCode = 1;
    return;
  }
  rememberCheckout(req.repoId, dir);
  try {
    startRaceInBackground(dir, req, selfCommand(), process.platform);
  } catch (err: any) {
    log(`could not start the race: ${err?.message || err}`);
    process.exitCode = 1;
  }
}

/** The command a cloud link runs, as a shell line (macOS / Linux). */
export function cloudCommandLine(req: IssueCloudRequest, self: [string, string]): string {
  return `${shQuote(self[0])} ${shQuote(self[1])} issue cloud ${shQuote(req.shortId)} --runner ${shQuote(req.runner)} --env ${shQuote(req.env)}`;
}

/**
 * A cloud run (`getorigin://issue/cloud`): `origin issue cloud` detached in
 * the checkout. It submits the task with the person's own `codex` login and
 * follows it to its end; its output goes to the handler log.
 */
async function openCloudUrl(url: string, req: IssueCloudRequest, injected?: Partial<FindCheckoutDeps>): Promise<void> {
  if (isRepeatLaunch(url)) {
    log(`ignored a repeat of ${url} within ${REPEAT_MS / 1000}s`);
    return;
  }
  const deps = { ...(await defaultFindDeps()), ...(injected || {}) };
  const dir = await findCheckout(req, deps);
  if (!dir) {
    log(`cloud ${req.runner} on ${req.shortId}: no checkout of ${req.repoName || req.repoId} found`);
    notify(`Origin could not find a checkout of ${req.repoName || req.repoId}. cd into it and run: origin issue cloud ${req.shortId} --env ${req.env}`, process.platform);
    process.exitCode = 1;
    return;
  }
  rememberCheckout(req.repoId, dir);
  const self = selfCommand();
  fs.mkdirSync(ORIGIN_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  try {
    const child = process.platform === 'win32'
      ? spawn(self[0], [self[1], 'issue', 'cloud', req.shortId, '--runner', req.runner, '--env', req.env], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true })
      : spawn(loginShell(), ['-ilc', cloudCommandLine(req, self)], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true });
    child.on('error', () => { /* logged below */ });
    child.unref();
  } catch (err: any) {
    log(`could not start the cloud run: ${err?.message || err}`);
    process.exitCode = 1;
    return;
  } finally {
    fs.closeSync(out);
  }
  log(`cloud ${req.runner} on ${req.shortId} (env ${req.env}) from ${dir}`);
  notify(`Codex cloud is taking ${req.shortId}. Origin follows the task and shows how it ends on the issue.`, process.platform);
}

// ── Settings → Agents ───────────────────────────────────────────────────────

/** The script a Sign in link runs: the agent's login, then a shell left open. */
export function agentLoginScript(link: Extract<AgentSetupLink, { action: 'login' }>, self: [string, string]): string {
  const cmd = `${shQuote(self[0])} ${shQuote(self[1])} agents login ${shQuote(link.agent)}${link.switchAccount ? ' --switch' : ''}`;
  return [
    '#!/bin/sh', 'rm -f "$0"', UNSET_AGENT_SESSION_ENV_SH,
    'cd "$HOME" || exit 1',
    `exec "\${SHELL:-/bin/sh}" -ilc ${shQuote(`${cmd}; exec "\${SHELL:-/bin/sh}" -il`)}`,
    '',
  ].join('\n');
}

async function openAgentSetupUrl(url: string, link: AgentSetupLink): Promise<void> {
  if (isRepeatLaunch(url)) {
    log(`ignored a repeat of ${url} within ${REPEAT_MS / 1000}s`);
    return;
  }
  const self = selfCommand();
  const platform = process.platform;
  if (link.action === 'check') {
    // Headless: a login shell for the PATH that finds the agent CLIs.
    fs.mkdirSync(ORIGIN_DIR, { recursive: true });
    const out = fs.openSync(LOG_FILE, 'a');
    try {
      const child = platform === 'win32'
        ? spawn(self[0], [self[1], 'agents', 'check', '--report', '--quiet'], { cwd: os.homedir(), detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true })
        : spawn(loginShell(), ['-ilc', `${shQuote(self[0])} ${shQuote(self[1])} agents check --report --quiet`], { cwd: os.homedir(), detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true });
      child.on('error', () => { /* logged below */ });
      child.unref();
    } catch (err: any) {
      log(`could not check the agents: ${err?.message || err}`);
      process.exitCode = 1;
      return;
    } finally {
      fs.closeSync(out);
    }
    log('agents check');
    return;
  }
  const launchDir = path.join(ORIGIN_DIR, 'launch');
  fs.mkdirSync(launchDir, { recursive: true });
  const script = path.join(launchDir, `${Date.now()}-login-${link.agent}${platform === 'win32' ? '.cmd' : '.command'}`);
  const body = platform === 'win32'
    ? ['@echo off', `cd /d "%USERPROFILE%"`, `"${self[0]}" "${self[1]}" agents login ${link.agent}${link.switchAccount ? ' --switch' : ''}`, ''].join('\r\n')
    : agentLoginScript(link, self);
  fs.writeFileSync(script, body, { mode: 0o700 });
  log(`agents login ${link.agent}${link.switchAccount ? ' --switch' : ''}`);
  try {
    openTerminal(script, platform, process.env);
  } catch (err: any) {
    log(`could not open a terminal: ${err?.message || err}`);
    process.exitCode = 1;
  }
}

// ── `origin open-url` ───────────────────────────────────────────────────────

/** A second click on the same link within this long is the same launch. */
const REPEAT_MS = 10_000;

/** True when this link was opened moments ago (a double click, a re-sent link). */
export function isRepeatLaunch(url: string, now = Date.now(), file = path.join(ORIGIN_DIR, 'launch', 'last.json')): boolean {
  // Two handlers started by one double click run at once: whoever creates the
  // lock first launches, the other is the repeat. A stale lock is taken over.
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(lock, String(now), { flag: 'wx' });
  } catch {
    let held = 0;
    try { held = Number(fs.readFileSync(lock, 'utf-8')) || 0; } catch { /* gone */ }
    if (now - held >= 0 && now - held < REPEAT_MS) return true;
    try { fs.writeFileSync(lock, String(now)); } catch { /* best-effort */ }
  }
  try { return checkLast(url, now, file); } finally { try { fs.rmSync(lock, { force: true }); } catch { /* fine */ } }
}

function checkLast(url: string, now: number, file: string): boolean {
  let repeat = false;
  try {
    const last = JSON.parse(fs.readFileSync(file, 'utf-8'));
    repeat = last?.url === url && typeof last.at === 'number' && now - last.at >= 0 && now - last.at < REPEAT_MS;
  } catch { /* first launch */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url, at: now }));
  } catch { /* best-effort */ }
  return repeat;
}

/** Write a launch script and open a terminal on it. */
function openInTerminal(stamp: string, posix: string, windows: string): void {
  const launchDir = path.join(ORIGIN_DIR, 'launch');
  fs.mkdirSync(launchDir, { recursive: true });
  const script = process.platform === 'win32'
    ? path.join(launchDir, `${stamp}.cmd`)
    : path.join(launchDir, `${stamp}.command`);
  fs.writeFileSync(script, process.platform === 'win32' ? windows : posix, { mode: 0o700 });
  try {
    openTerminal(script, process.platform, process.env);
  } catch (err: any) {
    log(`could not open a terminal: ${err?.message || err}`);
    console.error(`Could not open a terminal: ${err?.message || err}`);
    process.exitCode = 1;
  }
}

/**
 * The shell line a background review runs (macOS / Linux): `origin review
 * run <ids>`, then — on macOS — a notification saying how it ended, so the
 * person learns the results are on the PR (or where the log is) without a
 * terminal to watch. `origin review run` exits non-zero when a run failed.
 */
export function reviewBackgroundCommandLine(req: ReviewLaunchRequest, self: [string, string], platform: NodeJS.Platform, logFile: string): string {
  const run = `${shQuote(self[0])} ${shQuote(self[1])} review run ${req.runIds.map(shQuote).join(' ')}`;
  if (platform !== 'darwin') return run;
  const say = (msg: string) => `osascript -e ${shQuote(`display notification ${asString(msg)} with title "Origin"`)} >/dev/null 2>&1`;
  return `if ${run}; then ${say(`Reviewers finished on PR #${req.prNumber}. Results are on the PR.`)}; `
    + `else ${say(`A reviewer failed on PR #${req.prNumber}. Log: ${logFile}`)}; fi`;
}

/** Where a background review writes its output: one file per launch, under ~/.origin/review-runs. */
export function reviewLogFile(prNumber: number, now = Date.now()): string {
  return path.join(ORIGIN_DIR, 'review-runs', `${now}-pr${prNumber}.log`);
}

/**
 * A review (`getorigin://review/run`): `origin review run <ids>` in the
 * checkout, in the background — no terminal window. The results land on the
 * PR page (and the host PR), its output in ~/.origin/review-runs, and macOS
 * says when it starts and finishes. Only a missing checkout opens a terminal,
 * because then the person has to act.
 */
async function openReviewUrl(url: string, req: ReviewLaunchRequest, injected?: Partial<FindCheckoutDeps>): Promise<void> {
  if (isRepeatLaunch(url)) {
    log(`ignored a repeat of ${url} within ${REPEAT_MS / 1000}s`);
    return;
  }
  const deps = { ...(await defaultFindDeps()), ...(injected || {}) };
  const dir = await findCheckout(req, deps);
  if (dir) rememberCheckout(req.repoId, dir);
  log(`review PR #${req.prNumber} (${req.runIds.length} run(s), repo ${req.repoId}) in ${dir ?? '<no checkout found>'}`);
  const self = selfCommand();
  if (!dir) {
    notify(`Origin could not find a checkout of ${req.repoName || req.repoId}. cd into it and run: ${reviewRunCommandText(req.runIds)}`, process.platform);
    openInTerminal(`${Date.now()}-review-${req.prNumber}`, reviewLaunchScript(dir, req, self), reviewWindowsScript(dir, req, self));
    return;
  }
  reviewInBackground(dir, req, self, process.platform);
}

function reviewInBackground(dir: string, req: ReviewLaunchRequest, self: [string, string], platform: NodeJS.Platform): void {
  const logFile = reviewLogFile(req.prNumber);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  try {
    const child = platform === 'win32'
      ? spawn(self[0], [self[1], 'review', 'run', ...req.runIds], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true })
      : spawn(loginShell(), ['-ilc', reviewBackgroundCommandLine(req, self, platform, logFile)], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: freshAgentEnv(process.env), windowsHide: true });
    child.on('error', () => { /* the log file says what happened */ });
    child.unref();
  } finally {
    fs.closeSync(out);
  }
  log(`background review of PR #${req.prNumber} in ${dir}, output in ${logFile}`);
  const n = req.runIds.length;
  notify(`Reviewing PR #${req.prNumber} in the background (${n === 1 ? '1 reviewer' : `${n} reviewers`}). Results appear on the PR.`, platform);
}

/** The command a run-epic link runs, as a shell line (macOS / Linux). */
export function runEpicCommandLine(req: IssueRunEpicRequest, self: [string, string]): string {
  return `${shQuote(self[0])} ${shQuote(self[1])} issue run-epic ${shQuote(req.shortId)} --agent ${shQuote(req.agent)}${req.max ? ` --max ${req.max}` : ''}`;
}

/** The shell script a run-epic link runs: cd into the checkout, `origin issue run-epic <KEY>`, then a shell there. */
export function runEpicLaunchScript(dir: string | null, req: IssueRunEpicRequest, self: [string, string]): string {
  const lines = ['#!/bin/sh', 'rm -f "$0"', UNSET_AGENT_SESSION_ENV_SH];
  if (dir) {
    lines.push(
      `cd ${shQuote(dir)} || exit 1`,
      `echo ${shQuote(`Origin: working through ${req.shortId} with ${req.agent} in ${dir}`)}`,
      `exec "\${SHELL:-/bin/sh}" -ilc ${shQuote(`${runEpicCommandLine(req, self)}; exec "\${SHELL:-/bin/sh}" -il`)}`,
      '',
    );
    return lines.join('\n');
  }
  const what = req.repoName ? `${req.repoName} (${req.repoId})` : req.repoId;
  lines.push(
    `echo ${shQuote(`Origin could not find a checkout of ${what} on this machine.`)}`,
    `echo ${shQuote('cd into it and run:')}`,
    `echo ${shQuote(`  ${issueRunEpicCommandLine(req.shortId, { agent: req.agent, max: req.max })}`)}`,
    `echo ${shQuote('Once a checkout has run that (or `origin url-handler install` inside it), Run epic finds it.')}`,
  );
  lines.push('exec "${SHELL:-/bin/sh}" -il', '');
  return lines.join('\n');
}

function runEpicWindowsScript(dir: string | null, req: IssueRunEpicRequest, self: [string, string]): string {
  const lines = ['@echo off'];
  const cmd = `issue run-epic ${req.shortId} --agent ${req.agent}${req.max ? ` --max ${req.max}` : ''}`;
  if (dir) lines.push(`cd /d "${dir}"`, `echo Origin: working through ${req.shortId} with ${req.agent} in ${dir}`, `"${self[0]}" "${self[1]}" ${cmd}`);
  else lines.push(`echo Origin could not find a checkout of ${req.repoName || req.repoId} on this machine.`, `echo cd into it and run: origin ${cmd}`);
  lines.push('');
  return lines.join('\r\n');
}

/**
 * An epic run story by story (`getorigin://issue/run-epic`): a terminal in
 * the checkout running `origin issue run-epic <KEY>` — visible, like an issue
 * start, since each story's agent runs in the foreground there.
 */
async function openRunEpicUrl(url: string, req: IssueRunEpicRequest, injected?: Partial<FindCheckoutDeps>): Promise<void> {
  if (isRepeatLaunch(url)) {
    log(`ignored a repeat of ${url} within ${REPEAT_MS / 1000}s`);
    return;
  }
  const deps = { ...(await defaultFindDeps()), ...(injected || {}) };
  const dir = await findCheckout(req, deps);
  if (dir) rememberCheckout(req.repoId, dir);
  log(`run-epic ${req.shortId} with ${req.agent} (repo ${req.repoId}) in ${dir ?? '<no checkout found>'}`);
  if (!dir) notify(`Origin could not find a checkout of ${req.repoName || req.repoId}. cd into it and run: ${issueRunEpicCommandLine(req.shortId, { agent: req.agent, max: req.max })}`, process.platform);
  const self = selfCommand();
  openInTerminal(`${Date.now()}-epic-${req.shortId.replace(/[^A-Za-z0-9._-]/g, '-')}`, runEpicLaunchScript(dir, req, self), runEpicWindowsScript(dir, req, self));
}

export async function openUrlCommand(url: string, injected?: Partial<FindCheckoutDeps>): Promise<void> {
  const setup = parseAgentSetupUrl(url);
  if (setup) return openAgentSetupUrl(url, setup);
  const race = parseIssueRaceUrl(url);
  if (race) return openRaceUrl(url, race, injected);
  const epic = parseIssueRunEpicUrl(url);
  if (epic) return openRunEpicUrl(url, epic, injected);
  const cloud = parseIssueCloudUrl(url);
  if (cloud) return openCloudUrl(url, cloud, injected);
  const review = parseReviewLaunchUrl(url);
  if (review) return openReviewUrl(url, review, injected);
  const req = parseIssueLaunchUrl(url);
  if (!req) {
    log(`refused: not a launch link: ${String(url).slice(0, 200)}`);
    console.error('Not an Origin launch link.');
    process.exitCode = 2;
    return;
  }
  if (isRepeatLaunch(url)) {
    log(`ignored a repeat of ${url} within ${REPEAT_MS / 1000}s`);
    return;
  }
  const deps = { ...(await defaultFindDeps()), ...(injected || {}) };
  const dir = await findCheckout(req, deps);
  if (dir) rememberCheckout(req.repoId, dir);
  log(`launch ${req.agent} on ${req.shortId} (repo ${req.repoId}) in ${dir ?? '<no checkout found>'}`);

  const self = selfCommand();
  if (req.background && dir) {
    try {
      startInBackground(dir, req, self, process.platform);
    } catch (err: any) {
      log(`could not start in the background: ${err?.message || err}`);
      process.exitCode = 1;
    }
    return;
  }
  const launchDir = path.join(ORIGIN_DIR, 'launch');
  fs.mkdirSync(launchDir, { recursive: true });
  const stamp = `${Date.now()}-${req.shortId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const script = process.platform === 'win32'
    ? path.join(launchDir, `${stamp}.cmd`)
    : path.join(launchDir, `${stamp}.command`);
  fs.writeFileSync(script, process.platform === 'win32' ? windowsScript(dir, req, self) : launchScript(dir, req, self), { mode: 0o700 });
  try {
    openTerminal(script, process.platform, process.env);
  } catch (err: any) {
    log(`could not open a terminal: ${err?.message || err}`);
    console.error(`Could not open a terminal: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
