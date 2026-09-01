/**
 * Is the hook config Origin wrote into an agent's settings still the config
 * Origin's current code would write?
 *
 * Origin installs hooks once, at `origin enable`, and never looks at them
 * again. That was fine until a hook SCHEMA turned out to be wrong: #1143 fixed
 * the Antigravity file (PreToolUse/PostToolUse need a `matcher`, `Stop` must be
 * flat), but the fix lived only in the installer, so every machine that had
 * already run `enable` kept the broken file. agy discards a whole hooks.json on
 * one schema error, silently — those machines captured nothing, said nothing,
 * and could not self-heal, because the hook that would repair the file is the
 * hook the file stops from running. The only exits were noticing the silence
 * and re-running `origin enable` by hand.
 *
 * So this module compares on-disk against `HOOK_CONFIG_SPECS[].expected()` —
 * the very payloads the installers write — and rewrites what has drifted.
 * Both sides come from one definition, which is what keeps a checker from
 * becoming a second copy of the schema that drifts on its own. It is
 * agent-agnostic on purpose: the same stale-config class applies to cursor,
 * codex, copilot, devin and gemini, and to any future schema change.
 *
 * What it will NOT do: install an agent that isn't installed. `absent` means
 * the user never enabled that agent here, and repairing it would silently turn
 * on capture they didn't ask for.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  HOOK_CONFIG_SPECS,
  agentDisplayName,
  backupExistingHooks,
  isOriginHookCommand,
  type AgentType,
  type HookConfigSpec,
} from './commands/enable.js';
import { listEnabledRepos } from './enabled-repos.js';
import { getGitRoot } from './session-state.js';

export type HookConfigState =
  /** On disk is exactly what the current installer writes. */
  | 'ok'
  /** Origin is installed here, but the shape differs — capture is at risk. */
  | 'stale'
  /** Shape matches; only the embedded launcher path moved (e.g. a new Node). */
  | 'relocated'
  /** Origin's marker is in the file, but the file no longer parses as JSON. */
  | 'unreadable'
  /** Origin was never installed here. Not ours to write. */
  | 'absent';

export interface HookConfigReport {
  agent: AgentType;
  agentName: string;
  /** Absolute path of the config file. */
  file: string;
  /** Display path — `~`-relative for a global install. */
  label: string;
  state: HookConfigState;
  /** For a drifted config, what differs. */
  detail?: string;
  spec: HookConfigSpec;
  basePath: string;
}

/** A config file in one of these states is Origin's to rewrite. */
const REPAIRABLE: HookConfigState[] = ['stale', 'relocated', 'unreadable'];

export function isRepairable(state: HookConfigState): boolean {
  return REPAIRABLE.includes(state);
}

// ─── Reading Origin's region out of a config file ─────────────────────────

function valueAt(doc: any, keys: string[]): any {
  let cur = doc;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Does this hook entry belong to Origin? Deep-scans for a command string we
 * installed rather than knowing each agent's nesting, because the nesting
 * genuinely differs per agent (`{hooks:[{command}]}`, `{command}`,
 * `{matcher,hooks:[…]}`, and a flat `{command}` in the same file for agy).
 */
export function mentionsOriginCommand(value: unknown): boolean {
  if (typeof value === 'string') return isOriginHookCommand(value);
  if (Array.isArray(value)) return value.some(mentionsOriginCommand);
  if (value && typeof value === 'object') return Object.values(value).some(mentionsOriginCommand);
  return false;
}

const ORIGIN_COMMAND_TAIL = /\bhooks (claude-code|cursor|gemini|devin|windsurf|codex|copilot|antigravity|aider)\b/;

/**
 * Drop the launcher prefix from Origin's command strings — `PATH=/…/bin:$PATH
 * origin hooks cursor stop` and `"C:\…\node.exe" "…\index.js" hooks cursor
 * stop` both become `hooks cursor stop`.
 *
 * Used to tell the two drift classes apart. A wrong SHAPE means the agent may
 * reject the file and capture nothing; a moved launcher path (a Node upgrade,
 * an nvm switch, a reinstall to a different prefix) means the shape is right
 * and only the path needs refreshing. Both get repaired, but only the first is
 * worth interrupting the user about.
 */
function stripLauncherPaths(value: any): any {
  if (typeof value === 'string') {
    const m = value.match(ORIGIN_COMMAND_TAIL);
    return m && m.index !== undefined ? value.slice(m.index) : value;
  }
  if (Array.isArray(value)) return value.map(stripLauncherPaths);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripLauncherPaths(v);
    return out;
  }
  return value;
}

/** Key-order-independent structural comparison. */
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Origin's current footprint inside a parsed config document.
 *
 * For an `events` spec this deliberately also picks up Origin entries sitting
 * under event names we NO LONGER write. Those are dead registrations from an
 * older CLI — Cursor's `agentSessionStart` is the known one, and Cursor 2.6
 * rejects the whole file over an unknown event name — so they must read as
 * drift, not as "matching", and the repair below sweeps them.
 */
function observedRegion(spec: HookConfigSpec, doc: any): any {
  if (spec.mode === 'owned') return valueAt(doc, spec.at);

  const container = valueAt(doc, spec.at);
  if (!container || typeof container !== 'object') return undefined;
  const expected = spec.expected() as Record<string, any[]>;
  const observed: Record<string, any[]> = {};
  for (const key of Object.keys(container)) {
    if (!Array.isArray(container[key])) continue;
    const ours = container[key].filter(mentionsOriginCommand);
    if (ours.length > 0 || key in expected) observed[key] = ours;
  }
  for (const key of Object.keys(expected)) {
    if (!(key in observed)) observed[key] = [];
  }
  // No Origin entry anywhere under this container → not installed.
  if (Object.values(observed).every((entries) => entries.length === 0)) return undefined;
  return observed;
}

