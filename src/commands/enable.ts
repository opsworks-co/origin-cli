import crypto from 'crypto';
import { syncNotesFromRemote } from '../git-notes.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { run, runDetailed, findExecutable } from '../utils/exec.js';
import { isWindows } from '../utils/platform.js';
import { loadConfig, saveConfig, saveRepoConfig, isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { getGitRoot } from '../session-state.js';

// ─── PATH Resolution ─────────────────────────────────────────────────────
// Hooks run in a minimal shell environment where `origin` may not be in PATH.
// Resolve the bin directory at install time and embed it in hook commands.

function getOriginBinPath(): string {
  // 1. Resolve from the currently running process (most reliable)
  try {
    const selfBin = process.argv[1];
    if (selfBin) {
      const realSelf = fs.realpathSync(selfBin);
      const dir = path.dirname(realSelf);
      for (const candidate of [path.dirname(selfBin), dir]) {
        if (fs.existsSync(path.join(candidate, 'origin'))) return candidate;
      }
    }
  } catch { /* fallback */ }

  // 2. which/where origin
  try {
    const binPath = findExecutable('origin');
    if (binPath) return path.dirname(binPath);
  } catch { /* fallback */ }

  // 3. Common locations
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (fs.existsSync(path.join(dir, 'origin'))) return dir;
  }

  // 4. NVM locations
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        const binDir = path.join(nvmDir, v, 'bin');
        if (fs.existsSync(path.join(binDir, 'origin'))) return binDir;
      }
    }
  } catch { /* fallback */ }

  return '';
}

// Absolute path to the CLI's own JS entry point (dist/index.js), so Windows
// hook commands can invoke `node.exe <entry>` and skip npm's `origin.cmd` batch
// shim (which drags cmd.exe — and a visible console window — into every hook
// fire). Returns '' when it can't be resolved with confidence, in which case
// the caller falls back to the shim.
function cliEntryScript(): string {
  try {
    const entry = process.argv[1];
    if (!entry) return '';
    const abs = path.resolve(entry);
    // Only trust a real .js file — `origin` may itself have been launched via
    // the .cmd shim or a bundler stub we shouldn't hard-code into hooks.
    if (!abs.toLowerCase().endsWith('.js') || !fs.existsSync(abs)) return '';
    return abs;
  } catch {
    return '';
  }
}

function originCmd(cmd: string): string {
  if (isWindows()) {
    // The POSIX `PATH=dir:$PATH origin …` shim is invalid under cmd/PowerShell,
    // which is what agents run their hooks-json `command`/`bash` field through
    // on native Windows. Emit an absolute-path invocation instead — valid in
    // cmd, PowerShell, and git-bash alike — so agents WITHOUT a `powershell`
    // field (Cursor/Codex/Gemini/Claude/Antigravity) still fire on Windows.
    // (These commands are agent-run; git hooks use their own #!/bin/sh shim.)
    const args = cmd.replace(/^origin\b\s*/, '');

    // Prefer `node.exe <cli-entry.js>` over npm's `origin.cmd` shim. The shim is
    // a BATCH file, so every hook fire launches cmd.exe to interpret it — and
    // under a GUI agent (Codex Desktop) that cmd.exe gets a visible console
    // window. Codex fires session-start/user-prompt-submit/stop constantly, so
    // the user saw an endless stream of cmd windows. Invoking node directly
    // removes the interpreter entirely (one process instead of two).
    const entry = cliEntryScript();
    if (entry) {
      const node = /\s/.test(process.execPath) ? `"${process.execPath}"` : process.execPath;
      const js = /\s/.test(entry) ? `"${entry}"` : entry;
      return `${node} ${js} ${args}`.trim();
    }

    const bin = originBinaryPath();
    if (bin === 'origin') return cmd; // unresolved → rely on PATH
    const quoted = /\s/.test(bin) ? `"${bin}"` : bin;
    return `${quoted} ${args}`.trim();
  }
  const binDir = getOriginBinPath();
  if (binDir && binDir !== '/usr/bin' && binDir !== '/bin') {
    return `PATH=${binDir}:$PATH ${cmd}`;
  }
  return cmd;
}

// True if a hook entry's command string is one Origin installed, in ANY shell
// form: the unix `PATH=… origin hooks cursor …`, the Windows `"C:\…\origin.cmd"
// hooks cursor …`, or a bare `origin hooks cursor …`. Keys off the shell-
// agnostic `hooks <agent>` marker (NOT the literal `origin hooks`, which the
// Windows form breaks) so idempotent re-install finds prior entries on every
// platform. Pass `agent` to scope to one agent's entries; omit to match any.
function isOriginHookCommand(cmd: unknown, agent?: string): boolean {
  if (typeof cmd !== 'string') return false;
  if (agent) return cmd.includes(`hooks ${agent} `) || cmd.endsWith(`hooks ${agent}`);
  return /\bhooks (claude-code|cursor|gemini|devin|windsurf|codex|copilot|antigravity|aider)\b/.test(cmd);
}

// Absolute path to the origin launcher, for embedding in native-shell hooks
// (the PowerShell variant below). Mirrors the unix PATH-shim's intent: agent
// processes may not inherit the install dir on PATH, so point at it directly.
function originBinaryPath(): string {
  try {
    const resolved = findExecutable('origin');
    if (resolved) return resolved;
  } catch { /* fall through */ }
  const binDir = getOriginBinPath();
  if (binDir) return path.join(binDir, isWindows() ? 'origin.cmd' : 'origin');
  return 'origin';
}

// PowerShell form of an `origin …` invocation, for the `powershell` field that
// Windsurf/Copilot hooks.json schemas run via `powershell -Command` on native
// Windows (the sh `PATH=dir:$PATH origin …` form is invalid there). The `&`
// call operator invokes an absolute path even when it contains spaces; a bare
// `origin` (no resolvable path) still works when the npm global bin is on PATH.
function originPowershellCmd(cmd: string): string {
  const args = cmd.replace(/^origin\b\s*/, '');
  // Prefer `node.exe <cli-entry.js>` — same reason as originCmd(): npm's `origin`
  // shim is a BATCH file, so invoking it spawns cmd.exe, and under a GUI agent
  // that cmd.exe gets a VISIBLE console window. Copilot fires hooks on every
  // lifecycle event, so the user saw a stream of black cmd windows. Calling node
  // directly removes the interpreter entirely.
  const entry = cliEntryScript();
  if (entry) {
    const node = `'${process.execPath.replace(/'/g, "''")}'`;
    const js = `'${entry.replace(/'/g, "''")}'`;
    return `& ${node} ${js} ${args}`.trim();
  }
  const bin = originBinaryPath();
  if (bin === 'origin') return `origin ${args}`.trim();
  const quoted = `'${bin.replace(/'/g, "''")}'`; // PS escapes ' by doubling it
  return `& ${quoted} ${args}`.trim();
}

// ─── Agent Definitions ────────────────────────────────────────────────────

type AgentType = 'claude-code' | 'cursor' | 'gemini' | 'devin' | 'codex' | 'aider' | 'antigravity' | 'copilot';

interface AgentConfig {
  name: string;
  configDir: string;          // directory name (.claude, .cursor, .gemini)
  configFile: string;         // settings file name
  detectDir: string;          // dir to check for auto-detection
  command: string;            // CLI binary name
  hookCommand: string;        // origin hooks <agent> <event>
  installHooks: (gitRoot: string) => void;
}

// ── Claude Code Hooks ──────────────────────────────────────────────────────

function installClaudeHooks(gitRoot: string): void {
  const claudeDir = path.join(gitRoot, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  let settings: Record<string, any> = {};
  if (fs.existsSync(settingsPath)) {
    backupExistingHooks(settingsPath);
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
  }

  if (!settings.hooks) settings.hooks = {};

  const hooks: Record<string, any[]> = {
    SessionStart: [{ hooks: [{ type: 'command', command: originCmd('origin hooks claude-code session-start') }] }],
    Stop: [{ hooks: [{ type: 'command', command: originCmd('origin hooks claude-code stop') }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: originCmd('origin hooks claude-code user-prompt-submit') }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: originCmd('origin hooks claude-code session-end') }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: originCmd('origin hooks claude-code pre-tool-use') }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: originCmd('origin hooks claude-code post-tool-use') }] }],
  };

  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!settings.hooks[eventType]) settings.hooks[eventType] = [];
    settings.hooks[eventType] = filterOriginHooks(settings.hooks[eventType]);
    settings.hooks[eventType].push(...entries);
  }

  // F17: Add permission deny rules for reading/editing origin session files
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.deny) settings.permissions.deny = [];
  const denyRules = [
    'Read(.git/origin-session*.json)',
    'Read(.origin.json)',
    'Edit(.git/origin-session*.json)',
    'Edit(.origin.json)',
  ];
  for (const rule of denyRules) {
    if (!settings.permissions.deny.includes(rule)) {
      settings.permissions.deny.push(rule);
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  const claudeLabel = gitRoot === os.homedir() ? `~/.claude/settings.json` : `.claude/settings.json`;
  console.log(chalk.green(`  ✓ Hooks installed in ${claudeLabel}`));

  // Sweep the OPPOSITE settings layer(s) so we don't end up registered at
  // multiple levels — Claude Code merges all of them and the hook would fire
  // once per registration. Symptom: every API call doubled, every state-file
  // write doubled, two heartbeats per session. The runtime hook handler also
  // self-heals (see dedupeOriginHookLayers in commands/hooks.ts), but doing
  // it here on the install path means users who actively re-ran `enable`
  // get cleaned synchronously without waiting for the next prompt to fire.
  try {
    cleanupOriginClaudeHooksOutsideOf(settingsPath);
  } catch (err: any) {
    console.log(chalk.gray(`  (couldn't sweep cross-layer hook duplicates: ${err?.message || err})`));
  }
}

/**
 * Strip Origin's claude-code hook entries from every .claude/settings.json
 * EXCEPT the canonical one we just wrote. Walks ~/.claude/, the current
 * project root, and any worktrees nested under the project. Idempotent —
 * no-ops when nothing matches.
 */
function cleanupOriginClaudeHooksOutsideOf(canonicalPath: string): void {
  const candidates = new Set<string>();
  // User-level
  candidates.add(path.join(os.homedir(), '.claude', 'settings.json'));
  // Project root + worktrees. cwd is reliable here because `enable` already
  // resolved gitRoot from cwd; if user passed --global we still want to
  // sweep the local project they're standing in.
  const cwdRoot = getGitRoot() || process.cwd();
  candidates.add(path.join(cwdRoot, '.claude', 'settings.json'));
  const worktreesDir = path.join(cwdRoot, '.claude', 'worktrees');
  try {
    for (const entry of fs.readdirSync(worktreesDir)) {
      candidates.add(path.join(worktreesDir, entry, '.claude', 'settings.json'));
    }
  } catch { /* no worktrees dir — fine */ }

  for (const p of candidates) {
    if (p === canonicalPath) continue;
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!hasOriginClaudeHooksInSettings(parsed)) continue;
      stripOriginClaudeHooksFromParsedSettings(parsed);
      fs.writeFileSync(p, JSON.stringify(parsed, null, 2) + '\n');
      const rel = p.startsWith(os.homedir() + '/') ? '~' + p.slice(os.homedir().length) : p;
      console.log(chalk.gray(`    • Removed duplicate Origin hooks from ${rel}`));
    } catch { /* unreadable or write-blocked — skip */ }
  }
}

