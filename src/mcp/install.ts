// Register `origin mcp serve` with the agents on this machine.
//
// Phase 1 covers the four agents whose MCP config location is verified against
// a real install: Claude Code, Codex, Cursor and Gemini CLI. The rest of the
// catalogue (Copilot, Devin, Antigravity, Aider) is deliberately absent —
// writing a config file an agent never reads is worse than writing nothing,
// because it looks installed.
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
import { findExecutable } from '../utils/exec.js';

export type McpAgentSlug = 'claude' | 'codex' | 'cursor' | 'gemini';

export interface McpInstallResult {
  agent: McpAgentSlug;
  file: string;
  status: 'installed' | 'updated' | 'unchanged' | 'skipped' | 'failed';
  detail?: string;
}

/** Absolute path to the origin binary, or the bare name if it can't be found. */
export function originBinForMcp(): string {
  try {
    const found = findExecutable('origin');
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

/** Shared shape for the three agents that use a JSON `mcpServers` map. */
function installJsonMcpServers(
  agent: McpAgentSlug,
  file: string,
  entryName = 'origin',
): McpInstallResult {
  const { command, args } = mcpServerCommand();
  const existed = fs.existsSync(file);
  const parsed = existed ? readJson(file) : {};
  const before = JSON.stringify(parsed.mcpServers?.[entryName] ?? null);

  const next = { command, args };
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
 * Scope note: Claude Code and Cursor are registered PROJECT-scoped (a small
 * file we own at the repo root) rather than user-scoped. `~/.claude.json` in
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
    case 'cursor':  return path.join(gitRoot, '.cursor', 'mcp.json');
    case 'codex':   return path.join(os.homedir(), '.codex', 'config.toml');
    case 'gemini':  return path.join(os.homedir(), '.gemini', 'settings.json');
  }
}

export const MCP_PHASE1_AGENTS: McpAgentSlug[] = ['claude', 'codex', 'cursor', 'gemini'];

export function installMcpForAgent(agent: McpAgentSlug, gitRoot: string): McpInstallResult {
  const file = mcpConfigPath(agent, gitRoot);
  try {
    if (agent === 'codex') return installCodex(file);
    return installJsonMcpServers(agent, file);
  } catch (err: any) {
    return { agent, file, status: 'failed', detail: err?.message || String(err) };
  }
}

/** Remove Origin's MCP registration — the `origin disable` counterpart. */
export function uninstallMcpForAgent(agent: McpAgentSlug, gitRoot: string): McpInstallResult {
  const file = mcpConfigPath(agent, gitRoot);
  try {
    if (!fs.existsSync(file)) return { agent, file, status: 'unchanged' };
    if (agent === 'codex') {
      const current = fs.readFileSync(file, 'utf-8');
      if (!current.includes('[mcp_servers.origin]')) return { agent, file, status: 'unchanged' };
      backupOnce(file);
      fs.writeFileSync(file, current.replace(CODEX_BLOCK_RE, '\n').replace(/\n{3,}/g, '\n\n'));
      return { agent, file, status: 'updated' };
    }
    const parsed = readJson(file);
    if (!parsed.mcpServers?.origin) return { agent, file, status: 'unchanged' };
    backupOnce(file);
    delete parsed.mcpServers.origin;
    if (Object.keys(parsed.mcpServers).length === 0) delete parsed.mcpServers;
    writeJson(file, parsed);
    return { agent, file, status: 'updated' };
  } catch (err: any) {
    return { agent, file, status: 'failed', detail: err?.message || String(err) };
  }
}
