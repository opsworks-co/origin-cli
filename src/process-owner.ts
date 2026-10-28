// Which agent process made this commit — answered from the process tree.
//
// Several agents can be live in one checkout. The commit hooks then guess the
// committing session from evidence about files, shells, branches and recency,
// and decline when that evidence ties. One fact settles it outright: git runs
// prepare-commit-msg as a child of `git commit`, which is a child of whatever
// ran it. When an agent's shell tool ran `git commit`, that agent's process is
// an ancestor of the hook.
//
// So each agent hook records the agent's process (its OWNER) in the session
// state, and prepare-commit-msg walks its own ancestry looking for one.
//
// A pid alone is not an identity. The OS hands a dead agent's pid to the next
// process (see signal-own-daemon.ts: this repo's own test suite wraps the pid
// space in about a minute), so an owner is a pid AND its start time, plus the
// boot it was recorded in (Linux start times count from boot) and the host (a
// home directory shared between machines). A recorded owner matches an
// ancestor only when all of them agree; anything else is no match, and the
// hooks keep deciding the way they did before. Nothing here guesses.
//
// macOS and Linux only. Windows answers "unsupported" and the hooks fall back
// to today's rules: a Win32_Process snapshot costs about a second per read,
// which the synchronous commit hook cannot pay.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDetailed } from './utils/exec.js';
import { isWindows } from './utils/platform.js';

export interface ProcessIdentity {
  pid: number;
  /** Start-time fingerprint: Linux clock ticks since boot, macOS `lstart` in UTC. */
  start: string;
  /** Linux boot id; absent on macOS, whose start time is absolute. */
  boot?: string;
  host?: string;
  /** Executable name, for logs only — never part of a match. */
  name?: string;
}

export interface ProcStat { ppid: number; name: string; start: string }

/** Read one process: its parent, name and start fingerprint. Null when gone or unreadable. */
export type StatFn = (pid: number) => ProcStat | null;

// The owner is the nearest ancestor of the agent hook that is not a shell or
// launcher in between: agents run hooks through `sh -c`, `env`, a node shim.
const MAX_OWNER_HOPS = 8;
// A commit hook sits under git, a hook shell, the agent's shell tool and maybe
// a script or two. Deeper than this is not an agent's commit worth the walk.
const MAX_ANCESTRY_HOPS = 24;
// The whole walk, however many hops: the commit hook is synchronous.
const WALK_BUDGET_MS = 600;
const PS_TIMEOUT_MS = 400;

// `node` is not here: the walk starts at the hook's PARENT, so Origin's own
// node process is never visited, and an npm-installed agent runs as `node`.
const TRANSIENT_NAMES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ash', 'ksh', 'tcsh', 'csh', 'env', 'timeout', 'nice', 'nohup', 'caffeinate',
]);

// Never an agent: a terminal, multiplexer or session manager is an ancestor of
// every command typed in it. Recording one as the owner would hand a person's
// own commit in another tab to the agent.
const NEVER_OWNER_NAMES = new Set([
  'launchd', 'init', 'systemd', 'login', 'sshd', 'tmux', 'screen', 'su', 'sudo',
  'terminal', 'iterm2', 'kitty', 'alacritty', 'wezterm', 'wezterm-gui', 'ghostty', 'warp', 'stable', 'hyper',
  'gnome-terminal-server', 'konsole', 'xterm', 'tmux: server',
]);

// A wrapper named after us between the agent and the hook.
const ORIGIN_SELF = /^origin(-cli)?$/i;

/**
 * Agents whose hooks are spawned by the same process that runs their shell
 * commands, so "owner is an ancestor of the commit" means "this agent ran it".
 * IDE agents (Cursor, Copilot in VS Code, Antigravity, Windsurf) are left out:
 * their hooks and terminals hang off Electron helpers, and the nearest
 * non-shell ancestor of a hook there may also be the parent of a terminal a
 * person types in.
 */
export const PROCESS_OWNER_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'codex', 'gemini']);

// A login shell shows as `-zsh`.
function baseName(command: string): string {
  return path.basename(command.trim()).replace(/^-/, '').toLowerCase();
}

