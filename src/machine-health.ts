/**
 * A small "is Origin actually wired up on this machine?" report, sent with
 * `POST /api/mcp/session/start` so an org admin's Rollout view can tell a
 * developer whose capture is broken from one who simply isn't coding.
 *
 * Everything here was already computed CLI-side (`origin doctor` reads the
 * same hook configs through hook-config-health) but never left the machine,
 * so an admin had no way to see a teammate's drifted hooks or a CLI three
 * releases behind. This rides on a call the CLI already makes — no new
 * network request — and is cached in ~/.origin for an hour so a session start
 * costs one small file read on the common path. It never throws: a failure to
 * compute health must not cost a session.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export interface MachineHealthAgent {
  agent: string;
  /**
   * `global` = ~ install, `repo` = the session's repo, `fired` = no config
   * found where we look, but this agent ran one of Origin's hooks on this
   * machine in the last day (HOOK_FIRED_WINDOW_MS) — proof the wiring works.
   */
  scope: 'global' | 'repo' | 'fired';
  state: 'ok' | 'stale' | 'relocated' | 'unreadable';
}

export interface MachineHealth {
  v: 1;
  cliVersion: string;
  platform: string;
  checkedAt: string;
  hooks: {
    /** Agent hook configs Origin wrote, in any state. */
    installed: number;
    /** Of those, configs that no longer match this CLI (doctor --fix rewrites them). */
    drifted: number;
    /** Agents detected on this machine with no Origin hook config anywhere checked. */
    missing: string[];
    agents: MachineHealthAgent[];
  };
  gitHooks: {
    /** Global `core.hooksPath` points at Origin's hooks dir. */
    global: boolean;
    /** The session repo's own .git/hooks/post-commit is Origin's (null: no repo). */
    repo: boolean | null;
  };
}

/** How long a computed report is reused before a session start recomputes it. */
export const MACHINE_HEALTH_TTL_MS = 60 * 60 * 1000;

/** `detectTools()` names → hook-config agent ids. Tools without hooks are left out. */
const TOOL_TO_AGENT: Record<string, string> = {
  claude: 'claude-code',
  cursor: 'cursor',
  gemini: 'gemini',
  devin: 'devin',
  codex: 'codex',
  antigravity: 'antigravity',
  copilot: 'copilot',
};

function cachePath(): string {
  return path.join(os.homedir(), '.origin', 'machine-health.json');
}

const GIT_READ = { encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 2000 };

function readGlobalHooksPath(): string {
  try {
    // --includes: `--global` alone skips `[include]`/`[includeIf]` files, and a
    // developer with two git identities keeps per-directory settings in those.
    return execFileSync('git', ['config', '--global', '--includes', '--get', 'core.hooksPath'], GIT_READ).trim();
  } catch { return ''; }
}

/**
 * Does git, committing in this repo, run an Origin post-commit? Asks git for
 * the hooks dir it actually uses — `rev-parse --git-path hooks` honours a
 * `core.hooksPath` from any config scope (repo-local, includeIf, system) and a
 * linked worktree's common dir — instead of assuming `<repo>/.git/hooks`.
 */
function repoHasOriginPostCommit(repoPath: string, isOriginHooksPath: (p: string) => boolean): boolean {
  const dirs: string[] = [];
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { ...GIT_READ, cwd: repoPath }).trim();
    if (out && isOriginHooksPath(out)) return true;
    if (out) dirs.push(out);
  } catch { /* not a repo, or a git too old for --path-format */ }
  dirs.push(path.join(repoPath, '.git', 'hooks'));
  for (const dir of dirs) {
    try {
      const hook = fs.readFileSync(path.join(dir, 'post-commit'), 'utf-8');
      if (/\borigin\b/.test(hook)) return true;
    } catch { /* no hook there */ }
  }
  return false;
}

// ─── Hooks that actually fired ────────────────────────────────────────────
//
// A config check can only look where we think hooks live. Claude Code alone
// reads them from ~/.claude/settings.json, settings.local.json at both levels,
// $CLAUDE_CONFIG_DIR, enterprise managed settings and plugins — and a report
// that misses the one a developer uses calls a machine that IS capturing
// "hooks-broken" (Ihor's MacBook, 2026-11-03: the report said no Claude Code
// hooks 50 ms after a Claude Code hook started his session). So every agent
// hook stamps that it ran, and a recent stamp counts as installed.

/** A hook stamp younger than this counts as "this agent's hooks work here". */
export const HOOK_FIRED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Re-stamp at most this often — hooks fire on every tool call. */
const HOOK_FIRED_RESTAMP_MS = 10 * 60 * 1000;

function hookFiredDir(): string {
  return path.join(os.homedir(), '.origin', 'hook-fired');
}

function readHookFiredAt(agent: string): number {
  try {
    return Date.parse(fs.readFileSync(path.join(hookFiredDir(), agent), 'utf-8').trim());
  } catch { return NaN; }
}

/** Called by `origin hooks <agent> <event>` before it handles the event. Never throws. */
export function recordHookFired(agent: string | undefined, now: number = Date.now()): void {
  if (!agent || !Object.values(TOOL_TO_AGENT).includes(agent)) return;
  try {
    const prev = readHookFiredAt(agent);
    if (Number.isFinite(prev) && now - prev >= 0 && now - prev < HOOK_FIRED_RESTAMP_MS) return;
    fs.mkdirSync(hookFiredDir(), { recursive: true });
    fs.writeFileSync(path.join(hookFiredDir(), agent), new Date(now).toISOString());
  } catch { /* evidence is best-effort */ }
}

