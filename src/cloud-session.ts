// Origin capture in Claude Code cloud sessions (claude.ai/code, `claude --cloud`,
// the desktop app's Cloud environments).
//
// A cloud session is a fresh VM with a fresh clone of the repo. It never reads
// ~/.claude/settings.json, where `origin enable` puts Origin's hooks, and it has
// no `origin` binary and no ~/.origin/config.json. What it does read is the
// repo's committed `.claude/settings.json`, in a session with one repository.
//
// So `origin enable --cloud` commits two things to the repo:
//   - .claude/hooks/origin-cloud.sh — exits at once unless CLAUDE_CODE_REMOTE is
//     "true" (the cloud VM sets it; it is never set locally), so on a laptop the
//     machine-wide hooks keep doing the capture and nothing fires twice. In the
//     VM, the first SessionStart installs the CLI and runs `origin cloud
//     bootstrap`; then every event goes to `origin hooks claude-code <event>`.
//   - Claude hook entries in .claude/settings.json that call that script.
//
// The entries call the script, not `origin hooks claude-code …`, on purpose:
// the layer sweepers (cleanupOriginClaudeHooksOutsideOf in enable.ts,
// dedupeOriginHookLayers in hooks.ts) strip any `hooks claude-code` command
// they find in a project settings file, and would delete these from the repo.
//
// The key: either ORIGIN_API_KEY set on the cloud environment, or — so the key
// never enters the VM — a network secret on the environment that sends it as
// the X-Origin-Proxy-Key header to the Origin host. In that case the CLI keeps
// the placeholder below as its key and the server swaps the real one in
// (apps/api/src/middleware/cloud-proxy-key.ts).

import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, saveConfig, loadAgentConfig, saveAgentConfig } from './config.js';
import { getGitRoot, getWorkingGitRoot } from './session-state.js';
import { claudeHookEvents, CLAUDE_SESSION_END_HOOK_TIMEOUT_SEC, configureNotesRefspecAndFetch, installGlobalGitHooks } from './commands/enable.js';

export const CLOUD_HOOK_SCRIPT = '.claude/hooks/origin-cloud.sh';
/** Mirrors CLOUD_PROXY_KEY_PLACEHOLDER in apps/api/src/middleware/cloud-proxy-key.ts. */
export const CLOUD_PROXY_KEY_PLACEHOLDER = 'origin-cloud-proxy';
export const CLOUD_PROXY_KEY_HEADER = 'X-Origin-Proxy-Key';
/** One machine row per workspace for every cloud VM (the server upserts machines by hostname). */
export const CLOUD_MACHINE_HOSTNAME = 'claude-code-cloud';
const DEFAULT_API_URL = 'https://getorigin.io';
// The first SessionStart installs the CLI; Claude's default 600 s is plenty,
// but say it so a slow npm doesn't meet a shorter default later.
const CLOUD_SESSION_START_TIMEOUT_SEC = 300;

export function isCloudSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_REMOTE === 'true';
}

/**
 * The committed hook script. POSIX sh. Its stdout on SessionStart becomes
 * context for Claude, so everything the install and bootstrap print goes to
 * stderr; only `origin hooks` itself writes to stdout.
 */
export function cloudHookScript(apiUrl: string = DEFAULT_API_URL): string {
  return `#!/bin/sh
# Origin capture for Claude Code cloud sessions. Written by \`origin enable --cloud\`.
# On your own machine this exits at once: the hooks \`origin enable\` installed
# machine-wide capture there. In a cloud session (CLAUDE_CODE_REMOTE=true) it
# installs the Origin CLI on the first SessionStart and hands every event to it.
[ "\${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

event="$1"
api_url="\${ORIGIN_API_URL:-${apiUrl}}"
# Where install.sh's \`npm install -g\` puts the binary, after anything already on PATH.
PATH="$PATH:$(npm prefix -g 2>/dev/null)/bin:$HOME/.npm-global/bin"
export PATH

if ! command -v origin >/dev/null 2>&1; then
  # Install once, at session start. A later event with no CLI is skipped, not failed.
  [ "$event" = "session-start" ] || exit 0
  if ! curl -fsSL "$api_url/install.sh" | sh -s -- --api-url "$api_url" >&2; then
    echo "origin: could not install the Origin CLI from $api_url (is it on the environment's allowed domains?)" >&2
    exit 0
  fi
  command -v origin >/dev/null 2>&1 || exit 0
fi

if [ "$event" = "session-start" ]; then
  origin cloud bootstrap --api-url "$api_url" >&2 || true
fi
exec origin hooks claude-code "$event"
`;
}