function hasOriginClaudeHooksInSettings(parsed: any): boolean {
  if (!parsed?.hooks) return false;
  for (const event of Object.keys(parsed.hooks)) {
    const entries = parsed.hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry?.hooks || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (isOriginHookCommand(h?.command, 'claude-code')) {
          return true;
        }
      }
    }
  }
  return false;
}

function stripOriginClaudeHooksFromParsedSettings(parsed: any): void {
  if (!parsed?.hooks) return;
  for (const event of Object.keys(parsed.hooks)) {
    const entries = parsed.hooks[event];
    if (!Array.isArray(entries)) continue;
    parsed.hooks[event] = entries.filter((entry: any) => {
      if (!entry?.hooks || !Array.isArray(entry.hooks)) return true;
      return !entry.hooks.some((h: any) =>
        isOriginHookCommand(h?.command, 'claude-code')
      );
    });
    if (parsed.hooks[event].length === 0) {
      delete parsed.hooks[event];
    }
  }
}

// ── Cursor Hooks ───────────────────────────────────────────────────────────

export function installCursorHooks(gitRoot: string): void {
  const cursorDir = path.join(gitRoot, '.cursor');
  const hooksPath = path.join(cursorDir, 'hooks.json');

  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }

  let config: Record<string, any> = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    backupExistingHooks(hooksPath);
    try { config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')); } catch { config = { version: 1, hooks: {} }; }
  }

  if (!config.hooks) config.hooks = {};

  // Cursor 2.x reverted to the standard `sessionStart` / `sessionEnd` event
  // names. Cursor 1.7 briefly used `agentSessionStart` / `agentSessionEnd` but
  // 2.6+ rejects those as "Unknown hook type" and FAILS THE ENTIRE CONFIG
  // — no Origin hook fires, no sessions reach the dashboard. Write under the
  // current names. Valid types per Cursor 2.6's parser: beforeShellExecution,
  // beforeMCPExecution, afterShellExecution, afterMCPExecution, beforeReadFile,
  // afterFileEdit, beforeTabFileRead, afterTabFileEdit, stop, beforeSubmitPrompt,
  // afterAgentResponse, afterAgentThought, sessionStart, sessionEnd, preCompact,
  // subagentStart, subagentStop, preToolUse, postToolUse, postToolUseFailure.
  const hooks: Record<string, any[]> = {
    sessionStart: [{ command: originCmd('origin hooks cursor session-start') }],
    stop: [{ command: originCmd('origin hooks cursor stop') }],
    beforeSubmitPrompt: [{ command: originCmd('origin hooks cursor user-prompt-submit') }],
    sessionEnd: [{ command: originCmd('origin hooks cursor session-end') }],
    // afterFileEdit captures Cursor's StrReplace / write tool calls as they
    // happen. Cursor's git commits don't reliably trigger the global
    // post-commit hook (sandbox / worktree isolation), so AI Blame would
    // otherwise show empty diffs for Cursor sessions. Each edit-hook fire
    // re-scans the working tree against the per-prompt shadow and updates
    // the current prompt's mapping in place.
    afterFileEdit: [{ command: originCmd('origin hooks cursor after-file-edit') }],
  };

  // Strip our entries from the now-invalid event names so an upgrade from a
  // CLI that wrote `agentSessionStart` / `agentSessionEnd` doesn't leave the
  // whole config un-parseable. Cursor 2.6 rejects the entire hooks.json when
  // ANY hook type is unknown, so this cleanup is required, not optional.
  for (const legacy of ['agentSessionStart', 'agentSessionEnd']) {
    if (Array.isArray(config.hooks[legacy])) {
      config.hooks[legacy] = config.hooks[legacy].filter(
        (h: any) => !isOriginHookCommand(h.command, 'cursor')
      );
      if (config.hooks[legacy].length === 0) delete config.hooks[legacy];
    }
  }

  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!config.hooks[eventType]) config.hooks[eventType] = [];
    // Use `includes` not `startsWith` — installed commands carry a PATH=
    // prefix (e.g. `PATH=/opt/homebrew/bin:$PATH origin hooks cursor stop`)
    // which broke the previous startsWith check and produced duplicates on
    // every re-run of `origin enable`.
    config.hooks[eventType] = config.hooks[eventType].filter(
      (h: any) => !isOriginHookCommand(h.command)
    );
    config.hooks[eventType].push(...entries);
  }

  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  const cursorLabel = gitRoot === os.homedir() ? `~/.cursor/hooks.json` : `.cursor/hooks.json`;
  console.log(chalk.green(`  ✓ Hooks installed in ${cursorLabel}`));
}

// ── Gemini CLI Hooks ───────────────────────────────────────────────────────

function installGeminiHooks(gitRoot: string): void {
  const geminiDir = path.join(gitRoot, '.gemini');
  const settingsPath = path.join(geminiDir, 'settings.json');

  if (!fs.existsSync(geminiDir)) {
    fs.mkdirSync(geminiDir, { recursive: true });
  }

  let settings: Record<string, any> = {};
  if (fs.existsSync(settingsPath)) {
    backupExistingHooks(settingsPath);
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
  }

  // Gemini requires hooksConfig.enabled = true
  settings.hooksConfig = { enabled: true };
  if (!settings.hooks) settings.hooks = {};

  const hooks: Record<string, any[]> = {
    SessionStart: [{ hooks: [{ name: 'origin-session-start', type: 'command', command: originCmd('origin hooks gemini session-start') }] }],
    SessionEnd: [
      { matcher: 'exit', hooks: [{ name: 'origin-session-end', type: 'command', command: originCmd('origin hooks gemini session-end') }] },
      { matcher: 'logout', hooks: [{ name: 'origin-session-end-logout', type: 'command', command: originCmd('origin hooks gemini session-end') }] },
    ],
    BeforeAgent: [{ hooks: [{ name: 'origin-before-agent', type: 'command', command: originCmd('origin hooks gemini user-prompt-submit') }] }],
    AfterAgent: [{ hooks: [{ name: 'origin-after-agent', type: 'command', command: originCmd('origin hooks gemini stop') }] }],
  };

  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!settings.hooks[eventType]) settings.hooks[eventType] = [];
    // Remove existing Origin hooks
    settings.hooks[eventType] = settings.hooks[eventType].filter((entry: any) => {
      if (entry.hooks) {
        entry.hooks = entry.hooks.filter(
          (h: any) => !isOriginHookCommand(h.command)
        );
        return entry.hooks.length > 0;
      }
      return !isOriginHookCommand(entry.command);
    });
    settings.hooks[eventType].push(...entries);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  const geminiLabel = gitRoot === os.homedir() ? `~/.gemini/settings.json` : `.gemini/settings.json`;
  console.log(chalk.green(`  ✓ Hooks installed in ${geminiLabel}`));
}

// ── Devin Hooks ───────────────────────────────────────────────────────────
// Devin (Cognition; formerly Windsurf) exposes lifecycle hooks through the
// Devin CLI at `.devin/hooks.v1.json`, using the SAME format and event names
// as Claude Code — top-level PascalCase event keys, each an array of
// `{ hooks: [{ type: 'command', command }] }`, no wrapper. The stdin payload
// (session_id, prompt, transcript_path) matches Claude Code's, so the runtime
// handler reuses the claude-code path. See docs.devin.ai/cli/extensibility/
// hooks/lifecycle-hooks. (Devin Desktop, the ex-Windsurf GUI, has no third-
// party hooks — it uses MCP servers + rules in .devin/rules/, which Origin's
// context injection targets at hook time.)

export function installDevinHooks(gitRoot: string): void {
  const devinDir = path.join(gitRoot, '.devin');
  const hooksPath = path.join(devinDir, 'hooks.v1.json');

  if (!fs.existsSync(devinDir)) {
    fs.mkdirSync(devinDir, { recursive: true });
  }

  let config: Record<string, any> = {};
  if (fs.existsSync(hooksPath)) {
    backupExistingHooks(hooksPath);
    try { config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')); } catch { config = {}; }
  }

  const dv = (sub: string) => ({ hooks: [{ type: 'command', command: originCmd(`origin hooks devin ${sub}`) }] });
  const hooks: Record<string, any[]> = {
    SessionStart: [dv('session-start')],
    Stop: [dv('stop')],
    UserPromptSubmit: [dv('user-prompt-submit')],
    SessionEnd: [dv('session-end')],
  };

  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!config[eventType]) config[eventType] = [];
    config[eventType] = config[eventType].filter(
      (h: any) => !isOriginHookCommand(h?.hooks?.[0]?.command || h?.command),
    );
    config[eventType].push(...entries);
  }

  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  const devinLabel = gitRoot === os.homedir() ? `~/.devin/hooks.v1.json` : `.devin/hooks.v1.json`;
  console.log(chalk.green(`  ✓ Hooks installed in ${devinLabel}`));

  // Transition: the Devin/Windsurf DESKTOP GUI still runs Cascade, which reads
  // the legacy `.windsurf/hooks.json` (Cascade schema), NOT `.devin/hooks.v1`.
  // Install both so GUI Cascade sessions keep capturing until Cascade is fully
  // retired. Both point at the same `origin hooks devin` handler.
  installLegacyCascadeHooks(gitRoot);
}

// Legacy Windsurf Cascade hooks — the ex-Windsurf desktop GUI reads
// `.windsurf/hooks.json` with camelCase event names and prefers the
// `powershell` field on Windows. Points at `origin hooks devin` (the Cascade
// slug `hooks windsurf` command was removed in the rebrand). Kept as a
// transition shim; safe to drop once Cascade is gone everywhere.
function installLegacyCascadeHooks(gitRoot: string): void {
  const windsurfDir = path.join(gitRoot, '.windsurf');
  const hooksPath = path.join(windsurfDir, 'hooks.json');
  if (!fs.existsSync(windsurfDir)) fs.mkdirSync(windsurfDir, { recursive: true });

  let config: Record<string, any> = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    backupExistingHooks(hooksPath);
    try { config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')); } catch { config = { version: 1, hooks: {} }; }
  }
  if (!config.hooks) config.hooks = {};

  const cs = (sub: string) => ({
    command: originCmd(`origin hooks devin ${sub}`),
    powershell: originPowershellCmd(`origin hooks devin ${sub}`),
  });
  const hooks: Record<string, any[]> = {
    sessionStart: [cs('session-start')],
    stop: [cs('stop')],
    beforeSubmitPrompt: [cs('user-prompt-submit')],
    sessionEnd: [cs('session-end')],
  };
  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!config.hooks[eventType]) config.hooks[eventType] = [];
    config.hooks[eventType] = config.hooks[eventType].filter((h: any) => !isOriginHookCommand(h.command));
    config.hooks[eventType].push(...entries);
  }
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  const label = gitRoot === os.homedir() ? `~/.windsurf/hooks.json` : `.windsurf/hooks.json`;
  console.log(chalk.green(`  ✓ Cascade hooks installed in ${label} (desktop transition)`));
}

