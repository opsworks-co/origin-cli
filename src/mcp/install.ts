// Register `origin mcp serve` with the agents on this machine.
//
// Covers Claude Code, Cursor, Codex, Gemini CLI, Antigravity and Copilot CLI.
// Two agents are absent, for opposite reasons:
//
//   DEVIN reads the project-scoped .mcp.json the `claude` writer already
//   produces, so a devin entry would duplicate an existing registration.
//   (`devin mcp list` reports the origin server from a repo with that file and
//   nothing from a repo without one.)
//
//   AIDER has no MCP client at all as of v0.86 — the integration PRs were
//   closed unmerged and its config reference lists no MCP options. Nothing to
//   write, and nothing to wait for until that changes.
//
// The bar for inclusion is a config location we can point at, not a guess:
// writing a file an agent never reads is worse than writing nothing, because
// it looks installed.
//
// Every writer here obeys the same three rules, learned from the hook
// installers next door:
//
//   1. IDEMPOTENT — re-running replaces Origin's entry, never duplicates it.
//   2. BACKED UP — the file is copied aside before the first mutation.
//   3. ABSOLUTE BINARY PATH — never a bare `origin`. That assumes the agent's
//      PATH contains it, which is exactly the assumption that silently broke
//      every global git hook on Windows (#1037): the shim's PATH additions were
//      macOS/Linux-only, so when %APPDATA%\npm wasn't already there the hook
//      exited 0 having done nothing. An MCP server that fails to spawn is the
//      same failure with the same symptom — nothing, quietly.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { findExecutables } from '../utils/exec.js';

export type McpAgentSlug = 'claude' | 'codex' | 'cursor' | 'gemini' | 'antigravity' | 'copilot';

export interface McpInstallResult {
  agent: McpAgentSlug;
  file: string;
  status: 'installed' | 'updated' | 'unchanged' | 'skipped' | 'failed';
  detail?: string;
  /** Set when a superseded config from an older CLI was cleaned up alongside. */
  legacy?: LegacyCleanupResult;
}

export interface LegacyCleanupResult {
  file: string;
  action: 'removed-file' | 'removed-entry' | 'none';
}

// Extensions Windows' CreateProcess will actually launch, best first. Anything
// outside this set is a POSIX shim: npm installs `origin` as BOTH an
// extensionless `#!/bin/sh` script and an `origin.cmd`, and `where` lists the
// sh script FIRST. Handing that path to an agent is the "looks installed, does
// nothing" failure this module exists to avoid — the agent spawns it and gets
// ENOENT, because a shebang means nothing to Windows.
const WINDOWS_SPAWNABLE = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Pick the path an agent can actually spawn out of everything `where` reported.
 *
 * POSIX has no such problem — one name, one file, already executable — so this
 * only reorders on Windows. If none of the candidates carries a runnable
 * extension, try appending one: `where` can report just the shim when the .cmd
 * sits in a directory it already matched.
 */
export function preferSpawnableBin(
  candidates: string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!candidates.length) return null;
  if (platform !== 'win32') return candidates[0];

  // Rank by extension, not by the order `where` printed: `where` leads with the
  // literal-name match (the shim), and among real executables Windows itself
  // resolves in PATHEXT order, which puts .exe ahead of .cmd.
  const rank = (p: string) => WINDOWS_SPAWNABLE.indexOf(path.extname(p).toLowerCase());
  const direct = candidates.filter((p) => rank(p) >= 0).sort((a, b) => rank(a) - rank(b))[0];
  if (direct) return direct;

  for (const base of candidates) {
    for (const ext of WINDOWS_SPAWNABLE) {
      if (fs.existsSync(base + ext)) return base + ext;
    }
  }
  return candidates[0];
}

/** Absolute path to the origin binary, or the bare name if it can't be found. */
export function originBinForMcp(): string {
  try {
    const found = preferSpawnableBin(findExecutables('origin'));
    if (found) return found;
  } catch { /* fall through */ }
  return 'origin';
}

/** The command + args every agent config points at. */
export function mcpServerCommand(): { command: string; args: string[] } {
  return { command: originBinForMcp(), args: ['mcp', 'serve'] };
}

/**
 * Can the binary we're about to record actually serve MCP?
 *
 * This is not paranoia — it is the first thing that went wrong in practice.
 * `origin mcp install` run from a source checkout resolves `origin` to whatever
 * is on PATH, which is the last RELEASED build. Every release before the MCP
 * fold answers `origin mcp serve` with "error: unknown command 'mcp'" and
 * exits. The config gets written, the agent spawns it, the process dies
 * instantly, and the agent shows a server that is present and broken — the
 * exact "looks installed, does nothing" outcome this module exists to avoid.
 *
 * Probing by exit code rather than by parsing --help: on an older binary
 * `origin mcp --help` still exits 0 (the global --help short-circuits before
 * the unknown-command error), so help text is not a reliable signal. Running
 * the read-only `mcp status` exits 1 on an unsupported binary and 0 on a
 * supported one. It runs from a temp cwd so a missing git repo can't skew it.
 */