const cloudHookCommand = (event: string) => `sh "$CLAUDE_PROJECT_DIR/${CLOUD_HOOK_SCRIPT}" ${event}`;

export function isOriginCloudHookCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.includes(CLOUD_HOOK_SCRIPT);
}

/** The repo's Claude hook entries: the same events the machine-wide install registers. */
export function cloudClaudeHookEvents(): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const [eventType, entries] of Object.entries(claudeHookEvents())) {
    const local = entries[0]?.hooks?.[0]?.command as string;
    const event = local.split('hooks claude-code ')[1].trim();
    const hook: Record<string, any> = { type: 'command', command: cloudHookCommand(event) };
    if (eventType === 'SessionStart') hook.timeout = CLOUD_SESSION_START_TIMEOUT_SEC;
    if (eventType === 'SessionEnd') hook.timeout = CLAUDE_SESSION_END_HOOK_TIMEOUT_SEC;
    out[eventType] = [{ hooks: [hook] }];
  }
  return out;
}

/** Write the script and merge the hook entries into `<gitRoot>/.claude/settings.json`. Idempotent. */
export function installCloudHooks(gitRoot: string, apiUrl?: string): { settingsPath: string; scriptPath: string } {
  const scriptPath = path.join(gitRoot, CLOUD_HOOK_SCRIPT);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, cloudHookScript(apiUrl));
  fs.chmodSync(scriptPath, 0o755);

  const settingsPath = path.join(gitRoot, '.claude', 'settings.json');
  let settings: Record<string, any> = {};
  // No .origin-backup copy here, unlike the machine-wide install: the file is
  // committed, so git already has the old version, and a stray backup beside
  // it would only get committed too.
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  for (const [eventType, entries] of Object.entries(cloudClaudeHookEvents())) {
    const existing: any[] = Array.isArray(settings.hooks[eventType]) ? settings.hooks[eventType] : [];
    const kept = existing.filter((e) => !(Array.isArray(e?.hooks) && e.hooks.some((h: any) => isOriginCloudHookCommand(h?.command))));
    settings.hooks[eventType] = [...kept, ...entries];
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { settingsPath, scriptPath };
}

/** `origin enable --cloud` */
export function enableCloudCommand(opts: { apiUrl?: string; cwd?: string } = {}): void {
  // The checkout being worked in, not the main repo: in a linked worktree the
  // files belong on that worktree's branch, and the main checkout may be
  // another session's.
  const gitRoot = getWorkingGitRoot(opts.cwd);
  if (!gitRoot) {
    console.log(chalk.red('Not inside a git repository. Run this from your project directory.'));
    process.exit(1);
  }
  const apiUrl = (opts.apiUrl || loadConfig()?.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  installCloudHooks(gitRoot, apiUrl);
  const host = new URL(apiUrl).host;
  console.log(chalk.bold('\n☁️  Origin capture for Claude Code cloud sessions\n'));
  console.log(chalk.green(`  ✓ Wrote ${CLOUD_HOOK_SCRIPT}`));
  console.log(chalk.green('  ✓ Added its hooks to .claude/settings.json'));
  console.log(chalk.gray('    They do nothing on your machine (they run only when CLAUDE_CODE_REMOTE=true).'));
  console.log(chalk.white('\n  Next:'));
  console.log(chalk.white('  1. Commit and push both files. Cloud sessions read them from the clone.'));
  console.log(chalk.white('  2. At claude.ai/code, edit the cloud environment you use:'));
  console.log(chalk.white(`     • Network secrets → Add secret: allowed website ${host},`));
  console.log(chalk.white(`       custom header ${CLOUD_PROXY_KEY_HEADER}, no prefix, value = your Origin API key.`));
  console.log(chalk.gray('       The key never enters the VM, and the secret also lets sessions reach the host.'));
  console.log(chalk.gray(`     • Or instead: ORIGIN_API_KEY=<key> under Environment variables, and ${host}`));
  console.log(chalk.gray('       under Network access → Custom → Allowed domains (anyone using the environment can read the variable).'));
  console.log(chalk.gray('\n  Not covered: sessions with several repositories, and threads in a Claude project —'));
  console.log(chalk.gray('  Claude Code runs no repository hooks there.\n'));
}

export interface CloudBootstrapDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  log: (msg: string) => void;
  cwd: string;
}

