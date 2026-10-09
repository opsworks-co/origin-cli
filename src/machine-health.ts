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
  /** `global` = ~ install, `repo` = the session's repo. */
  scope: 'global' | 'repo';
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

function readGlobalHooksPath(): string {
  try {
    return execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 2000,
    }).trim();
  } catch { return ''; }
}

function repoHasOriginPostCommit(repoPath: string): boolean {
  try {
    const hook = fs.readFileSync(path.join(repoPath, '.git', 'hooks', 'post-commit'), 'utf-8');
    return /\borigin\b/.test(hook);
  } catch { return false; }
}

/** Compute the report now (no cache). Exported for tests and `--fresh` callers. */
export async function computeMachineHealth(opts: {
  repoPath?: string | null;
  detectedTools?: string[];
  cliVersion?: string;
} = {}): Promise<MachineHealth> {
  const { checkHookConfigs } = await import('./hook-config-health.js');
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
      repo: repo ? repoHasOriginPostCommit(repo) : null,
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