// ── GitHub Copilot CLI Hooks ─────────────────────────────────────────────
// Copilot CLI supports lifecycle hooks (docs.github.com/copilot/reference/
// hooks-reference). Repo-level hooks live in .github/hooks/*.json; user-level in
// ~/.copilot/hooks/*.json. Schema: { version, hooks: { EventName: [{ type, command }] } }
// with VS-Code-compatible PascalCase event names. stdin delivers session_id,
// prompt (UserPromptSubmit) and transcript_path (Stop) — the same shape as Claude
// Code, so capture flows through the generic hook path (no bespoke parser needed).
export function installCopilotHooks(gitRoot: string): void {
  const isGlobal = gitRoot === os.homedir();
  const hooksDir = isGlobal
    ? path.join(os.homedir(), '.copilot', 'hooks')
    : path.join(gitRoot, '.github', 'hooks');
  const hooksPath = path.join(hooksDir, 'origin.json');

  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // A dedicated file we own entirely — Copilot merges every *.json in the dir,
  // so there's nothing to preserve/back up here (unlike the shared settings of
  // the other agents).
  //
  // The Copilot CLI uses camelCase event names (sessionStart, userPromptSubmitted,
  // agentStop, sessionEnd — NOT the PascalCase VS-Code variants) and runs command
  // hooks from the `bash` field. We set `command` as a documented fallback, and a
  // `powershell` variant so the hook also fires under native Windows PowerShell.
  // (docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)
  const cmd = (event: string) => originCmd(`origin hooks copilot ${event}`);
  const hook = (event: string) => [{
    type: 'command',
    bash: cmd(event),
    command: cmd(event),
    powershell: originPowershellCmd(`origin hooks copilot ${event}`),
  }];
  const config = {
    version: 1,
    hooks: {
      sessionStart: hook('session-start'),
      userPromptSubmitted: hook('user-prompt-submit'),
      agentStop: hook('stop'),
      sessionEnd: hook('session-end'),
    },
  };

  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  const label = isGlobal ? '~/.copilot/hooks/origin.json' : '.github/hooks/origin.json';
  console.log(chalk.green(`  ✓ Hooks installed in ${label}`));
}

// ── Codex CLI Hooks ──────────────────────────────────────────────────────

// Windows watcher-only cleanup: remove every Origin-written Codex hook artifact
// so Codex stops trying (and failing) to run them, while leaving the user's own
// config and the `[features] hooks` flag untouched. Strips:
//   1. Origin hook entries from any standalone .codex/hooks.json (deleting the
//      file only if it held nothing but Origin hooks).
//   2. Origin's delimited `# origin-codex-inline-hooks-*` and
//      `# origin-trusted-hooks-*` blocks from ~/.codex/config.toml, plus any
//      un-delimited `[hooks.state."<source>:…"]` trust tables a pre-marker CLI
//      left behind (keyed on either the hooks.json or config.toml source path).
// Idempotent and best-effort — a leftover only means Codex logs a benign hook
// error until the next `origin enable`.
// A `[hooks.state."<source-path>:…"]` key stores the source path, and the path
// separators land in the TOML file either SINGLE-escaped (`C:\Users`, e.g. a
// hand-written or older config) or DOUBLE-escaped (`C:\\Users`, TOML basic-string
// escaping the CLI itself emits). Build a regex fragment for the path that
// matches BOTH — regex-escape each non-backslash run, and let every path
// separator match one-or-two literal backslashes. On POSIX (no backslashes) this
// is just the escaped path. Without this, the Windows strip silently no-ops on a
// double- or single-backslash config that the other form was written for.
export function backslashTolerantPathRe(p: string): string {
  return p
    .split('\\')
    .map((seg) => seg.replace(/[.*+?^${}()|[\]]/g, '\\$&'))
    .join('(?:\\\\){1,2}');
}