export function mcpCapable(bin: string): boolean {
  // Windows: npm installs `origin` as BOTH an extensionless shim and
  // `origin.cmd`, and `where` happily reports the .cmd. Node refuses to
  // execFile a .cmd/.bat without a shell, so probing one unguarded throws
  // EINVAL — indistinguishable from "this binary can't serve MCP". Left alone
  // that would make the guard refuse to install on every Windows machine.
  // `windowsHide` keeps the shell from flashing a console window, the same
  // trap the hook installers hit under GUI agents (#829).
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  try {
    execFileSync(needsShell ? `"${bin}"` : bin, ['mcp', 'status'], {
      cwd: os.tmpdir(),
      stdio: 'ignore',
      timeout: 15_000,
      shell: needsShell,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function backupOnce(file: string): void {
  if (!fs.existsSync(file)) return;
  const bak = `${file}.origin-backup`;
  if (fs.existsSync(bak)) return; // keep the FIRST pre-Origin state, not the latest
  try { fs.copyFileSync(file, bak); } catch { /* best effort */ }
}

function readJson(file: string): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) || {}; } catch { return {}; }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * The server entry each agent expects under `mcpServers`.
 *
 * Copilot CLI additionally requires a transport `type` ("local" for a stdio
 * subprocess) — omit it and the entry is rejected. Note also that Copilot CLI
 * uses `mcpServers` while Copilot in VS Code uses `servers`; these are
 * different files with different schemas, and only the CLI one is written here.
 */
function serverEntry(agent: McpAgentSlug, command: string, args: string[]): Record<string, unknown> {
  if (agent === 'copilot') return { type: 'local', command, args, tools: ['*'] };
  return { command, args };
}

/** Shared shape for the agents that use a JSON `mcpServers` map. */
function installJsonMcpServers(
  agent: McpAgentSlug,
  file: string,
  entryName = 'origin',
): McpInstallResult {
  const { command, args } = mcpServerCommand();
  const existed = fs.existsSync(file);
  const parsed = existed ? readJson(file) : {};
  const before = JSON.stringify(parsed.mcpServers?.[entryName] ?? null);

  const next = serverEntry(agent, command, args);
  if (before === JSON.stringify(next)) {
    return { agent, file, status: 'unchanged' };
  }

  if (existed) backupOnce(file);
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') parsed.mcpServers = {};
  parsed.mcpServers[entryName] = next;
  writeJson(file, parsed);
  return { agent, file, status: before === 'null' ? 'installed' : 'updated' };
}

// ── Codex: TOML, not JSON ───────────────────────────────────────────────────
//
// `~/.codex/config.toml` is hand-editable and already carries Origin's hook
// wiring, so this does a surgical block replace rather than a parse/serialize
// round-trip — re-emitting the whole file would reformat and drop the user's
// comments.
const CODEX_BLOCK_RE = /\n*#? *Origin MCP server[\s\S]*?(?=\n\[|$)|\n*\[mcp_servers\.origin\][\s\S]*?(?=\n\[|$)/g;

export function renderCodexBlock(command: string, args: string[]): string {
  const argList = args.map((a) => JSON.stringify(a)).join(', ');
  return [
    '',
    '# Origin MCP server — managed by `origin mcp install`',
    '[mcp_servers.origin]',
    `command = ${JSON.stringify(command)}`,
    `args = [${argList}]`,
    '',
  ].join('\n');
}

function installCodex(file: string): McpInstallResult {
  const { command, args } = mcpServerCommand();
  const block = renderCodexBlock(command, args);
  const existed = fs.existsSync(file);
  const current = existed ? fs.readFileSync(file, 'utf-8') : '';

  const stripped = current.replace(CODEX_BLOCK_RE, '\n');
  const next = `${stripped.replace(/\n+$/, '')}\n${block}`;
  if (existed && current.trim() === next.trim()) {
    return { agent: 'codex', file, status: 'unchanged' };
  }

  if (existed) backupOnce(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return { agent: 'codex', file, status: current.includes('[mcp_servers.origin]') ? 'updated' : 'installed' };
}

/**
 * Where each agent reads its MCP server list.
 *
 * Scope note: Claude Code is registered PROJECT-scoped (a small file we own at
 * the repo root) rather than user-scoped. `~/.claude.json` in
 * particular is large, live Claude Code state — 108 project entries, OAuth
 * account, feature caches on the machine this was written against — and a
 * malformed merge there breaks the user's whole install. A project `.mcp.json`
 * is the documented format, is small, and Claude Code asks the user to approve
 * it before use (that consent is tracked in `enabledMcpjsonServers`), which is
 * the right default for a tool that reads session history.
 */
export function mcpConfigPath(agent: McpAgentSlug, gitRoot: string): string {
  switch (agent) {
    case 'claude':  return path.join(gitRoot, '.mcp.json');
    // Cursor reads its user-level server list from ~/.cursor/mcp.json. The
    // project-scoped <repo>/.cursor/mcp.json is documented, and Cursor's own
    // bundle references both, but the agent runtime that powers its current
    // UI does NOT pick the project one up: verified on a real install where
    // Cursor restarted 30 minutes AFTER that file appeared, re-scanned, and
    // still listed only its two built-in servers. Writing the global path and
    // restarting produced `user-origin` (status ready, all tools) in the
    // agent's own registry at ~/.cursor/projects/<proj>/mcps/.
    case 'cursor':  return path.join(os.homedir(), '.cursor', 'mcp.json');
    case 'codex':   return path.join(os.homedir(), '.codex', 'config.toml');
    case 'gemini':  return path.join(os.homedir(), '.gemini', 'settings.json');
    // Antigravity keeps MCP separate from the settings file Gemini CLI uses —
    // a sibling of the hooks.json Origin already writes for it. Schema
    // confirmed against the shipped `agy` binary, which carries
    // `struct { McpServers map[string]common.MCPServerConfig "json:\"mcpServers\"" }`
    // and a troubleshooting string naming mcp_config.json by path.
    case 'antigravity': return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
    // GitHub Copilot CLI. Documented at ~/.copilot/mcp-config.json (overridable
    // via COPILOT_HOME). NOT the same as Copilot in VS Code, which uses
    // .vscode/mcp.json with a `servers` key — different file, different schema.
    case 'copilot': return path.join(os.homedir(), '.copilot', 'mcp-config.json');
  }
}

// Agents whose MCP config location AND schema are verified against a real
// install. Copilot and Aider are absent on purpose: neither could be verified
// (no binary on the machine this was built against), and a config written
// where nothing reads it reports success while changing nothing.
//
// Devin is absent because it needs NO entry — it reads the project-scoped
// `.mcp.json` that the `claude` writer already produces. Verified: from a repo
// containing that file `devin mcp list` reports the origin server with the
// right command; from a directory without one it reports none.
export const MCP_SUPPORTED_AGENTS: McpAgentSlug[] = ['claude', 'codex', 'cursor', 'gemini', 'antigravity', 'copilot'];

/** @deprecated Old name from the phased rollout — kept so callers don't break. */
export const MCP_PHASE1_AGENTS = MCP_SUPPORTED_AGENTS;

/**
 * Remove the per-repo Cursor config written by CLI versions before the move to
 * the global path.
 *
 * Those files are inert — the whole reason for the move is that Cursor's agent
 * runtime never reads them — so this is tidiness, not a fix. That makes the
 * conservative choices the right ones: only ever touch OUR entry, and only
 * delete the FILE when Origin is demonstrably the one that created it.
 *
 * "Created by us" is decided by the backup sibling, not by guesswork:
 * backupOnce writes `<file>.origin-backup` only when the file ALREADY existed,
 * so its absence means we wrote the file from nothing and removing it restores
 * the pre-Origin state exactly. If a backup IS present the file predates us —
 * drop our entry and leave the rest alone, whatever else it holds.
 *
 * Never throws: cleanup is a courtesy running inside install, and a read-only
 * checkout or a permission error must not fail the registration it rides along
 * with.
 */
export function cleanupLegacyCursorProjectConfig(gitRoot: string): LegacyCleanupResult {
  const file = path.join(gitRoot, '.cursor', 'mcp.json');
  const none: LegacyCleanupResult = { file, action: 'none' };
  try {
    if (!fs.existsSync(file)) return none;
    const parsed = readJson(file);
    if (!parsed.mcpServers?.origin) return none; // someone else's file — hands off

    delete parsed.mcpServers.origin;
    const otherServers = Object.keys(parsed.mcpServers).length > 0;
    const otherKeys = Object.keys(parsed).filter((k) => k !== 'mcpServers').length > 0;
    const weCreatedIt = !fs.existsSync(`${file}.origin-backup`);

    if (!otherServers && !otherKeys && weCreatedIt) {
      fs.rmSync(file);
      // Take the directory too if it was only ever a wrapper for this file.
      // rmdir fails on a non-empty dir, which is exactly the guard we want —
      // .cursor commonly also holds rules/, and that is the user's.
      try { fs.rmdirSync(path.dirname(file)); } catch { /* not empty — leave it */ }
      return { file, action: 'removed-file' };
    }

    if (!otherServers) delete parsed.mcpServers;
    writeJson(file, parsed);
    return { file, action: 'removed-entry' };
  } catch {
    return none;
  }
}

export function installMcpForAgent(agent: McpAgentSlug, gitRoot: string): McpInstallResult {
  const file = mcpConfigPath(agent, gitRoot);
  try {
    if (agent === 'codex') return installCodex(file);
    // Everything else is a JSON file keyed by `mcpServers`.
    const result = installJsonMcpServers(agent, file);
    // Registering Cursor globally leaves any pre-move project file orphaned.
    // Sweep it here rather than in a one-off command, so the fix reaches
    // everyone who upgrades instead of only those who read the release note.
    if (agent === 'cursor') {
      const legacy = cleanupLegacyCursorProjectConfig(gitRoot);
      if (legacy.action !== 'none') result.legacy = legacy;
    }
    return result;
  } catch (err: any) {
    return { agent, file, status: 'failed', detail: err?.message || String(err) };
  }
}

// ── `origin enable` / `origin disable` integration ──────────────────────────

/** Pipeline agent slugs (AgentType in enable.ts) → the MCP agents we support. */
const AGENT_TYPE_TO_MCP: Record<string, McpAgentSlug> = {
  'claude-code': 'claude',
  claude: 'claude',
  cursor: 'cursor',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'antigravity',
  copilot: 'copilot',
};

/**
 * Claude Code is registered PROJECT-scoped (see mcpConfigPath), so it only
 * means anything when `enable` is run inside a repo. Under `enable --global`
 * the base path is the home directory, where a `.mcp.json` would sit unread —
 * Claude Code looks for it in the PROJECT root. Registering there would be the
 * "writes a file nothing reads" failure this module exists to avoid, so global
 * enable covers only the genuinely global configs.
 *
 * Cursor used to be in this set and no longer is: it reads a global config
 * (see mcpConfigPath), so `enable --global` registers it like any other.
 */
export function isProjectScopedMcpAgent(agent: McpAgentSlug): boolean {
  return agent === 'claude';
}

/**
 * Which MCP agents `enable` should register, given the agents it just wired
 * hooks for. Deduped, order-stable, and filtered to the verified Phase 1 set.
 */
export function mcpAgentsForEnable(agentTypes: string[], isGlobal: boolean): McpAgentSlug[] {
  const out: McpAgentSlug[] = [];
  for (const t of agentTypes) {
    const slug = AGENT_TYPE_TO_MCP[t];
    if (!slug || out.includes(slug)) continue;
    if (isGlobal && isProjectScopedMcpAgent(slug)) continue;
    out.push(slug);
  }
  return out;
}

/** Remove Origin's MCP registration — the `origin disable` counterpart. */
export function uninstallMcpForAgent(agent: McpAgentSlug, gitRoot: string): McpInstallResult {
  const file = mcpConfigPath(agent, gitRoot);
  // Runs before the exists() check below: "remove Origin" has to clear the
  // pre-move project file even when the global one was never written.
  const legacy = agent === 'cursor'
    ? cleanupLegacyCursorProjectConfig(gitRoot)
    : { file, action: 'none' as const };
  const withLegacy = (r: McpInstallResult): McpInstallResult =>
    (legacy.action !== 'none' ? { ...r, legacy } : r);
  try {
    if (!fs.existsSync(file)) return withLegacy({ agent, file, status: 'unchanged' });
    if (agent === 'codex') {
      const current = fs.readFileSync(file, 'utf-8');
      if (!current.includes('[mcp_servers.origin]')) return withLegacy({ agent, file, status: 'unchanged' });
      backupOnce(file);
      fs.writeFileSync(file, current.replace(CODEX_BLOCK_RE, '\n').replace(/\n{3,}/g, '\n\n'));
      return withLegacy({ agent, file, status: 'updated' });
    }
    const parsed = readJson(file);
    if (!parsed.mcpServers?.origin) return withLegacy({ agent, file, status: 'unchanged' });
    backupOnce(file);
    delete parsed.mcpServers.origin;
    if (Object.keys(parsed.mcpServers).length === 0) delete parsed.mcpServers;
    writeJson(file, parsed);
    return withLegacy({ agent, file, status: 'updated' });
  } catch (err: any) {
    return withLegacy({ agent, file, status: 'failed', detail: err?.message || String(err) });
  }
}