/**
 * Turn the key the session gets into ~/.origin/config.json. Checks it with
 * /api/mcp/whoami first, so a missing or wrong key says so here, once, rather
 * than as a 401 on every hook. Returns false when there is no usable key.
 */
export async function writeCloudConfig(apiUrl: string, deps: Pick<CloudBootstrapDeps, 'env' | 'fetch' | 'log'>): Promise<boolean> {
  if (loadConfig()?.apiKey) return true;
  const envKey = deps.env.ORIGIN_API_KEY?.trim();
  const key = envKey || CLOUD_PROXY_KEY_PLACEHOLDER;
  let data: any;
  try {
    const res = await deps.fetch(`${apiUrl}/api/mcp/whoami`, { headers: { 'X-API-Key': key } });
    if (!res.ok) {
      deps.log(res.status === 401
        ? (envKey
          ? 'origin: ORIGIN_API_KEY was rejected (HTTP 401). Check the key on the cloud environment.'
          : `origin: no Origin key reached the server. Add a network secret for this host with the ${CLOUD_PROXY_KEY_HEADER} header, or set ORIGIN_API_KEY on the cloud environment.`)
        : `origin: ${apiUrl} answered HTTP ${res.status}; capturing without an account this session.`);
      return false;
    }
    data = await res.json();
  } catch (err: any) {
    deps.log(`origin: could not reach ${apiUrl} (${err?.message || err}); capturing without an account this session.`);
    return false;
  }
  saveConfig({
    ...(loadConfig() || {}),
    apiUrl,
    apiKey: key,
    orgId: data?.orgId || '',
    userId: '',
    keyType: data?.keyType,
    accountType: data?.accountType,
    orgName: data?.orgName || '',
  } as any);
  return true;
}

/**
 * `origin cloud bootstrap` — set up a cloud VM for capture. Run by the hook
 * script on SessionStart, before `origin hooks claude-code session-start`.
 *
 * Unlike `origin enable` it installs NO Claude hooks: the repo's hooks are the
 * ones that fire here, and a ~/.claude/settings.json copy would make every
 * event fire twice. It does install the git hooks (commit capture) and the
 * notes refspec (repo memory), which live only in this VM.
 */
export async function cloudBootstrapCommand(opts: { apiUrl?: string } = {}, deps: CloudBootstrapDeps = {
  env: process.env, fetch: globalThis.fetch, log: (m) => console.error(m), cwd: process.cwd(),
}): Promise<void> {
  if (!isCloudSession(deps.env)) {
    deps.log('origin cloud bootstrap: not a Claude Code cloud session (CLAUDE_CODE_REMOTE is not "true"); nothing to do.');
    return;
  }
  const apiUrl = (opts.apiUrl || deps.env.ORIGIN_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  const connected = await writeCloudConfig(apiUrl, deps);

  if (connected && !loadAgentConfig()) {
    const machineId = crypto.randomUUID();
    try {
      const { api } = await import('./api.js');
      await api.registerMachine({ hostname: CLOUD_MACHINE_HOSTNAME, machineId, detectedTools: [] });
    } catch { /* best-effort, as in `origin enable` */ }
    saveAgentConfig({ machineId, hostname: CLOUD_MACHINE_HOSTNAME, detectedTools: [], orgId: loadConfig()?.orgId || 'local' });
  }

  const globalHooksDir = path.join(os.homedir(), '.origin', 'git-hooks');
  if (!fs.existsSync(path.join(globalHooksDir, 'post-commit'))) {
    // These print to stdout; the hook script sends this command's stdout to
    // stderr, so none of it lands in Claude's context.
    installGlobalGitHooks();
    const gitRoot = getGitRoot(deps.cwd);
    if (gitRoot) configureNotesRefspecAndFetch(gitRoot);
  }
}