function stripOriginCodexHooksWindows(hooksPath: string, configTomlPath: string): void {
  // 1. Standalone hooks.json.
  try {
    if (fs.existsSync(hooksPath)) {
      backupExistingHooks(hooksPath);
      let existing: Record<string, any> = {};
      try { existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')); } catch { existing = {}; }
      if (existing.hooks && typeof existing.hooks === 'object') {
        for (const ev of Object.keys(existing.hooks)) {
          existing.hooks[ev] = filterOriginHooks(existing.hooks[ev] || []);
          if (existing.hooks[ev].length === 0) delete existing.hooks[ev];
        }
      }
      const stillHasHooks = existing.hooks && Object.keys(existing.hooks).length > 0;
      const stillHasOtherKeys = Object.keys(existing).some((k) => k !== 'hooks');
      if (!stillHasHooks && !stillHasOtherKeys) {
        fs.rmSync(hooksPath, { force: true });
      } else {
        fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + '\n');
      }
    }
  } catch { /* best-effort */ }

  // 2. config.toml inline + trust blocks. Preserve everything else (incl. the
  //    [features] hooks flag — we do NOT flip it here).
  try {
    if (!fs.existsSync(configTomlPath)) return;
    const toml = fs.readFileSync(configTomlPath, 'utf-8');
    let next = toml;
    next = next.replace(/\n# origin-trusted-hooks-begin[\s\S]*?# origin-trusted-hooks-end\n?/g, '');
    next = next.replace(/\n# origin-codex-inline-hooks-begin[\s\S]*?# origin-codex-inline-hooks-end\n?/g, '');
    // Un-delimited orphan trust tables written by older CLIs, keyed on either
    // the hooks.json or the config.toml source path.
    for (const keySource of [hooksPath, configTomlPath]) {
      const orphanHookStateRe = new RegExp(
        `\\n\\[hooks\\.state\\."${backslashTolerantPathRe(keySource)}:[^"\\n]*"\\]\\s*\\n\\s*trusted_hash\\s*=\\s*"[^"\\n]*"\\s*`,
        'g',
      );
      next = next.replace(orphanHookStateRe, '\n');
    }
    if (next !== toml) {
      fs.writeFileSync(configTomlPath, next);
      console.log(chalk.gray('    • Removed stale Origin Codex hook blocks from ~/.codex/config.toml'));
    }
  } catch { /* best-effort */ }
}

export function installCodexHooks(gitRoot: string): void {
  const codexDir = path.join(gitRoot, '.codex');
  const hooksPath = path.join(codexDir, 'hooks.json');
  const globalCodexDir = path.join(os.homedir(), '.codex');
  const configTomlPath = path.join(globalCodexDir, 'config.toml');

  // ── Windows: watcher-only, NO Codex lifecycle hooks ──────────────────────
  // Codex's Windows sandbox blocks the hooks (they can't inject context or
  // capture) yet Codex still surfaces them as red "SessionStart/UserPromptSubmit/
  // Stop hook (failed)" errors. Capture on Windows is now the hook-independent
  // rollout watcher (`origin codex-watch`, auto-started by enable), so the hooks
  // are pure noise. Register NOTHING and STRIP any Origin hook blocks a prior
  // CLI wrote — leaving the user's own config and the [features] flag untouched.
  // macOS/Linux still install hooks (they work + do context injection) below.
  if (isWindows()) {
    stripOriginCodexHooksWindows(hooksPath, configTomlPath);
    console.log(chalk.green('  ✓ Codex capture on Windows uses the rollout watcher (origin codex-watch) — hooks are not installed'));
    return;
  }

  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });
  }

  // Codex supports: SessionStart, Stop, UserPromptSubmit (no SessionEnd/BeforeAgent/AfterAgent)
  const hooks: Record<string, any[]> = {
    SessionStart: [{ hooks: [{ type: 'command', command: originCmd('origin hooks codex session-start'), timeout: 10 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: originCmd('origin hooks codex user-prompt-submit'), timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: originCmd('origin hooks codex stop'), timeout: 10 }] }],
  };

  // macOS/Linux only (Windows returned early above — it's watcher-only). The
  // standalone .codex/hooks.json is the sole hook source here; inline config.toml
  // hooks are never written off Windows, so there is no double-source.
  {
    let config: Record<string, any> = { hooks: {} };
    if (fs.existsSync(hooksPath)) {
      backupExistingHooks(hooksPath);
      try { config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')); } catch { config = { hooks: {} }; }
    }
    if (!config.hooks) config.hooks = {};
    for (const [eventType, entries] of Object.entries(hooks)) {
      if (!config.hooks[eventType]) config.hooks[eventType] = [];
      config.hooks[eventType] = filterOriginHooks(config.hooks[eventType]);
      config.hooks[eventType].push(...entries);
    }
    fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
    const codexLabel = gitRoot === os.homedir() ? `~/.codex/hooks.json` : `.codex/hooks.json`;
    console.log(chalk.green(`  ✓ Hooks installed in ${codexLabel}`));
  }

  // Auto-enable the hooks feature flag in ~/.codex/config.toml so the user
  // doesn't need to pass `-c features.hooks=true` every time.
  //
  // Codex renamed this flag from `codex_hooks` to `hooks` and now logs a
  // deprecation warning on every launch when the old key is present (see
  // https://developers.openai.com/codex/config-basic#feature-flags). We
  // write the new canonical key, and if a user's config still has the
  // legacy `codex_hooks = true` we rewrite it in-place during this run.
  try {
    if (!fs.existsSync(globalCodexDir)) {
      fs.mkdirSync(globalCodexDir, { recursive: true });
    }
    let toml = '';
    if (fs.existsSync(configTomlPath)) {
      toml = fs.readFileSync(configTomlPath, 'utf-8');
    }
    const hasLegacy = /^[ \t]*codex_hooks\s*=\s*true/im.test(toml);
    const hasCanonical = /^[ \t]*hooks\s*=\s*true/im.test(toml);

    let next = toml;
    if (hasLegacy) {
      // Rewrite `codex_hooks = true` → `hooks = true` (preserves
      // surrounding whitespace and any inline comment).
      next = next.replace(/^([ \t]*)codex_hooks(\s*=\s*true)/gim, '$1hooks$2');
    }
    if (!hasCanonical && !hasLegacy) {
      if (/^\[features\]\s*$/im.test(next)) {
        next = next.replace(/(^\[features\]\s*\n)/im, '$1hooks = true\n');
      } else {
        next = next.trimEnd() + (next ? '\n\n' : '') + '[features]\nhooks = true\n';
      }
    }

    // Pre-approve our hooks so Codex 0.130+ doesn't gate them behind the
    // interactive `/hooks` review prompt. Each entry in hooks.json gets a
    // `trusted_hash` stored under `[hooks.state."<key>"]` in config.toml.
    // The hash is sha256 over canonical-JSON of the normalized hook
    // identity (event_name + matcher + hooks[]). Match Codex's own
    // normalization so the hash compares equal to what `/hooks` would
    // compute — otherwise the entry shows up as "Modified" instead of
    // "Trusted". See codex-rs/hooks/src/engine/discovery.rs.
    const eventLabelMap: Record<string, string> = {
      SessionStart: 'session_start',
      UserPromptSubmit: 'user_prompt_submit',
      Stop: 'stop',
      PreToolUse: 'pre_tool_use',
      PostToolUse: 'post_tool_use',
      PermissionRequest: 'permission_request',
      PreCompact: 'pre_compact',
      PostCompact: 'post_compact',
    };

    // A Codex build discovers hooks from up to four sources and "loads all
    // matching hooks" from every one: ~/.codex/hooks.json, <repo>/.codex/
    // hooks.json, and inline `[hooks]` in either config.toml. Origin has always
    // shipped the standalone ~/.codex/hooks.json file. The 2026-07 Codex DESKTOP
    // self-update (app v26.721.x) stopped discovering that user-global FILE
    // (openai/codex#27133), so Origin ALSO began registering the hooks INLINE in
    // ~/.codex/config.toml — a separate discovery source read through a different
    // code path (load_toml_hooks_from_layer) that survived the file-discovery
    // regression, is provably read by the updated build (its trusted_hash state
    // is honored), and dodges the worktree project-root discovery bug too.
    //
    // FIX 2: on Windows we now ship config.toml inline as the SINGLE source and
    // no longer write the standalone hooks.json (stripped above). That removes
    // the "loading hooks from both … prefer a single representation" warning and
    // the resulting double-fire on builds that discover BOTH — while STILL
    // working on the regressed Desktop build (inline is read by every build with
    // the hooks engine, stable since v0.124.0). macOS/Linux is unchanged: no
    // inline hooks, hooks.json remains the sole source. The runtime turn_id
    // dedup in commands/hooks.ts still guards any residual double-fire (e.g. a
    // stale hooks.json a user restored by hand).
    const alsoRegisterInlineConfig = isWindows();

    // The trusted_hash is a sha256 over canonical JSON of the NORMALIZED hook
    // identity (event_name + optional matcher + normalized handler) — it is
    // independent of WHICH source the hook came from. So the same hash trusts
    // the hook under every source; only the state KEY's `key_source` prefix
    // differs (the abs path to the file that declared it: hooks.json for the
    // standalone file, config.toml for the inline copy).
    type HashEntry = { eventLabel: string; groupIndex: number; handlerIndex: number; hash: string };
    const hashEntries: HashEntry[] = [];
    // Inline-TOML rendering of the same hooks, as `[[hooks.<Event>]]` groups
    // each holding `[[hooks.<Event>.hooks]]` handler tables.
    const inlineHookLines: string[] = [];
    for (const [pascalEvent, groups] of Object.entries(hooks)) {
      const eventLabel = eventLabelMap[pascalEvent];
      if (!eventLabel) continue;
      groups.forEach((group: any, groupIndex: number) => {
        if (alsoRegisterInlineConfig) {
          inlineHookLines.push(`\n[[hooks.${pascalEvent}]]`);
          if (group.matcher !== undefined && group.matcher !== null) {
            inlineHookLines.push(`matcher = ${tomlLiteralString(String(group.matcher))}`);
          }
        }
        (group.hooks || []).forEach((handler: any, handlerIndex: number) => {
          // Mirror Codex's HookHandlerConfig::Command normalization:
          //   timeout defaults to 600, capped to at least 1; async defaults
          //   to false; command_windows + statusMessage stay absent (None)
          //   when not present in our hooks.json.
          const timeoutSec = Math.max(1, typeof handler.timeout === 'number' ? handler.timeout : 600);
          const normalizedHook: Record<string, unknown> = {
            type: 'command',
            command: handler.command,
            timeout: timeoutSec,
            async: false,
          };
          const identity: Record<string, unknown> = {
            event_name: eventLabel,
            hooks: [normalizedHook],
          };
          if (group.matcher !== undefined && group.matcher !== null) {
            identity.matcher = group.matcher;
          }
          const canonical = sortObjectKeysDeep(identity);
          const json = JSON.stringify(canonical);
          const hash = crypto.createHash('sha256').update(json).digest('hex');
          hashEntries.push({ eventLabel, groupIndex, handlerIndex, hash });
          if (alsoRegisterInlineConfig) {
            inlineHookLines.push(
              `[[hooks.${pascalEvent}.hooks]]`,
              `type = "command"`,
              // TOML literal (single-quoted) string: no escape processing, so
              // the Windows `"C:\...\node.exe" "...\index.js" …` command — full
              // of backslashes and double-quotes — survives verbatim.
              `command = ${tomlLiteralString(String(handler.command))}`,
              `timeout = ${typeof handler.timeout === 'number' ? handler.timeout : 10}`,
            );
          }
        });
      });
    }

    // Emit one [hooks.state."<key>"] entry per (source, event, group, handler).
    // Single-source policy: on Windows the ONLY source is the inline config.toml
    // copy (hooks.json is not shipped), so trust just config.toml; off Windows
    // the sole source is the standalone hooks.json.
    const trustKeySources = alsoRegisterInlineConfig ? [configTomlPath] : [hooksPath];
    const trustedHashLines: string[] = [];
    for (const keySource of trustKeySources) {
      for (const { eventLabel, groupIndex, handlerIndex, hash } of hashEntries) {
        const key = `${keySource}:${eventLabel}:${groupIndex}:${handlerIndex}`;
        // TOML quoted-key with escaped backslashes/quotes inside.
        const safeKey = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        trustedHashLines.push(
          `\n[hooks.state."${safeKey}"]`,
          `trusted_hash = "sha256:${hash}"`,
        );
      }
    }
    // Strip any prior origin-managed blocks so re-running origin enable updates
    // the hashes/commands in place instead of duplicating them (a TOML
    // duplicate-key parse failure would brick `codex`).
    next = next.replace(/\n# origin-trusted-hooks-begin[\s\S]*?# origin-trusted-hooks-end\n?/g, '');
    next = next.replace(/\n# origin-codex-inline-hooks-begin[\s\S]*?# origin-codex-inline-hooks-end\n?/g, '');
    // Older CLI versions wrote the [hooks.state."..."] blocks without the
    // begin/end markers — those won't be caught above. Strip any block whose
    // TOML key references a source path we're about to re-trust. Fail-closed:
    // if we're writing trusted_hash entries, we own this slice of the file.
    for (const keySource of trustKeySources) {
      const orphanHookStateRe = new RegExp(
        `\\n\\[hooks\\.state\\."${backslashTolerantPathRe(keySource)}:[^"\\n]*"\\]\\s*\\n\\s*trusted_hash\\s*=\\s*"[^"\\n]*"\\s*`,
        'g',
      );
      next = next.replace(orphanHookStateRe, '\n');
    }
    if (inlineHookLines.length > 0) {
      // The inline hooks MUST precede the [hooks.state.*] trust tables: once a
      // `[hooks.state."x"]` header opens, subsequent `[[hooks.<Event>]]` arrays
      // are still valid TOML (distinct sub-keys of `hooks`), but keeping the
      // array-of-tables definitions together and ahead of the state tables is
      // the least surprising layout and avoids any header-reopen ambiguity.
      next = next.trimEnd()
        + '\n\n# origin-codex-inline-hooks-begin'
        + '\n# Auto-generated by `origin enable`. Mirrors ~/.codex/hooks.json inline'
        + '\n# so a Codex build that stopped discovering the standalone hooks.json'
        + '\n# file still finds Origin\'s hooks here. Duplicate fires are de-duped at'
        + '\n# runtime by Origin (keyed on Codex\'s turn_id).'
        + inlineHookLines.join('\n')
        + '\n# origin-codex-inline-hooks-end\n';
    }
    if (trustedHashLines.length > 0) {
      next = next.trimEnd()
        + '\n\n# origin-trusted-hooks-begin\n# Auto-generated by `origin enable`. Trusts the hooks above so'
        + '\n# Codex 0.130+ doesn\'t block them behind `/hooks` review.'
        + trustedHashLines.join('\n')
        + '\n# origin-trusted-hooks-end\n';
    }

    if (next !== toml) {
      fs.writeFileSync(configTomlPath, next);
      if (hasLegacy) {
        console.log(chalk.green('  ✓ Migrated Codex hooks flag from codex_hooks → hooks in ~/.codex/config.toml'));
      } else if (!hasCanonical) {
        console.log(chalk.green('  ✓ Codex hooks feature flag enabled in ~/.codex/config.toml'));
      } else {
        console.log(chalk.green('  ✓ Codex hooks feature flag already enabled in ~/.codex/config.toml'));
      }
      if (trustedHashLines.length > 0) {
        console.log(chalk.green('  ✓ Auto-trusted Codex hooks (skips `/hooks` review on next launch)'));
      }
      if (inlineHookLines.length > 0) {
        console.log(chalk.green('  ✓ Registered Codex hooks inline in ~/.codex/config.toml (single source on Windows)'));
      }
    } else {
      console.log(chalk.green('  ✓ Codex hooks feature flag already enabled in ~/.codex/config.toml'));
    }
  } catch {
    // Non-fatal — user can still enable manually
    console.log(chalk.yellow('    ⚠ Could not auto-enable Codex hooks. Run: codex -c features.hooks=true'));
  }
}

// Render a string as a TOML literal (single-quoted) string. Literal strings do
// NO escape processing, so backslashes and double-quotes pass through verbatim —
// exactly what Windows hook commands (`"C:\…\node.exe" "…\index.js" …`) need.
// A literal string cannot contain a single quote or newline; hook commands never
// do, but we fall back to a double-quoted basic string (with escapes) if one
// somehow appears, so we never emit invalid TOML.
function tomlLiteralString(value: string): string {
  if (!value.includes("'") && !value.includes('\n')) {
    return `'${value}'`;
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

// Recursively sort object keys so JSON.stringify produces canonical output.
// Matches Codex's `canonical_json` (codex-rs/config/src/fingerprint.rs).
function sortObjectKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeysDeep) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = sortObjectKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return value;
}

// ── Aider Hooks ───────────────────────────────────────────────────────────

function installAiderHooks(gitRoot: string): void {
  const aiderConfPath = path.join(gitRoot, '.aider.conf.yml');

  // Check if already configured
  let existingConf = '';
  if (fs.existsSync(aiderConfPath)) {
    existingConf = fs.readFileSync(aiderConfPath, 'utf-8');
  }

  if (existingConf.includes('# origin-hooks')) {
    console.log(chalk.gray('  ✓ Aider config already includes Origin settings'));
    return;
  }

  const originBlock = [
    '',
    '# origin-hooks',
    '# Enable git commit verification so Origin post-commit hook runs',
    'git-commit-verify: true',
    '# Notify Origin when LLM responses complete',
    `notifications-command: ${originCmd('origin hooks aider stop')}`,
    '',
  ].join('\n');

  fs.appendFileSync(aiderConfPath, originBlock);
  console.log(chalk.green('  ✓ Hooks installed in .aider.conf.yml'));
  console.log(chalk.gray('    • git-commit-verify: enabled (runs Origin post-commit hook)'));
  console.log(chalk.gray('    • notifications-command: origin hooks aider stop'));
}

// ── Antigravity CLI Hooks ─────────────────────────────────────────────────

// Antigravity (Google's agentic CLI/IDE, the successor to Gemini CLI) reads
// hooks from `.agents/hooks.json` in the workspace, or `~/.gemini/config/hooks.json`
// globally. The schema is a map of NAMED hook groups, each holding an event map
// keyed by Claude-Code-style event names (SessionStart, UserPromptSubmit, Stop,
// SessionEnd, PreToolUse, PostToolUse). We register everything under an "origin"
// group so removal is a single-key delete. Each hook receives JSON on stdin and
// (for PreToolUse) returns `{ "decision": "allow" | "deny" }` on stdout — the
// lifecycle events we wire here are observe-only, so they need no decision.
export function installAntigravityHooks(gitRoot: string): void {
  const isGlobalInstall = gitRoot === os.homedir();
  // Global config lives under the shared ~/.gemini dir; local config is the
  // workspace .agents/ dir.
  const hooksPath = isGlobalInstall
    ? path.join(gitRoot, '.gemini', 'config', 'hooks.json')
    : path.join(gitRoot, '.agents', 'hooks.json');

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });

  let config: Record<string, any> = {};
  if (fs.existsSync(hooksPath)) {
    backupExistingHooks(hooksPath);
    try { config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')); } catch { config = {}; }
  }

  // agy ONLY fires three hook events — Stop, PreToolUse, PostToolUse (verified
  // against the binary; SessionStart/UserPromptSubmit/SessionEnd do not exist).
  // PostToolUse drives in-session capture (it carries conversationId +
  // transcriptPath); Stop finalizes; PreToolUse must return a decision so it
  // never blocks the agent.
  config.origin = {
    enabled: true,
    PostToolUse: [{ hooks: [{ type: 'command', command: originCmd('origin hooks antigravity post-tool-use') }] }],
    Stop: [{ hooks: [{ type: 'command', command: originCmd('origin hooks antigravity stop') }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: originCmd('origin hooks antigravity pre-tool-use') }] }],
  };

  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  const label = isGlobalInstall ? '~/.gemini/config/hooks.json' : '.agents/hooks.json';
  console.log(chalk.green(`  ✓ Hooks installed in ${label}`));
}