/** Agents whose Origin hooks ran on this machine within HOOK_FIRED_WINDOW_MS. */
export function agentsWithRecentHookFires(now: number = Date.now()): string[] {
  return [...new Set(Object.values(TOOL_TO_AGENT))].filter((agent) => {
    const at = readHookFiredAt(agent);
    return Number.isFinite(at) && now - at >= -60_000 && now - at < HOOK_FIRED_WINDOW_MS;
  }).sort();
}

/**
 * Claude Code settings files beyond `<base>/.claude/settings.json` that can
 * carry its hooks: settings.local.json at both levels, and the user dir
 * `$CLAUDE_CONFIG_DIR` points at instead of ~/.claude.
 */
function extraClaudeSettingsFiles(home: string, repo: string | null): Array<[string, 'global' | 'repo']> {
  const files: Array<[string, 'global' | 'repo']> = [[path.join(home, '.claude', 'settings.local.json'), 'global']];
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir && path.resolve(configDir) !== path.join(home, '.claude')) {
    files.push([path.join(configDir, 'settings.json'), 'global'], [path.join(configDir, 'settings.local.json'), 'global']);
  }
  if (repo) files.push([path.join(repo, '.claude', 'settings.local.json'), 'repo']);
  return files;
}

/** Compute the report now (no cache). Exported for tests and `--fresh` callers. */
export async function computeMachineHealth(opts: {
  repoPath?: string | null;
  detectedTools?: string[];
  cliVersion?: string;
} = {}): Promise<MachineHealth> {
  const { checkHookConfigs, checkHookConfig } = await import('./hook-config-health.js');
  const { HOOK_CONFIG_SPECS } = await import('./commands/enable.js');
  const { isOriginHooksPath } = await import('./global-hooks-path.js');
  const cliVersion = opts.cliVersion ?? (await import('./cli-version.js')).cliVersion();

  const home = os.homedir();
  const repo = opts.repoPath && opts.repoPath !== home ? opts.repoPath : null;
  const agents: MachineHealthAgent[] = [];
  const seen = new Set<string>();
  for (const [base, scope] of [[home, 'global'], ...(repo ? [[repo, 'repo']] : [])] as Array<[string, 'global' | 'repo']>) {
    for (const report of checkHookConfigs(base)) {
      if (report.state === 'absent') continue;
      seen.add(report.agent);
      agents.push({ agent: report.agent, scope, state: report.state });
    }
  }
  const fired = agentsWithRecentHookFires();
  const claudeSpec = HOOK_CONFIG_SPECS.find((spec) => spec.agent === 'claude-code');
  if (claudeSpec) {
    for (const [file, scope] of extraClaudeSettingsFiles(home, repo)) {
      const report = checkHookConfig({ ...claudeSpec, filePath: () => file }, path.dirname(path.dirname(file)));
      if (report.state === 'absent') continue;
      seen.add(report.agent);
      // `origin doctor --fix` doesn't rewrite these files, so a drift here is
      // one the Rollout view's fix can't clear. When the hooks demonstrably
      // run anyway, report them as working rather than as unfixable drift.
      agents.push({ agent: report.agent, scope, state: fired.includes(report.agent) ? 'ok' : report.state });
    }
  }
  for (const agent of fired) {
    if (seen.has(agent)) continue;
    seen.add(agent);
    agents.push({ agent, scope: 'fired', state: 'ok' });
  }

  let detected = opts.detectedTools;
  if (!detected) {
    try { detected = (await import('./config.js')).loadAgentConfig()?.detectedTools ?? []; } catch { detected = []; }
  }
  const missing = [...new Set((detected || []).map((t) => TOOL_TO_AGENT[t]).filter(Boolean))]
    .filter((agent) => !seen.has(agent))
    .sort();

  return {
    v: 1,
    cliVersion,
    platform: process.platform,
    checkedAt: new Date().toISOString(),
    hooks: {
      installed: agents.length,
      drifted: agents.filter((a) => a.state !== 'ok').length,
      missing,
      agents,
    },
    gitHooks: {
      global: isOriginHooksPath(readGlobalHooksPath()),
      repo: repo ? repoHasOriginPostCommit(repo, isOriginHooksPath) : null,
    },
  };
}

/**
 * The report to attach to a session start: the cached one when it is under an
 * hour old, for the same repo and CLI version, else a fresh one (then cached).
 * Returns undefined on any failure.
 */
export async function machineHealthForUpload(repoPath?: string | null, now: number = Date.now()): Promise<MachineHealth | undefined> {
  try {
    const { cliVersion } = await import('./cli-version.js');
    const version = cliVersion();
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
      const at = Date.parse(cached?.health?.checkedAt);
      if (
        cached?.health?.v === 1
        && cached.repoPath === (repoPath || null)
        && cached.health.cliVersion === version
        && Number.isFinite(at) && now - at >= 0 && now - at < MACHINE_HEALTH_TTL_MS
        // A hook that fired since the report was cached is news the report
        // must carry — otherwise the very session start a hook makes would
        // upload an hour-old "no hooks" for that agent.
        && agentsWithRecentHookFires(now).every((agent) =>
          (cached.health.hooks?.agents || []).some((a: MachineHealthAgent) => a.agent === agent))
      ) {
        return cached.health as MachineHealth;
      }
    } catch { /* no cache yet */ }

    const health = await computeMachineHealth({ repoPath, cliVersion: version });
    try {
      fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
      fs.writeFileSync(cachePath(), JSON.stringify({ repoPath: repoPath || null, health }));
    } catch { /* cache is an optimisation */ }
    return health;
  } catch {
    return undefined;
  }
}
