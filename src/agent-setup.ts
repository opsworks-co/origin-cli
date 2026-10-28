/**
 * Which coding agents are installed on this machine, and which account each
 * is signed in with — so Settings → Agents can show it instead of a run
 * failing first (docs/AGENT_SIGN_IN.md). `origin agents check --report` sends
 * the result; `origin agents login <agent>` runs the agent's own login.
 *
 * Only read-only status commands and local files are used, and only the
 * signed-in email, the plan name and the sign-in method leave the machine:
 * never a token, user id or org. Never `cursor agent …` — the Cursor app's
 * wrapper installs cursor-agent from the internet when it is missing.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const SETUP_AGENTS = ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'antigravity', 'devin'] as const;
export type SetupAgent = (typeof SETUP_AGENTS)[number];

export function isSetupAgent(x: unknown): x is SetupAgent {
  return typeof x === 'string' && (SETUP_AGENTS as readonly string[]).includes(x);
}

export const AGENT_BINARIES: Record<SetupAgent, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  gemini: 'gemini',
  copilot: 'copilot',
  antigravity: 'agy',
  devin: 'devin',
};

export interface AgentSetupStatus {
  agent: SetupAgent;
  installed: boolean;
  version: string | null;
  /** null = the agent has no way to tell without running a model. */
  signedIn: boolean | null;
  /** The signed-in email — the only account detail sent. */
  account: string | null;
  plan: string | null;
  method: string | null;
  /** Can a background run start: installed, not signed out, no recent limit hit. */
  usable: boolean;
  /** One sentence on why not, or what to watch for. */
  problem: string | null;
}

export interface AgentSetupReport {
  v: 1;
  platform: string;
  checkedAt: string;
  agents: AgentSetupStatus[];
}

/** `text` is stdout then stderr: some CLIs (codex) print their status on stderr. */
export interface RunResult { code: number; stdout: string; text: string }

export interface ProbeDeps {
  /** Run a binary; null when it is not installed (ENOENT). */
  run: (bin: string, args: string[]) => Promise<RunResult | null>;
  readFile: (file: string) => string | null;
  env: NodeJS.ProcessEnv;
  home: string;
  now: number;
  runsDir: string;
}

const RUN_TIMEOUT_MS = 15_000;

export function defaultProbeDeps(): ProbeDeps {
  return {
    run: (bin, args) => new Promise((resolve) => {
      // Fixed argv, no user input: a shell is only for Windows' npm .cmd shims.
      execFile(bin, args, { timeout: RUN_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: '1', NO_OPEN_BROWSER: '1' } }, (err: any, stdout, stderr) => {
        if (err && (err.code === 'ENOENT' || (process.platform === 'win32' && /not recognized/i.test(String(err.message))))) return resolve(null);
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), text: `${stdout || ''}\n${stderr || ''}` });
      });
    }),
    readFile: (file) => { try { return fs.readFileSync(file, 'utf-8'); } catch { return null; } },
    env: process.env,
    home: os.homedir(),
    now: Date.now(),
    runsDir: path.join(os.homedir(), '.origin', 'agent-runs'),
  };
}