// ── Hook Backup (F8) ──────────────────────────────────────────────────────

/**
 * Backup an existing hook configuration file before Origin modifies it.
 * Creates a .origin-backup copy so the user can restore it later.
 */
function backupExistingHooks(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const backupPath = filePath + '.origin-backup';

  // Don't overwrite an existing backup — only create on first install
  if (fs.existsSync(backupPath)) return;

  try {
    fs.copyFileSync(filePath, backupPath);
  } catch {
    // Best effort — don't block installation
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function filterOriginHooks(entries: any[]): any[] {
  return entries.filter((entry: any) => {
    if (!entry.hooks) return true;
    return !entry.hooks.some((h: any) =>
      isOriginHookCommand(h.command)
    );
  });
}

const AGENTS: Record<AgentType, AgentConfig> = {
  'claude-code': {
    name: 'Claude Code',
    configDir: '.claude',
    configFile: 'settings.json',
    detectDir: '.claude',
    command: 'claude',
    hookCommand: 'origin hooks claude-code',
    installHooks: installClaudeHooks,
  },
  cursor: {
    name: 'Cursor',
    configDir: '.cursor',
    configFile: 'hooks.json',
    detectDir: '.cursor',
    command: 'cursor',
    hookCommand: 'origin hooks cursor',
    installHooks: installCursorHooks,
  },
  gemini: {
    name: 'Gemini CLI',
    configDir: '.gemini',
    configFile: 'settings.json',
    detectDir: '.gemini',
    command: 'gemini',
    hookCommand: 'origin hooks gemini',
    installHooks: installGeminiHooks,
  },
  devin: {
    name: 'Devin',
    configDir: '.devin',
    configFile: 'hooks.v1.json',
    detectDir: '.devin',
    command: 'devin',
    hookCommand: 'origin hooks devin',
    installHooks: installDevinHooks,
  },
  codex: {
    name: 'Codex CLI',
    configDir: '.codex',
    configFile: 'hooks.json',
    detectDir: '.codex',
    command: 'codex',
    hookCommand: 'origin hooks codex',
    installHooks: installCodexHooks,
  },
  aider: {
    name: 'Aider',
    configDir: '.',
    configFile: '.aider.conf.yml',
    detectDir: '',
    command: 'aider',
    hookCommand: 'origin hooks aider',
    installHooks: installAiderHooks,
  },
  antigravity: {
    name: 'Antigravity',
    configDir: '.agents',
    configFile: 'hooks.json',
    detectDir: '.agents',
    // Antigravity's terminal binary is `agy`; detection also checks `.agents/`.
    command: 'agy',
    hookCommand: 'origin hooks antigravity',
    installHooks: installAntigravityHooks,
  },
  copilot: {
    name: 'GitHub Copilot',
    // Repo hooks live in .github/hooks/; global in ~/.copilot/hooks/ (handled in
    // installCopilotHooks). No reliable repo-local marker dir, so detection is by
    // the `copilot` CLI binary being on PATH.
    configDir: '.github/hooks',
    configFile: 'origin.json',
    detectDir: '',
    command: 'copilot',
    hookCommand: 'origin hooks copilot',
    installHooks: installCopilotHooks,
  },
};

function isInNpxCache(name: string): boolean {
  try {
    const npxCache = path.join(os.homedir(), '.npm', '_npx');
    if (!fs.existsSync(npxCache)) return false;
    const dirs = fs.readdirSync(npxCache);
    for (const d of dirs) {
      const bin = path.join(npxCache, d, 'node_modules', '.bin', name);
      if (fs.existsSync(bin)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

// Officially supported agents for auto-detection. Antigravity is included so
// `origin enable` picks it up as Gemini-CLI users migrate to it.
const SUPPORTED_AGENTS: AgentType[] = ['claude-code', 'cursor', 'gemini', 'codex', 'antigravity', 'devin', 'copilot'];

function detectAgents(gitRoot: string): AgentType[] {
  const detected: AgentType[] = [];
  for (const [type, agent] of Object.entries(AGENTS).filter(([t]) => SUPPORTED_AGENTS.includes(t as AgentType)) as [AgentType, AgentConfig][]) {
    // Check for config directory
    if (agent.detectDir && fs.existsSync(path.join(gitRoot, agent.detectDir))) {
      detected.push(type);
      continue;
    }
    // Check if binary exists on PATH
    if (findExecutable(agent.command)) {
      detected.push(type);
      continue;
    }
    // Check npx cache (e.g. codex installed via npx)
    if (isInNpxCache(agent.command)) {
      detected.push(type);
    }
  }
  return detected;
}

// ─── Main Command ──────────────────────────────────────────────────────────

// Agents that support global (~/) hook installation
// Windsurf/Aider coming soon
const GLOBAL_CAPABLE_AGENTS: AgentType[] = ['claude-code', 'cursor', 'gemini', 'codex', 'antigravity', 'devin', 'copilot'];

export async function enableCommand(opts: { agent?: string; global?: boolean; local?: boolean; link?: string; agentSlug?: string; standalone?: boolean }): Promise<void> {
  // Standalone mode doesn't require login
  const config = loadConfig();

  // `--standalone` forces local-only mode even when logged in (formerly
  // `origin init --standalone`). Flip the stored mode BEFORE the connected
  // checks below so machine registration / key probing are skipped and hooks
  // install for a purely-local setup.
  if (opts.standalone && isConnectedMode() && config) {
    config.mode = 'standalone';
    saveConfig(config);
    console.log(chalk.green('\n✓ Switched to standalone mode'));
    console.log(chalk.gray('  API credentials kept — run `origin config set mode auto` to reconnect.'));
  }

  // Default = global. Pass --local to scope hooks to the current repo
  // only. The legacy --global flag is still accepted (and is now a no-op
  // since it matches the default) for back-compat with existing scripts.
  const isGlobal = !opts.local;
  let basePath: string;

  if (isGlobal) {
    basePath = os.homedir();
    console.log(chalk.bold('\n🌐 Enabling Origin session tracking on this machine\n'));
    console.log(chalk.gray(`  Home directory: ${basePath}`));
    console.log(chalk.gray('  Every repo on this machine — past and future — gets tracked.'));
    console.log(chalk.gray('  Opt out with: origin enable --local (current repo only)'));
  } else {
    const gitRoot = getGitRoot();
    if (!gitRoot) {
      console.log(chalk.red('Not inside a git repository. Run this from your project directory.'));
      console.log(chalk.gray('  Or drop --local to install machine-wide hooks instead.'));
      process.exit(1);
    }
    basePath = gitRoot;
    console.log(chalk.bold('\n🔗 Enabling Origin session tracking for this repo\n'));
  }

  // Validate the stored API key before touching hooks. If the key was
  // rotated/revoked (account deleted, admin reset, etc.) we want to
  // surface that here loudly — otherwise users install hooks against a
  // dead key and every later session 401's into hooks.log forever
  // with no visible feedback.
  if (isConnectedMode() && config?.apiKey && config?.apiUrl) {
    try {
      const probe = await fetch(`${config.apiUrl}/api/mcp/whoami`, {
        headers: { 'X-API-Key': config.apiKey },
      });
      if (probe.status === 401) {
        console.log(chalk.red('\n✗ Your stored Origin API key is no longer valid.'));
        console.log(chalk.gray('  The server rejected the key in ~/.origin/config.json (HTTP 401).'));
        console.log(chalk.gray('  This usually means the account was deleted or the key was rotated.'));
        console.log(chalk.white('\n  Run `origin login` to re-authenticate.\n'));
        process.exit(1);
      }
    } catch {
      // Network failure — non-fatal. Hooks will still surface the
      // problem at run time via the auth-status sentinel.
    }
  }

  // Register this machine with Origin's API on first run so it appears in
  // the dashboard. Idempotent — re-running just refreshes the heartbeat.
  // Used to be a separate `origin init` step; folding it in here means
  // `origin login && origin enable` is the entire onboarding flow.
  if (isConnectedMode()) {
    try {
      const { detectTools } = await import('../tools-detector.js');
      const { loadAgentConfig, saveAgentConfig } = await import('../config.js');
      const crypto = await import('crypto');
      const existingAgent = loadAgentConfig();
      const machineId = existingAgent?.machineId ?? crypto.randomUUID();
      const hostname = os.hostname();
      const detectedTools = detectTools();
      try {
        await api.registerMachine({ hostname, machineId, detectedTools });
      } catch { /* registration is best-effort — fall through */ }
      saveAgentConfig({ machineId, hostname, detectedTools, orgId: config?.orgId || 'local' });
    } catch { /* never block hook installation on registration hiccups */ }
  }

  // Determine which agents to enable
  let agentsToEnable: AgentType[];

  if (opts.agent) {
    const agent = opts.agent.toLowerCase() as AgentType;
    if (!AGENTS[agent]) {
      console.log(chalk.red(`Unknown agent: ${opts.agent}`));
      console.log(chalk.gray(`Supported agents: ${Object.keys(AGENTS).join(', ')}`));
      process.exit(1);
    }
    if (isGlobal && !GLOBAL_CAPABLE_AGENTS.includes(agent)) {
      console.log(chalk.yellow(`  ⚠ ${AGENTS[agent].name} doesn't support global hooks (config is per-project).`));
      console.log(chalk.gray('    Use "origin enable" inside your repo instead.'));
      process.exit(1);
    }
    agentsToEnable = [agent];
  } else {
    if (isGlobal) {
      // In global mode, detect which agent binaries are installed or config dirs exist
      agentsToEnable = GLOBAL_CAPABLE_AGENTS.filter((type) => {
        // Check CLI availability
        if (findExecutable(AGENTS[type].command)) return true;
        // Fall back to config directory detection (e.g. Cursor may not install CLI to PATH)
        const detectDir = AGENTS[type].detectDir;
        if (detectDir && fs.existsSync(path.join(os.homedir(), detectDir))) {
          return true;
        }
        return false;
      });
      if (agentsToEnable.length === 0) {
        // Default to claude-code
        agentsToEnable = ['claude-code'];
        console.log(chalk.gray('  No agent binaries detected, defaulting to Claude Code'));
      } else {
        console.log(chalk.gray(`  Detected: ${agentsToEnable.map((a) => AGENTS[a].name).join(', ')}`));
      }
    } else {
      // Auto-detect agents from repo config dirs
      agentsToEnable = detectAgents(basePath);
      if (agentsToEnable.length === 0) {
        agentsToEnable = ['claude-code'];
        console.log(chalk.gray('  No agent config detected, defaulting to Claude Code'));
      } else {
        console.log(chalk.gray(`  Detected: ${agentsToEnable.map((a) => AGENTS[a].name).join(', ')}`));
      }
    }
  }

  // Install hooks for each agent
  for (const agentType of agentsToEnable) {
    const agent = AGENTS[agentType];
    console.log(chalk.cyan(`\n  ${agent.name}:`));
    agent.installHooks(basePath);
    console.log(chalk.gray('    • Session start/end — lifecycle tracking'));
    console.log(chalk.gray('    • Prompt capture — real user prompts'));
    console.log(chalk.gray('    • Turn end — files, tokens, tool calls'));
  }

  // Install git hooks
  if (isGlobal) {
    installGlobalGitHooks();
  } else {
    installGitPreCommitHook(basePath);
    installGitPrepareCommitMsgHook(basePath);
    installGitPostCommitHook(basePath);
    installGitPrePushHook(basePath);
    // Install rewrite hooks for attribution preservation through rebase/amend/cherry-pick
    try {
      const { installRewriteHooks } = await import('../history-preservation.js');
      installRewriteHooks(basePath);
      console.log(chalk.green('  ✓ Attribution preservation hooks installed (rebase/amend/cherry-pick)'));
    } catch { /* non-fatal */ }
    // Auto-fetch attribution notes on clone/pull. Git doesn't fetch
    // refs/notes/* by default — we add the refspec so `git fetch` pulls
    // them alongside branches, and do a one-shot fetch now so existing
    // notes land immediately. Matches the auto-push behaviour in the
    // pre-push hook (handlePrePush in hooks.ts:4263).
    configureNotesRefspecAndFetch(basePath);
  }

  // If --link provided, validate agent and write .origin.json
  if (opts.link && !isGlobal) {
    try {
      const agents = await api.getAgents() as any[];
      const match = agents.find((a: any) => a.slug === opts.link && a.status === 'ACTIVE');
      if (!match) {
        console.log(chalk.red(`\n  ✗ Agent "${opts.link}" not found in Origin.`));
        console.log(chalk.gray('    Create it in the dashboard first, then re-run with --link.'));
      } else {
        saveRepoConfig(basePath, { agent: opts.link });
        console.log(chalk.green(`\n  ✓ Linked repo to agent "${opts.link}" (.origin.json created)`));
      }
    } catch (err: any) {
      console.log(chalk.yellow(`\n  ⚠ Could not validate agent: ${err.message}`));
      // Still write the config — user might know what they're doing
      saveRepoConfig(basePath, { agent: opts.link });
      console.log(chalk.gray(`    Wrote .origin.json with agent "${opts.link}" anyway.`));
    }
  }

  // If --agent-slug provided, save per-tool slug override to config
  if (opts.agentSlug && config) {
    const toolSlug = agentsToEnable[0]; // Primary agent being enabled
    if (!config.agentSlugs) config.agentSlugs = {};
    config.agentSlugs[toolSlug] = opts.agentSlug;
    saveConfig(config);
    console.log(chalk.green(`\n  ✓ Agent slug override: ${toolSlug} → ${opts.agentSlug}`));
  }

  // Hook-independent Codex watcher (Windows-first rollout). Codex Desktop /
  // v0.145 keep breaking hook discovery/trust/sandbox, so on Windows we ALSO
  // run a machine-global daemon that captures Codex sessions straight from the
  // rollout JSONL — no hook required. Gated to Windows via
  // codexWatchAutoStartEnabled(); enabling macOS/Linux later is a one-line
  // change there. Idempotent: no-ops if a live watcher already owns the pid
  // file, and any spawn sets windowsHide so it never pops a console window.
  if (isConnectedMode()) {
    try {
      const { codexWatchAutoStartEnabled, ensureCodexWatchRunning, registerCodexWatchLogonTask } =
        await import('../codex-watch.js');
      if (codexWatchAutoStartEnabled()) {
        const res = ensureCodexWatchRunning();
        if (res.started) {
          console.log(chalk.green('  ✓ Codex rollout watcher started (hook-independent capture)'));
        } else if (res.reason === 'already-running') {
          console.log(chalk.gray('  ✓ Codex rollout watcher already running'));
        }
        // Survive reboots via a logon Scheduled Task (Windows-only, best-effort).
        const task = registerCodexWatchLogonTask();
        if (task.registered) {
          console.log(chalk.green('  ✓ Codex watcher registered to relaunch at logon'));
        }
      }
    } catch { /* never block enable on watcher startup */ }
  }

  // Hook-independent multi-agent transcript watcher (Windows-first, same
  // rationale as codex-watch). On Windows the GUI/desktop agents (Claude Code,
  // Cursor, Antigravity, Gemini, Copilot) frequently never fire their
  // settings.json lifecycle hooks — the client just doesn't run them — so
  // hook-based capture silently never triggers. This daemon captures those
  // sessions straight from each agent's on-disk transcript. Keyed on the agent's
  // own session id, so on macOS/Linux (where hooks DO fire) a watcher-created
  // session would merge server-side rather than double-count — but we gate
  // auto-start to Windows for now via transcriptWatchAutoStartEnabled().
  // Idempotent: no-ops if a live watcher already owns the pid file; every spawn
  // sets windowsHide so it never pops a console window.
  if (isConnectedMode()) {
    try {
      const { transcriptWatchAutoStartEnabled, ensureTranscriptWatchRunning, registerTranscriptWatchLogonTask } =
        await import('../transcript-watch.js');
      if (transcriptWatchAutoStartEnabled()) {
        const res = ensureTranscriptWatchRunning();
        if (res.started) {
          console.log(chalk.green('  ✓ Transcript watcher started (hook-independent capture for Claude/Cursor/Antigravity/Gemini/Copilot)'));
        } else if (res.reason === 'already-running') {
          console.log(chalk.gray('  ✓ Transcript watcher already running'));
        }
        const task = registerTranscriptWatchLogonTask();
        if (task.registered) {
          console.log(chalk.green('  ✓ Transcript watcher registered to relaunch at logon'));
        }
      }
    } catch { /* never block enable on watcher startup */ }
  }

  console.log(chalk.bold('\n📋 Next steps:\n'));
  const agentNames = agentsToEnable.map(a => AGENTS[a].command);
  const agentList = agentNames.length > 1
    ? agentNames.slice(0, -1).join(', ') + ' or ' + agentNames[agentNames.length - 1]
    : agentNames[0];
  const connected = isConnectedMode();
  if (isGlobal) {
    console.log(chalk.white('  1. Open any repo and start coding with ') + chalk.cyan(agentList));
    console.log(chalk.white('  2. Sessions are captured automatically for ALL repos'));
    console.log(chalk.white('  3. View sessions: ') + chalk.cyan('origin sessions'));
    if (connected && config?.apiUrl) {
      console.log(chalk.white('  4. Or check the dashboard: ') + chalk.cyan(config.apiUrl));
    }
  } else {
    console.log(chalk.white('  1. Start coding with ') + chalk.cyan(agentList));
    console.log(chalk.white('  2. Work normally — Origin captures everything automatically'));
    console.log(chalk.white('  3. View sessions: ') + chalk.cyan('origin sessions'));
    if (connected && config?.apiUrl) {
      console.log(chalk.white('  4. Or check the dashboard: ') + chalk.cyan(config.apiUrl));
    }
  }

  console.log(chalk.green(`\n✓ Origin session tracking enabled${isGlobal ? ' globally' : ''}.\n`));

  // Loud, explicit heads-up when enabling WITHOUT being logged in. In this
  // state Origin runs standalone: it captures sessions to local state but
  // ensureServerSession() bails (isConnectedMode() is false), so nothing is
  // uploaded and the sessions never appear in the user's Origin account. This
  // was silent before — a second machine-user who ran `origin enable` but not
  // `origin login` saw local capture "work" yet found nothing in the dashboard.
  if (!connected) {
    console.log(chalk.yellow('  ⚠ Not logged in — running in local-only mode.'));
    console.log(chalk.yellow('    Sessions are captured on this machine but will NOT appear in your Origin account.'));
    console.log(chalk.white('    Run ') + chalk.cyan('origin login') + chalk.white(' to sync them to your account.\n'));
  }
}

// ─── Global Git Hooks (core.hooksPath) ────────────────────────────────────

function resolveOriginBin(): string {
  let originBin = 'origin';
  try {
    const binPath = findExecutable('origin');
    if (binPath) originBin = binPath;
  } catch { /* fallback to bare name */ }
  return originBin;
}

// Write the global pre-commit hook into an Origin-managed hooks dir.
// Shared by installGlobalGitHooks (origin enable) and the lazy heal in
// ensurePolicyHookInstalled — global hooks dirs written by CLI versions
// that predate the pre-commit hook carry only post-commit/pre-push/…,
// and with core.hooksPath set, git ignores .git/hooks entirely, so a
// missing global pre-commit silently disables ALL policy enforcement.
// Write the global pre-push hook. This is the gate that enforces the org's
// push-block policy (Agents → Push control → "Block pushes from disabled
// agents"). `origin hooks git-pre-push` exits non-zero to abort a blocked push.
//
// CRITICAL: the hook must propagate that exit code. It used to run
// `"$ORIGIN_BIN" hooks git-pre-push` and then fall through to the local-hook
// chain, so the SCRIPT's exit status was that trailing `if` — which returns 0
// when no local hook exists. On the default (global) install no local pre-push
// exists, so a blocked push printed "push blocked" and then git pushed anyway:
// the entire push-block feature was inert. The pre-commit hook always did this
// right (capture $?, re-exit); pre-push just wasn't given the same treatment.
export function writeGlobalPrePushHook(globalHooksDir: string): void {
  const originBin = resolveOriginBin();
  const prePushPath = path.join(globalHooksDir, 'pre-push');
  const prePushContent = `#!/bin/sh
# origin-global-pre-push
# Installed by: origin enable --global

# Ensure PATH includes common npm/node locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/*/bin:$HOME/.npm-global/bin:$PATH"

# Use full path to origin
ORIGIN_BIN=""
if [ -x "${originBin}" ]; then
  ORIGIN_BIN="${originBin}"
elif command -v origin >/dev/null 2>&1; then
  ORIGIN_BIN="origin"
elif [ -x "/opt/homebrew/bin/origin" ]; then
  ORIGIN_BIN="/opt/homebrew/bin/origin"
elif [ -x "/usr/local/bin/origin" ]; then
  ORIGIN_BIN="/usr/local/bin/origin"
fi

if [ -n "$ORIGIN_BIN" ]; then
  "$ORIGIN_BIN" hooks git-pre-push
  RESULT=$?
  if [ $RESULT -ne 0 ]; then
    exit $RESULT
  fi
fi

# Chain to local repo hooks if they exist
LOCAL_HOOK="\$(git rev-parse --git-dir 2>/dev/null)/hooks/pre-push"
if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@"
fi
`;
  fs.writeFileSync(prePushPath, prePushContent);
  fs.chmodSync(prePushPath, '755');
}

export function writeGlobalPreCommitHook(globalHooksDir: string): void {
  const originBin = resolveOriginBin();
  const preCommitPath = path.join(globalHooksDir, 'pre-commit');
  const preCommitContent = `#!/bin/sh
# origin-global-pre-commit
# Installed by: origin enable --global
# Scans staged changes for secrets — blocks commit if found

# Ensure PATH includes common npm/node locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/*/bin:$HOME/.npm-global/bin:$PATH"

ORIGIN_BIN=""
if [ -x "${originBin}" ]; then
  ORIGIN_BIN="${originBin}"
elif command -v origin >/dev/null 2>&1; then
  ORIGIN_BIN="origin"
elif [ -x "/opt/homebrew/bin/origin" ]; then
  ORIGIN_BIN="/opt/homebrew/bin/origin"
elif [ -x "/usr/local/bin/origin" ]; then
  ORIGIN_BIN="/usr/local/bin/origin"
fi

if [ -n "$ORIGIN_BIN" ]; then
  "$ORIGIN_BIN" hooks git-pre-commit
  RESULT=$?
  if [ $RESULT -ne 0 ]; then
    exit $RESULT
  fi
fi

# Chain to local repo hooks if they exist
LOCAL_HOOK="\$(git rev-parse --git-dir 2>/dev/null)/hooks/pre-commit"
if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@"
fi
`;
  fs.writeFileSync(preCommitPath, preCommitContent);
  fs.chmodSync(preCommitPath, '755');
}

// Write the global post-checkout hook. Git runs post-checkout after `git clone`,
// which is the only moment we can rescue attribution for a fresh clone: clone
// fetches refs/heads/* and refs/tags/* and nothing else, so refs/notes/origin
// never comes down on its own. With core.hooksPath pointing at this dir the hook
// fires in EVERY repo on the machine — including ones the user never ran
// `origin enable` in — so a clone lands with its notes already present.
//
// Two things this must not do, because it runs on every checkout on the machine:
//   - Fire on ordinary checkouts. Git passes flag=1 for branch switches too, NOT
//     just clones; the clone signature is a null-ref previous HEAD. Keying on the
//     flag alone would run a network fetch on every `git checkout`.
//   - Slow git down or break it. The clone test is a shell string compare (no
//     node startup on the common path), the real work is backgrounded so the
//     clone never blocks on the network, and the hook always exits 0.
export function writeGlobalPostCheckoutHook(globalHooksDir: string): void {
  const originBin = resolveOriginBin();
  const postCheckoutPath = path.join(globalHooksDir, 'post-checkout');
  const postCheckoutContent = `#!/bin/sh
# origin-global-post-checkout
# Installed by: origin enable --global
# Fetches AI attribution notes after a fresh clone (git does not clone them).

# args: $1 = previous HEAD, $2 = new HEAD, $3 = 1 for branch checkout / 0 for file
# File checkouts (flag=0) are the common, noisy case and neither job applies —
# bail before touching node. Everything else routes to the CLI, which tells a
# clone (null-ref previous HEAD) from an ordinary switch. Mirrors the repo-local
# hook history-preservation installs.
if [ "$3" != "1" ]; then exit 0; fi

# Ensure PATH includes common npm/node locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/*/bin:$HOME/.npm-global/bin:$PATH"

ORIGIN_BIN=""
if [ -x "${originBin}" ]; then
  ORIGIN_BIN="${originBin}"
elif command -v origin >/dev/null 2>&1; then
  ORIGIN_BIN="origin"
elif [ -x "/opt/homebrew/bin/origin" ]; then
  ORIGIN_BIN="/opt/homebrew/bin/origin"
elif [ -x "/usr/local/bin/origin" ]; then
  ORIGIN_BIN="/usr/local/bin/origin"
fi

# Backgrounded: a slow network must never hold up someone's clone.
if [ -n "$ORIGIN_BIN" ]; then
  "$ORIGIN_BIN" hooks git-post-checkout "$1" "$2" "$3" >/dev/null 2>&1 &
fi

# Chain to local repo hooks if they exist
LOCAL_HOOK="\$(git rev-parse --git-dir 2>/dev/null)/hooks/post-checkout"
if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@"
fi

exit 0
`;
  fs.writeFileSync(postCheckoutPath, postCheckoutContent);
  fs.chmodSync(postCheckoutPath, '755');
}

// Write the global post-commit hook. Fires the CLI capture in the background,
// then chains to any local repo post-commit hook.
export function writeGlobalPostCommitHook(globalHooksDir: string): void {
  const originBin = resolveOriginBin();
  const postCommitPath = path.join(globalHooksDir, 'post-commit');
  const postCommitContent = `#!/bin/sh
# origin-global-post-commit
# Installed by: origin enable --global

# Ensure PATH includes common npm/node locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/*/bin:$HOME/.npm-global/bin:$PATH"

# Use full path to origin (resolve from common locations)
ORIGIN_BIN=""
if [ -x "${originBin}" ]; then
  ORIGIN_BIN="${originBin}"
elif command -v origin >/dev/null 2>&1; then
  ORIGIN_BIN="origin"
elif [ -x "/opt/homebrew/bin/origin" ]; then
  ORIGIN_BIN="/opt/homebrew/bin/origin"
elif [ -x "/usr/local/bin/origin" ]; then
  ORIGIN_BIN="/usr/local/bin/origin"
fi

if [ -n "$ORIGIN_BIN" ]; then
  # Redirect stdout/stderr to /dev/null so the backgrounded child doesn't
  # inherit git's stdout fd. Otherwise it holds the write-end of a
  # \`git commit | tee\` pipe open and tee stalls until origin exits.
  "$ORIGIN_BIN" hooks git-post-commit >/dev/null 2>&1 &
fi

# Chain to local repo hooks if they exist
LOCAL_HOOK="\$(git rev-parse --git-dir 2>/dev/null)/hooks/post-commit"
if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@"
fi
`;
  fs.writeFileSync(postCommitPath, postCommitContent);
  fs.chmodSync(postCommitPath, '755');
}

// Write the global post-rewrite hook (rebase/amend). Preserves attribution
// notes in the background, then chains to any local repo post-rewrite hook.
export function writeGlobalPostRewriteHook(globalHooksDir: string): void {
  const originBin = resolveOriginBin();
  const postRewritePath = path.join(globalHooksDir, 'post-rewrite');
  const postRewriteContent = `#!/bin/sh
# origin-global-post-rewrite
# Installed by: origin enable --global
# Preserves AI attribution notes through rebase/amend

# Ensure PATH includes common npm/node locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/*/bin:$HOME/.npm-global/bin:$PATH"

ORIGIN_BIN=""
if [ -x "${originBin}" ]; then
  ORIGIN_BIN="${originBin}"
elif command -v origin >/dev/null 2>&1; then
  ORIGIN_BIN="origin"
elif [ -x "/opt/homebrew/bin/origin" ]; then
  ORIGIN_BIN="/opt/homebrew/bin/origin"
elif [ -x "/usr/local/bin/origin" ]; then
  ORIGIN_BIN="/usr/local/bin/origin"
fi

if [ -n "$ORIGIN_BIN" ]; then
  # Redirect so the backgrounded child doesn't hold git's stdout fd open
  # (same \`git commit | tee\` / pipe-stall reason as post-commit).
  "$ORIGIN_BIN" hooks git-post-rewrite "$@" >/dev/null 2>&1 &
fi

# Chain to local repo hooks if they exist
LOCAL_HOOK="\$(git rev-parse --git-dir 2>/dev/null)/hooks/post-rewrite"
if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@"
fi
`;
  fs.writeFileSync(postRewritePath, postRewriteContent);
  fs.chmodSync(postRewritePath, '755');
}

function installGlobalGitHooks(): void {
  const globalHooksDir = path.join(os.homedir(), '.origin', 'git-hooks');

  // Create global hooks directory
  if (!fs.existsSync(globalHooksDir)) {
    fs.mkdirSync(globalHooksDir, { recursive: true });
  }

  // Resolve full path to origin binary
  const originBin = resolveOriginBin();

  // Pre-commit hook — secret scanning + policy enforcement (blocks commits)
  writeGlobalPreCommitHook(globalHooksDir);

  // Post-checkout hook — pulls attribution notes down after a fresh clone.
  writeGlobalPostCheckoutHook(globalHooksDir);

  // Post-commit hook — fires capture in the background, chains local hooks.
  writeGlobalPostCommitHook(globalHooksDir);

  // Pre-push hook that also chains to local repo hooks
  writeGlobalPrePushHook(globalHooksDir);

  // Post-rewrite hook for attribution preservation through rebase/amend
  writeGlobalPostRewriteHook(globalHooksDir);

  // Prepare-commit-msg hook — writes Origin-Session trailer into COMMIT_EDITMSG.
  // Must run SYNCHRONOUSLY (not backgrounded) because git waits for the hook
  // to finish before reading the message file.
  const prepareCommitMsgPath = path.join(globalHooksDir, 'prepare-commit-msg');
  const prepareCommitMsgContent = `#!/bin/sh
# origin-global-prepare-commit-msg
# Installed by: origin enable --global
#
# git passes: $1 = path to COMMIT_EDITMSG, $2 = source, $3 = sha

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/*/bin:$HOME/.npm-global/bin:$PATH"

ORIGIN_BIN=""
if [ -x "${originBin}" ]; then
  ORIGIN_BIN="${originBin}"
elif command -v origin >/dev/null 2>&1; then
  ORIGIN_BIN="origin"
elif [ -x "/opt/homebrew/bin/origin" ]; then
  ORIGIN_BIN="/opt/homebrew/bin/origin"
elif [ -x "/usr/local/bin/origin" ]; then
  ORIGIN_BIN="/usr/local/bin/origin"
fi

# Synchronous — git waits for this to finish before reading the message.
# Trailer-insertion errors are swallowed internally; never block the commit.
if [ -n "$ORIGIN_BIN" ]; then
  "$ORIGIN_BIN" hooks git-prepare-commit-msg "$1" "$2" "$3" || true
fi

# Chain to local repo hook if present.
LOCAL_HOOK="\$(git rev-parse --git-dir 2>/dev/null)/hooks/prepare-commit-msg"
if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@"
fi
`;
  fs.writeFileSync(prepareCommitMsgPath, prepareCommitMsgContent);
  fs.chmodSync(prepareCommitMsgPath, '755');

  // Set git config to use our global hooks directory
  try {
    run('git', ['config', '--global', 'core.hooksPath', globalHooksDir]);
    console.log(chalk.green('\n  ✓ Global git hooks installed'));
    console.log(chalk.gray(`    Hooks directory: ${globalHooksDir}`));
    console.log(chalk.gray('    Local repo hooks are chained automatically'));
    console.log(chalk.gray('    Attribution preserved through rebase/amend/cherry-pick'));
  } catch (err: any) {
    console.log(chalk.yellow(`\n  ⚠ Could not set global git hooks: ${err.message}`));
  }
}

// ─── Auto-install at session start ────────────────────────────────────
//
// Idempotent, quiet check that the repo has Origin's pre-commit hook
// installed — the gate that actually enforces CONTENT_FILTER policies
// and the built-in secret scanner. Called from handleSessionStart so
// any repo an AI session touches gets enforcement, not just the one
// where the user ran `origin enable`.
//
// User-reported problem (PR #156): a CONTENT_FILTER policy was
// configured in the dashboard, scoped to Codex/Claude/Gemini/Cursor.
// User ran Codex in a repo where `origin enable` had never been run.
// Codex's agent-level hooks (SessionStart/UserPromptSubmit/Stop) fire
// because they live in `~/.codex/hooks.json` (global), but the
// per-repo `.git/hooks/pre-commit` — which is what blocks the commit
// — was never installed. Commit sailed through.
//
// This ensures the repo gets the hook the first time ANY agent
// session starts in it, agent-agnostic. Skips silently when:
//   - Not a git repo (gitRoot lookup failed at the caller)
//   - `core.hooksPath` is set to an Origin-managed dir (global hooks
//     already cover this repo)
//   - The marker line is already present in `.git/hooks/pre-commit`
//
// We don't touch `core.hooksPath` if the user has set it to something
// else (a custom team-wide hooks dir, husky, lefthook, …) — clobbering
// that would be invasive and unexpected. In that case the user has to
// run `origin enable` explicitly so we can write into THEIR hooks dir.
export function ensurePolicyHookInstalled(gitRoot: string): { installed: boolean; reason: string } {
  try {
    // 1. If global core.hooksPath is set to Origin's managed dir, the
    //    global pre-commit fires here too. Nothing to do.
    try {
      const globalHooksPath = execSync('git config --global --get core.hooksPath', { windowsHide: true,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (globalHooksPath && globalHooksPath.includes(path.join('.origin', 'git-hooks'))) {
        // The managed dir only covers this repo if it actually contains
        // a pre-commit hook. Dirs written by CLI versions that predate
        // the global pre-commit (≤ May 2026) carry only post-commit/
        // pre-push/prepare-commit-msg — and with core.hooksPath set,
        // git ignores .git/hooks entirely, so a missing global
        // pre-commit means NO policy enforcement on any repo on the
        // machine. Heal the dir in place instead of skipping.
        const resolvedDir = globalHooksPath.startsWith('~')
          ? path.join(os.homedir(), globalHooksPath.slice(1))
          : globalHooksPath;
        // Same story for post-checkout: dirs written before it existed have no
        // post-checkout, so a fresh clone on this machine would silently land
        // without its attribution notes. Heal it in place — checked separately
        // from pre-commit because a dir can be missing either one.
        const globalPostCheckout = path.join(resolvedDir, 'post-checkout');
        if (fs.existsSync(resolvedDir) && !fs.existsSync(globalPostCheckout)) {
          writeGlobalPostCheckoutHook(resolvedDir);
        }
        const globalPreCommit = path.join(resolvedDir, 'pre-commit');
        if (fs.existsSync(resolvedDir) && !fs.existsSync(globalPreCommit)) {
          writeGlobalPreCommitHook(resolvedDir);
          return { installed: true, reason: 'healed-global-pre-commit' };
        }
        return { installed: false, reason: 'global-origin-hooks-active' };
      }
      if (globalHooksPath) {
        // User has their own custom hooksPath. Don't clobber it.
        return { installed: false, reason: 'custom-hooks-path-set' };
      }
    } catch { /* no global setting — fall through */ }

    // 2. Repo-local check.
    const hooksDir = path.join(gitRoot, '.git', 'hooks');
    const hookPath = path.join(hooksDir, 'pre-commit');
    const ORIGIN_MARKER = '# origin-pre-commit';

    if (fs.existsSync(hookPath)) {
      try {
        const existing = fs.readFileSync(hookPath, 'utf-8');
        if (existing.includes(ORIGIN_MARKER)) {
          return { installed: false, reason: 'already-installed' };
        }
      } catch { /* unreadable — fall through and try to install */ }
    }

    // 3. Install silently. Mirror `installGitPreCommitHook` semantics
    //    but without the console.log so we don't spam users' hook
    //    output on every session start.
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    const hookScript = originCmd('origin hooks git-pre-commit');
    if (fs.existsSync(hookPath)) {
      backupExistingHooks(hookPath);
      const append = `\n${ORIGIN_MARKER}\n${hookScript}\n`;
      fs.appendFileSync(hookPath, append);
    } else {
      const content = `#!/bin/sh\n${ORIGIN_MARKER}\n${hookScript}\n`;
      fs.writeFileSync(hookPath, content);
    }
    fs.chmodSync(hookPath, '755');
    return { installed: true, reason: 'fresh-install' };
  } catch (err: any) {
    // Non-fatal — if we can't install, the session continues. Worst
    // case the user has unenforced policies in this repo until they
    // run `origin enable` manually; better than crashing the session.
    return { installed: false, reason: `error:${err?.message || 'unknown'}` };
  }
}

// ─── Git Pre-Commit Hook (Secret Scan) ────────────────────────────────

export function installGitPreCommitHook(gitRoot: string): void {
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');

  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const ORIGIN_MARKER = '# origin-pre-commit';
  const hookScript = originCmd(`origin hooks git-pre-commit`);

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes(ORIGIN_MARKER)) {
      console.log(chalk.gray('  ✓ Git pre-commit hook already installed'));
      return;
    }
    backupExistingHooks(hookPath);
    // Pre-commit must run synchronously (not &) — exit code blocks commit
    const append = `\n${ORIGIN_MARKER}\n${hookScript}\n`;
    fs.appendFileSync(hookPath, append);
  } else {
    const content = `#!/bin/sh\n${ORIGIN_MARKER}\n${hookScript}\n`;
    fs.writeFileSync(hookPath, content);
  }

  fs.chmodSync(hookPath, '755');
  console.log(chalk.green('  ✓ Git pre-commit hook installed (secret scanning)'));
}

// ─── Git Post-Commit Hook ─────────────────────────────────────────────────

// ─── Git Prepare-Commit-Msg Hook ─────────────────────────────────────────
//
// Fires before the commit is created. Writes Origin-Session trailers into
// COMMIT_EDITMSG so the trailer is part of the commit from the start,
// avoiding the old post-commit --amend --no-verify dance.

export function installGitPrepareCommitMsgHook(gitRoot: string): void {
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'prepare-commit-msg');

  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const ORIGIN_MARKER = '# origin-prepare-commit-msg';
  // Pass git's hook args through: $1 = msgFile, $2 = source, $3 = sha
  const hookScript = originCmd(`origin hooks git-prepare-commit-msg "$1" "$2" "$3"`);

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes(ORIGIN_MARKER)) {
      console.log(chalk.gray('  ✓ Git prepare-commit-msg hook already installed'));
      return;
    }
    const append = `\n${ORIGIN_MARKER}\n${hookScript}\n`;
    fs.appendFileSync(hookPath, append);
  } else {
    const content = `#!/bin/sh\n${ORIGIN_MARKER}\n${hookScript}\n`;
    fs.writeFileSync(hookPath, content);
  }

  fs.chmodSync(hookPath, '755');
  console.log(chalk.green('  ✓ Git prepare-commit-msg hook installed (session trailer)'));
}

export function installGitPostCommitHook(gitRoot: string): void {
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'post-commit');

  // Ensure hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const ORIGIN_MARKER = '# origin-post-commit';
  const hookScript = originCmd(`origin hooks git-post-commit`);

  // Check if hook file already exists
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes(ORIGIN_MARKER)) {
      console.log(chalk.gray('  ✓ Git post-commit hook already installed'));
      return;
    }
    // Append to existing hook. Redirect the backgrounded child so it doesn't
    // inherit git's stdout fd and stall a `git commit | tee` pipe (same fix as
    // the global post-commit hook).
    const append = `\n${ORIGIN_MARKER}\n${hookScript} >/dev/null 2>&1 &\n`;
    fs.appendFileSync(hookPath, append);
  } else {
    // Create new hook file
    const content = `#!/bin/sh\n${ORIGIN_MARKER}\n${hookScript} >/dev/null 2>&1 &\n`;
    fs.writeFileSync(hookPath, content);
  }

  // Make executable
  fs.chmodSync(hookPath, '755');
  console.log(chalk.green('  ✓ Git post-commit hook installed'));
}