function isTransient(name: string): boolean {
  const b = baseName(name);
  return TRANSIENT_NAMES.has(b) || ORIGIN_SELF.test(b);
}

/** Parse `/proc/<pid>/stat`. The name sits in parentheses and may hold spaces and `)`. */
export function parseProcStat(content: string): ProcStat | null {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = content.slice(close + 1).trim().split(/\s+/);
  // rest[0] = state (field 3), rest[1] = ppid (4), rest[19] = starttime (22).
  if (rest.length < 20) return null;
  const ppid = parseInt(rest[1], 10);
  if (!Number.isInteger(ppid) || !rest[19]) return null;
  return { ppid, name: content.slice(open + 1, close), start: rest[19] };
}

/** Parse `ps -o ppid=,lstart=,comm=` (LC_ALL=C): `<ppid> <Dow Mon DD HH:MM:SS YYYY> <comm…>`. */
export function parsePsLine(line: string): ProcStat | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 7) return null;
  const ppid = parseInt(parts[0], 10);
  if (!Number.isInteger(ppid)) return null;
  return { ppid, start: parts.slice(1, 6).join(' '), name: parts.slice(6).join(' ') };
}

function linuxStat(pid: number): ProcStat | null {
  try { return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')); } catch { return null; }
}

function psStat(pid: number): ProcStat | null {
  // UTC: `lstart` prints local time, and a time zone change between the
  // session's start and its commit (a laptop that travelled) must not read
  // as a different process.
  const r = runDetailed('ps', ['-o', 'ppid=,lstart=,comm=', '-p', String(pid)], {
    timeoutMs: PS_TIMEOUT_MS, env: { LC_ALL: 'C', TZ: 'UTC' },
  });
  if (r.status !== 0 || r.timedOut) return null;
  return parsePsLine(r.stdout.split('\n')[0] || '');
}

/** The platform's reader, or null where the process tree is not introspected (Windows). */
export function platformStat(): StatFn | null {
  if (isWindows()) return null;
  if (process.platform === 'linux') return linuxStat;
  if (process.platform === 'darwin') return psStat;
  return null;
}

/** Linux boot id. macOS needs none: `lstart` is absolute wall-clock time, fixed at exec. */
export function bootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim() || undefined; } catch { return undefined; }
}

function hostName(): string | undefined {
  try { return os.hostname() || undefined; } catch { return undefined; }
}

export interface WalkEnv {
  stat: StatFn;
  host?: string;
  boot?: string;
  now?: () => number;
}

function defaultEnv(): WalkEnv | null {
  const stat = platformStat();
  if (!stat) return null;
  return { stat, host: hostName(), boot: bootId() };
}

/**
 * The agent process this hook runs under: the nearest ancestor, from `fromPid`
 * up, that is not a shell or shim. Null when the walk fails, runs out of hops,
 * or lands on a terminal or init — never a guess at something higher up.
 */
export function resolveOwnerFrom(fromPid: number, env: WalkEnv): ProcessIdentity | null {
  const now = env.now ?? Date.now;
  const deadline = now() + WALK_BUDGET_MS;
  let pid = fromPid;
  for (let hop = 0; hop < MAX_OWNER_HOPS && pid > 1 && now() < deadline; hop++) {
    const st = env.stat(pid);
    if (!st) return null;
    if (!isTransient(st.name)) {
      if (NEVER_OWNER_NAMES.has(baseName(st.name))) return null;
      return { pid, start: st.start, boot: env.boot, host: env.host, name: baseName(st.name) };
    }
    if (st.ppid === pid) return null;
    pid = st.ppid;
  }
  return null;
}

/**
 * Owner identity for an agent hook, or null (Windows, an agent not in
 * PROCESS_OWNER_AGENTS, an unreadable tree). Never throws.
 */
export function resolveAgentOwner(agentSlug: string | null | undefined): ProcessIdentity | null {
  try {
    if (!agentSlug || !PROCESS_OWNER_AGENTS.has(agentSlug)) return null;
    const env = defaultEnv();
    if (!env) return null;
    return resolveOwnerFrom(process.ppid, env);
  } catch {
    return null;
  }
}