/**
 * Name the keys that differ, so a warning can say what actually broke rather
 * than just "does not match". For an `events` spec those are event names; for
 * an `owned` region they're the keys of the block Origin owns — which for
 * Antigravity is again the event names, the useful thing to print.
 */
function describeDrift(spec: HookConfigSpec, observed: any): string | undefined {
  const expected = spec.expected();
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return undefined;
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return undefined;
  const drifted: string[] = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(observed)])) {
    if (canonical((expected as any)[key]) !== canonical(observed[key])) drifted.push(key);
  }
  return drifted.length > 0 ? drifted.join(', ') : undefined;
}

// ─── Checking ─────────────────────────────────────────────────────────────

export function checkHookConfig(spec: HookConfigSpec, basePath: string): HookConfigReport {
  const file = spec.filePath(basePath);
  const base: Omit<HookConfigReport, 'state'> = {
    agent: spec.agent,
    agentName: agentDisplayName(spec.agent),
    file,
    label: spec.label(basePath),
    spec,
    basePath,
  };

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { ...base, state: 'absent' };
  }

  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    // Unparseable. Only claim it if Origin's marker is in there — otherwise
    // it's the user's broken file and rewriting it would destroy their config.
    return ORIGIN_COMMAND_TAIL.test(raw)
      ? { ...base, state: 'unreadable', detail: 'file is not valid JSON' }
      : { ...base, state: 'absent' };
  }

  const observed = observedRegion(spec, doc);
  if (observed === undefined) return { ...base, state: 'absent' };

  const expected = spec.expected();
  if (canonical(observed) === canonical(expected)) return { ...base, state: 'ok' };

  if (canonical(stripLauncherPaths(observed)) === canonical(stripLauncherPaths(expected))) {
    return { ...base, state: 'relocated', detail: 'the origin launcher path it points at has moved' };
  }

  return { ...base, state: 'stale', detail: describeDrift(spec, observed) };
}

/**
 * Check every agent Origin can install at `basePath`. Specs that don't apply
 * on this platform are left out entirely — there is nothing on disk to drift.
 */
export function checkHookConfigs(basePath: string): HookConfigReport[] {
  return HOOK_CONFIG_SPECS
    .filter((spec) => !spec.skip?.())
    .map((spec) => checkHookConfig(spec, basePath));
}

// ─── Repair ───────────────────────────────────────────────────────────────

/**
 * Rewrite Origin's region of one config file to what the current code writes,
 * leaving everything else in the file untouched.
 *
 * This is a targeted rewrite rather than a re-run of the agent's installer, on
 * purpose. `installClaudeHooks` also sweeps Origin hooks out of OTHER settings
 * layers (~/.claude vs the repo's) to avoid double-firing, which is right at
 * `enable` time but would mean a background `origin upgrade` quietly tore the
 * hooks out of whatever repo the user happened to be standing in.
 */
export function repairHookConfig(report: HookConfigReport): void {
  const { spec, file } = report;
  const expected = spec.expected();

  fs.mkdirSync(path.dirname(file), { recursive: true });

  let doc: any = {};
  if (fs.existsSync(file)) {
    backupExistingHooks(file);
    try { doc = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { doc = {}; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  }

  if (spec.mode === 'owned') {
    if (spec.at.length === 0) {
      doc = expected;
    } else {
      let cur = doc;
      for (const k of spec.at.slice(0, -1)) {
        if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
      }
      cur[spec.at[spec.at.length - 1]] = expected;
    }
  } else {
    let container = doc;
    for (const k of spec.at) {
      if (!container[k] || typeof container[k] !== 'object') container[k] = {};
      container = container[k];
    }
    // Strip Origin out of EVERY event first, including event names this
    // version no longer writes, then re-add the current set. That is what
    // retires a renamed event instead of leaving a dead registration behind.
    for (const key of Object.keys(container)) {
      if (!Array.isArray(container[key])) continue;
      const before = container[key].length;
      container[key] = container[key].filter((entry: any) => !mentionsOriginCommand(entry));
      // Delete only a key WE just emptied. An array the user left empty is
      // theirs — and at the document root (Devin's hooks.v1.json has no
      // container key) that could be any top-level list at all.
      const weEmptiedIt = container[key].length === 0 && before > 0;
      if (weEmptiedIt && !(key in expected)) delete container[key];
    }
    for (const [event, entries] of Object.entries(expected as Record<string, any[]>)) {
      const existing = Array.isArray(container[event]) ? container[event] : [];
      container[event] = [...existing, ...entries];
    }
  }

  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}

/**
 * Repair every drifted config at `basePath` and return what was repaired.
 * Untouched: anything `ok`, and anything `absent` (never installed here).
 */
export function repairHookConfigs(basePath: string): HookConfigReport[] {
  const repaired: HookConfigReport[] = [];
  for (const report of checkHookConfigs(basePath)) {
    if (!isRepairable(report.state)) continue;
    try {
      repairHookConfig(report);
      repaired.push(report);
    } catch {
      // A read-only or permission-denied config isn't fatal — `origin doctor`
      // will keep reporting it.
    }
  }
  return repaired;
}

// ─── Where to look ────────────────────────────────────────────────────────

/**
 * Install bases worth checking from a command that isn't scoped to a repo:
 * the global one, every repo `enable` has registered, and the repo the user is
 * standing in (which may predate the registry).
 */
export function hookConfigBases(cwd?: string): string[] {
  const bases = new Set<string>([os.homedir()]);
  for (const repo of listEnabledRepos()) bases.add(repo);
  const here = getGitRoot(cwd);
  if (here) bases.add(here);
  return [...bases];
}