function parseJson(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch {
    // Some CLIs print a banner before the JSON.
    const i = s.indexOf('{');
    if (i > 0) { try { return JSON.parse(s.slice(i)); } catch { /* not JSON */ } }
    return null;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function email(x: unknown): string | null {
  return typeof x === 'string' && EMAIL.test(x.trim()) ? x.trim() : null;
}
function short(x: unknown, max = 40): string | null {
  if (typeof x !== 'string') return null;
  const t = x.trim();
  return t ? t.slice(0, max) : null;
}

/** "codex-cli 0.145.0" / "2.1.292 (Claude Code)" / "devin 3000.2.17 (…)" → the version. */
export function parseVersion(out: string): string | null {
  const first = out.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const m = first.match(/\d+(?:\.\d+)+(?:[-+][\w.]+)?/);
  return m ? m[0] : short(first, 40);
}

/** `claude auth status --json`. */
export function parseClaudeStatus(out: string): Pick<AgentSetupStatus, 'signedIn' | 'account' | 'plan' | 'method'> {
  const j = parseJson(out);
  if (!j || typeof j.loggedIn !== 'boolean') return { signedIn: null, account: null, plan: null, method: null };
  return { signedIn: j.loggedIn, account: j.loggedIn ? email(j.email) : null, plan: j.loggedIn ? short(j.subscriptionType) : null, method: j.loggedIn ? short(j.authMethod) : null };
}

/** The claims of a JWT, decoded locally. No signature check: display only. */
export function jwtClaims(token: unknown): Record<string, any> | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')); } catch { return null; }
}

/** `codex login status` plus the email and plan claims of `auth.json`'s id_token. */
export function parseCodexStatus(res: RunResult, authJson: string | null): Pick<AgentSetupStatus, 'signedIn' | 'account' | 'plan' | 'method'> {
  const text = res.text.trim();
  const signedIn = res.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
  if (!signedIn) return { signedIn: /not logged in/i.test(text) || res.code !== 0 ? false : null, account: null, plan: null, method: null };
  const method = /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : null;
  const claims = jwtClaims(parseJson(authJson)?.tokens?.id_token);
  const auth = claims?.['https://api.openai.com/auth'] || {};
  return { signedIn, account: email(claims?.email), plan: short(auth.chatgpt_plan_type), method };
}

/** `cursor-agent status --format json` and `cursor-agent about --format json`. */
export function parseCursorStatus(status: string, about: string | null): Pick<AgentSetupStatus, 'signedIn' | 'account' | 'plan' | 'method'> {
  const s = parseJson(status);
  const a = parseJson(about);
  const signedIn = typeof s?.isAuthenticated === 'boolean' ? s.isAuthenticated : null;
  return {
    signedIn,
    account: signedIn ? email(a?.userEmail) ?? email(s?.email) : null,
    plan: signedIn ? short(a?.subscriptionTier) : null,
    method: null,
  };
}

/** `devin auth status` (text). */
export function parseDevinStatus(res: RunResult): Pick<AgentSetupStatus, 'signedIn' | 'account' | 'plan' | 'method'> {
  const t = res.text;
  if (/not logged in|logged out/i.test(t)) return { signedIn: false, account: null, plan: null, method: null };
  const signedIn = /^\s*logged in/im.test(t) ? true : res.code !== 0 ? false : null;
  const field = (name: string) => t.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'))?.[1];
  return { signedIn, account: signedIn ? email(field('Email')) : null, plan: signedIn ? short(field('Plan')) : null, method: null };
}

/** Gemini has no status command: its settings and accounts files, or an API key. */
export function geminiStatus(deps: Pick<ProbeDeps, 'readFile' | 'env' | 'home'>): Pick<AgentSetupStatus, 'signedIn' | 'account' | 'plan' | 'method'> {
  const dir = path.join(deps.home, '.gemini');
  const settings = parseJson(deps.readFile(path.join(dir, 'settings.json')));
  const type = short(settings?.security?.auth?.selectedType ?? settings?.selectedAuthType);
  if (deps.env.GEMINI_API_KEY || type === 'gemini-api-key') {
    return { signedIn: !!deps.env.GEMINI_API_KEY || null, account: null, plan: null, method: 'API key' };
  }
  const active = email(parseJson(deps.readFile(path.join(dir, 'google_accounts.json')))?.active);
  const creds = deps.readFile(path.join(dir, 'oauth_creds.json'));
  if (active && creds) return { signedIn: true, account: active, plan: null, method: type };
  if (!type && !creds) return { signedIn: false, account: null, plan: null, method: null };
  return { signedIn: creds ? true : null, account: active, plan: null, method: type };
}

/** Copilot keeps its token in the credential store and has no status command. */
export function copilotStatus(env: NodeJS.ProcessEnv): Pick<AgentSetupStatus, 'signedIn' | 'account' | 'plan' | 'method'> {
  const token = env.COPILOT_GITHUB_TOKEN ? 'COPILOT_GITHUB_TOKEN' : env.GH_TOKEN ? 'GH_TOKEN' : env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : null;
  return token ? { signedIn: true, account: null, plan: null, method: token } : { signedIn: null, account: null, plan: null, method: null };
}

/** Antigravity's CLI has no status command; its OAuth token file exists once signed in. */
export function antigravityStatus(deps: Pick<ProbeDeps, 'readFile' | 'home'>): Pick<AgentSetupStatus, 'signedIn' | 'account' | 'plan' | 'method'> {
  const token = deps.readFile(path.join(deps.home, '.gemini', 'jetski-standalone-oauth-token'));
  return { signedIn: token && token.trim() ? true : null, account: null, plan: null, method: null };
}

const LIMIT_RE = /usage limit|rate limit|quota|out of credits|credit balance|exceeded your|hit your (?:usage |free )?limit|upgrade (?:to|your) (?:pro|plan|a paid)/i;
const AUTH_RE = /not logged in|unauthenticated|please (?:log ?in|sign in)|authentication required|unable to fetch user details|invalid api key|401 unauthorized/i;
const RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Why the newest background run of `agent` from the last 24 h failed, when
 * its log says it hit a usage limit or could not sign in. A running or
 * successful run, or none, is null.
 */
export function lastRunProblem(agent: SetupAgent, deps: Pick<ProbeDeps, 'readFile' | 'now' | 'runsDir'>, list: (dir: string) => string[] = safeList): string | null {
  let newest: { at: number; log: string } | null = null;
  for (const name of list(deps.runsDir)) {
    if (!name.endsWith('.json') || !name.includes(`-${agent}-`)) continue;
    const rec = parseJson(deps.readFile(path.join(deps.runsDir, name)));
    if (rec?.agent !== agent || typeof rec.log !== 'string') continue;
    const at = Date.parse(rec.startedAt);
    if (!Number.isFinite(at) || deps.now - at > RUN_WINDOW_MS || deps.now - at < 0) continue;
    if (!newest || at > newest.at) newest = { at, log: rec.log };
  }
  if (!newest) return null;
  const log = deps.readFile(newest.log);
  if (!log) return null;
  const tail = log.slice(-4096);
  const exit = tail.match(/\[origin\] agent exited with code (\d+)/g)?.pop()?.match(/(\d+)$/)?.[1];
  if (exit === undefined || exit === '0') return null;
  const when = new Date(newest.at).toISOString().slice(0, 16).replace('T', ' ');
  if (LIMIT_RE.test(tail)) return `The last background run (${when} UTC) stopped at a usage limit.`;
  if (AUTH_RE.test(tail)) return `The last background run (${when} UTC) could not sign in.`;
  return null;
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

const NONE = { signedIn: null, account: null, plan: null, method: null };

export async function probeAgent(agent: SetupAgent, deps: ProbeDeps): Promise<AgentSetupStatus> {
  const bin = AGENT_BINARIES[agent];
  const ver = await deps.run(bin, ['--version']);
  if (!ver) {
    return { agent, installed: false, version: null, ...NONE, usable: false, problem: 'Not installed.' };
  }
  let auth: Pick<AgentSetupStatus, 'signedIn' | 'account' | 'plan' | 'method'> = NONE;
  try {
    switch (agent) {
      case 'claude': {
        const r = await deps.run(bin, ['auth', 'status', '--json']);
        if (r) auth = parseClaudeStatus(r.stdout);
        break;
      }
      case 'codex': {
        const r = await deps.run(bin, ['login', 'status']);
        const home = deps.env.CODEX_HOME || path.join(deps.home, '.codex');
        if (r) auth = parseCodexStatus(r, deps.readFile(path.join(home, 'auth.json')));
        break;
      }
      case 'cursor': {
        const [s, a] = await Promise.all([deps.run(bin, ['status', '--format', 'json']), deps.run(bin, ['about', '--format', 'json'])]);
        if (s) auth = parseCursorStatus(s.stdout, a?.stdout ?? null);
        break;
      }
      case 'devin': {
        const r = await deps.run(bin, ['auth', 'status']);
        if (r) auth = parseDevinStatus(r);
        break;
      }
      case 'gemini': auth = geminiStatus(deps); break;
      case 'copilot': auth = copilotStatus(deps.env); break;
      case 'antigravity': auth = antigravityStatus(deps); break;
    }
  } catch { auth = NONE; }

  // A sign-in failure from an earlier run is stale once the agent's own status
  // says it is signed in: the person signed in since. Cursor's status says
  // signed in while its runs still fail to fetch the user, so it keeps it.
  const lastProblem = lastRunProblem(agent, deps);
  const runProblem = lastProblem && auth.signedIn === true && agent !== 'cursor' && / could not sign in\.$/.test(lastProblem) ? null : lastProblem;
  const problem = auth.signedIn === false ? 'Signed out.' : runProblem;
  return {
    agent,
    installed: true,
    version: parseVersion(ver.stdout),
    ...auth,
    usable: auth.signedIn !== false && !runProblem,
    problem,
  };
}

export async function checkAgents(deps: ProbeDeps = defaultProbeDeps(), agents: readonly SetupAgent[] = SETUP_AGENTS): Promise<AgentSetupReport> {
  const results = await Promise.all(agents.map((a) => probeAgent(a, deps)));
  return { v: 1, platform: process.platform, checkedAt: new Date(deps.now).toISOString(), agents: results };
}

/**
 * The commands `origin agents login` runs, in order, in the user's terminal.
 * Switching signs out first where the agent can — the first `signOut` steps —
 * so the caller can report the signed-out state before the sign-in starts.
 * Agents with no login command open interactively, where they ask to sign in
 * (`note` says how).
 */
export function loginSteps(agent: SetupAgent, switchAccount = false): { steps: string[][]; signOut: number; note: string | null } {
  const bin = AGENT_BINARIES[agent];
  const out = (argv: string[]) => (switchAccount ? [argv] : []);
  const pair = (logout: string[][], login: string[][], note: string | null = null) => ({ steps: [...logout, ...login], signOut: logout.length, note });
  switch (agent) {
    case 'claude': return pair(out([bin, 'auth', 'logout']), [[bin, 'auth', 'login']]);
    case 'codex': return pair(out([bin, 'logout']), [[bin, 'login']]);
    case 'cursor': return pair(out([bin, 'logout']), [[bin, 'login']]);
    case 'devin': return pair(out([bin, 'auth', 'logout']), [[bin, 'auth', 'login']]);
    case 'copilot': return pair([], [[bin, 'login']]);
    case 'gemini': return pair([], [[bin]], 'Gemini has no login command: type /auth to sign in (or switch account), then /quit.');
    case 'antigravity': return pair([], [[bin]], 'Antigravity has no login command: sign in when it asks, then exit with /quit or Ctrl+C.');
  }
}


/**
 * What a Settings → Agents link asks for:
 *   getorigin://agents/check                         refresh the report, headless
 *   getorigin://agents/login?agent=<agent>[&switch=1] the agent's login, in a terminal
 * Any page can open a getorigin:// link, so it carries only an agent from the
 * fixed list: the most a hostile one can do is open a visible terminal running
 * a fixed login command, or refresh this report to your own Origin.
 */
export type AgentSetupLink = { action: 'check' } | { action: 'login'; agent: SetupAgent; switchAccount: boolean };

export function parseAgentSetupUrl(url: string): AgentSetupLink | null {
  const m = /^getorigin:\/\/agents\/(check|login)\/?(?:\?(.*))?$/i.exec((url || '').trim());
  if (!m) return null;
  if (m[1].toLowerCase() === 'check') return { action: 'check' };
  const q = new URLSearchParams(m[2] || '');
  const agent = q.get('agent');
  if (!isSetupAgent(agent)) return null;
  return { action: 'login', agent, switchAccount: q.get('switch') === '1' };
}