/** A walked chain of ancestors, nearest first. */
export interface Ancestry {
  host?: string;
  boot?: string;
  chain: ProcessIdentity[];
}

/**
 * Walk up from `fromPid`, stopping early at the first ancestor that `stopAt`
 * accepts (the nearest owner is all a commit needs). Bounded by hops and time.
 */
export function walkAncestry(fromPid: number, env: WalkEnv, stopAt?: (id: ProcessIdentity) => boolean): Ancestry {
  const now = env.now ?? Date.now;
  const deadline = now() + WALK_BUDGET_MS;
  const chain: ProcessIdentity[] = [];
  const seen = new Set<number>();
  let pid = fromPid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS && pid > 1 && !seen.has(pid) && now() < deadline; hop++) {
    seen.add(pid);
    const st = env.stat(pid);
    if (!st) break;
    const id: ProcessIdentity = { pid, start: st.start, boot: env.boot, host: env.host, name: baseName(st.name) };
    chain.push(id);
    if (stopAt?.(id)) break;
    pid = st.ppid;
  }
  return { host: env.host, boot: env.boot, chain };
}

/**
 * How far up `ancestry` the recorded `owner` sits (0 = the hook's parent), or
 * -1. The same pid with a different start time is a recycled pid, not the
 * owner. A different host or boot is never a match: the process it names
 * cannot be this one's ancestor.
 */
export function ownerDepth(ancestry: Ancestry, owner: ProcessIdentity | null | undefined): number {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 1 || !owner.start) return -1;
  if (owner.host && ancestry.host && owner.host !== ancestry.host) return -1;
  if ((owner.boot || ancestry.boot) && owner.boot !== ancestry.boot) return -1;
  for (let depth = 0; depth < ancestry.chain.length; depth++) {
    const a = ancestry.chain[depth];
    if (a.pid === owner.pid) return a.start === owner.start ? depth : -1;
  }
  return -1;
}

export type AncestryPick<T> =
  /** Exactly one session's owner is the nearest owning ancestor. */
  | { outcome: 'owner'; session: T; depth: number }
  /** Several sessions share that nearest owner (one agent process, several sessions). */
  | { outcome: 'shared'; sessions: T[]; depth: number }
  | { outcome: 'none' };

/**
 * The sessions whose recorded owner is the NEAREST owning ancestor. Nearest,
 * because an agent that runs another agent (Claude running `codex exec`) has
 * both in the commit's ancestry, and the inner one made the commit. Pure.
 */
export function pickSessionsByAncestry<T extends { ownerProcess?: ProcessIdentity | null }>(
  sessions: readonly T[],
  ancestry: Ancestry,
): AncestryPick<T> {
  let best = -1;
  let at: T[] = [];
  for (const s of sessions) {
    const d = ownerDepth(ancestry, s.ownerProcess);
    if (d < 0) continue;
    if (best < 0 || d < best) { best = d; at = [s]; } else if (d === best) at.push(s);
  }
  if (best < 0) return { outcome: 'none' };
  return at.length === 1 ? { outcome: 'owner', session: at[0], depth: best } : { outcome: 'shared', sessions: at, depth: best };
}

/**
 * For a commit hook: which of `sessions` owns the process tree it runs in.
 * Walks only when some session recorded an owner, and stops at the nearest
 * one. `{ outcome: 'none' }` on Windows or any failure. Never throws.
 */
export function pickSessionsByCommitAncestry<T extends { ownerProcess?: ProcessIdentity | null }>(
  sessions: readonly T[],
  env: WalkEnv | null = defaultEnv(),
  fromPid: number = process.ppid,
): AncestryPick<T> {
  try {
    if (!env) return { outcome: 'none' };
    const owners = sessions.map((s) => s.ownerProcess).filter((o): o is ProcessIdentity => !!o && o.pid > 1);
    if (owners.length === 0) return { outcome: 'none' };
    const pids = new Set(owners.map((o) => o.pid));
    const ancestry = walkAncestry(fromPid, env, (id) => pids.has(id.pid) && owners.some((o) => o.pid === id.pid && o.start === id.start));
    return pickSessionsByAncestry(sessions, ancestry);
  } catch {
    return { outcome: 'none' };
  }
}