// ─── Git Pre-Push Hook (F14) ──────────────────────────────────────────────

export function installGitPrePushHook(gitRoot: string): void {
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-push');

  // Ensure hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const ORIGIN_MARKER = '# origin-pre-push';
  const hookScript = originCmd(`origin hooks git-pre-push`);

  // Check if hook file already exists
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes(ORIGIN_MARKER)) {
      console.log(chalk.gray('  ✓ Git pre-push hook already installed'));
      return;
    }
    // Backup and append to existing hook
    backupExistingHooks(hookPath);
    const append = `\n${ORIGIN_MARKER}\n${hookScript}\n`;
    fs.appendFileSync(hookPath, append);
  } else {
    // Create new hook file
    const content = `#!/bin/sh\n${ORIGIN_MARKER}\n${hookScript}\n`;
    fs.writeFileSync(hookPath, content);
  }

  // Make executable
  fs.chmodSync(hookPath, '755');
  console.log(chalk.green('  ✓ Git pre-push hook installed'));
}

// ─── Auto-fetch attribution refs ─────────────────────────────────────────
// Git doesn't fetch refs/notes/* on clone or `git fetch`, so attribution has to
// be wired up explicitly.
//
// This used to install `+refs/notes/origin:refs/notes/origin` itself — a forced
// refspec mapping the remote's notes straight onto the local ref. That silently
// destroyed attribution: every ordinary `git pull` force-updated refs/notes/origin
// from the remote, wiping any note written locally but not yet pushed (offline, a
// failed push). Reproduced: write a local note, pull, note gone.
//
// syncNotesFromRemote does the safe equivalent — stages into
// refs/notes/origin-remote, then `git notes merge -s ours` so this machine stays
// authoritative for commits it annotated itself — installs the persistent
// refspec, fetches once so existing attribution lands now, and strips the legacy
// clobbering refspec if an older release left one behind.
function configureNotesRefspecAndFetch(repoPath: string): void {
  try {
    const remotesRaw = runDetailed('git', ['remote'], { cwd: repoPath, timeoutMs: 3000 });
    const remote = (remotesRaw.stdout || '').trim().split('\n')[0].trim();
    if (!remote) return; // no remote — nothing to fetch from

    syncNotesFromRemote(repoPath);
    console.log(chalk.green(`  ✓ Configured ${remote} to fetch attribution notes (refs/notes/origin)`));
  } catch {
    // Non-fatal — user can still push/pull manually with explicit refspecs.
  }
}
