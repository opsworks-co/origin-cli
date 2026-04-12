import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── CLI tools we check via `which` ───────────────────────────────────────────
const CLI_CHECKS = [
  { name: 'claude',    cmd: 'which claude' },
  { name: 'cursor',    cmd: 'which cursor' },
  { name: 'aider',     cmd: 'which aider' },
  { name: 'gemini',    cmd: 'which gemini' },
  { name: 'windsurf',  cmd: 'which windsurf' },
  { name: 'copilot',   cmd: 'which github-copilot-cli' },
  { name: 'cody',      cmd: 'which cody' },
  { name: 'continue',  cmd: 'which continue' },
  { name: 'code',      cmd: 'which code' },       // VS Code
  { name: 'codium',    cmd: 'which codium' },      // VSCodium
  { name: 'codex',     cmd: 'which codex' },       // OpenAI Codex CLI
];

// ── IDE extensions that indicate AI tool usage ───────────────────────────────
const AI_EXTENSIONS: Record<string, string> = {
  'github.copilot':        'copilot',
  'github.copilot-chat':   'copilot',
  'sourcegraph.cody-ai':   'cody',
  'continue.continue':     'continue',
  'codeium.codeium':       'codeium',
  'saoudrizwan.claude-dev': 'cline',       // Cline (formerly Claude Dev)
  'anysphere.cursor-ai':   'cursor',
};

// ── Extension directory markers (folder-name prefix → tool name) ─────────────
const EXTENSION_DIR_PREFIXES: Record<string, string> = {
  'github.copilot':        'copilot',
  'sourcegraph.cody-ai':   'cody',
  'continue.continue':     'continue',
  'codeium.codeium':       'codeium',
  'saoudrizwan.claude-dev': 'cline',
};

// ── MCP server names that indicate tool presence ─────────────────────────────
const MCP_SERVER_NAMES: Record<string, string> = {
  'origin':     'origin-mcp',
  'filesystem': 'mcp-filesystem',
  'github':     'mcp-github',
  'postgres':   'mcp-postgres',
  'sqlite':     'mcp-sqlite',
};

/**
 * Detect AI coding tools installed on this machine.
 *
 * Three detection layers:
 * 1. CLI availability via `which`
 * 2. IDE extension lists (`code --list-extensions`, etc.)
 * 3. Extension directory scanning & MCP config inspection
 */
export function detectTools(): string[] {
  const found = new Set<string>();

  // ── Layer 1: CLI availability ──────────────────────────────────────────────
  for (const { name, cmd } of CLI_CHECKS) {
    try {
      const parts = cmd.split(' ');
      execFileSync(parts[0], parts.slice(1), { stdio: 'ignore', timeout: 3000 });
      found.add(name);
    } catch { /* not installed */ }
  }

  // Also check `gh copilot` sub-command (GitHub CLI extension)
  try {
    execFileSync('gh', ['copilot', '--help'], { stdio: 'ignore', timeout: 3000 });
    found.add('copilot');
  } catch { /* not installed */ }

  // Check npx cache for tools installed via npx (e.g. codex)
  if (!found.has('codex')) {
    try {
      const npxCache = path.join(os.homedir(), '.npm', '_npx');
      if (fs.existsSync(npxCache)) {
        const dirs = fs.readdirSync(npxCache);
        for (const d of dirs) {
          const bin = path.join(npxCache, d, 'node_modules', '.bin', 'codex');
          if (fs.existsSync(bin)) { found.add('codex'); break; }
        }
      }
    } catch { /* ignore */ }
  }

  // ── Layer 1.5: Config directory detection (IDE may not install CLI to PATH)
  const CONFIG_DIR_TOOLS: Record<string, string> = {
    '.cursor': 'cursor',
    '.windsurf': 'windsurf',
  };
  for (const [dir, tool] of Object.entries(CONFIG_DIR_TOOLS)) {
    if (!found.has(tool) && fs.existsSync(path.join(os.homedir(), dir))) {
      found.add(tool);
    }
  }

  // ── Layer 2: IDE extension lists ───────────────────────────────────────────
  const extensionTools = detectIDEExtensions();
  for (const tool of extensionTools) found.add(tool);

  // ── Layer 3: MCP config inspection ─────────────────────────────────────────
  const mcpTools = detectMCPServers();
  for (const tool of mcpTools) found.add(tool);

  return [...found].sort();
}

/**
 * Query IDE CLIs for installed extensions and scan extension directories.
 */
export function detectIDEExtensions(): string[] {
  const found = new Set<string>();

  // Query CLIs that support --list-extensions
  const ideCLIs = ['code', 'codium', 'cursor'];
  for (const cli of ideCLIs) {
    try {
      const output = execFileSync(cli, ['--list-extensions'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const extensions = output.toLowerCase().split('\n').map(e => e.trim());
      for (const [extId, toolName] of Object.entries(AI_EXTENSIONS)) {
        if (extensions.includes(extId.toLowerCase())) {
          found.add(toolName);
        }
      }
    } catch { /* CLI not available or timed out */ }
  }

  // Scan extension directories on disk
  const extensionDirs = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
    path.join(os.homedir(), '.windsurf', 'extensions'),
    path.join(os.homedir(), '.vscode-oss', 'extensions'),  // VSCodium
  ];

  for (const dir of extensionDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        for (const [prefix, toolName] of Object.entries(EXTENSION_DIR_PREFIXES)) {
          if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
            found.add(toolName);
          }
        }
      }
    } catch { /* can't read dir */ }
  }

  return [...found];
}

/**
 * Check MCP configuration files for registered servers.
 */
export function detectMCPServers(): string[] {
  const found = new Set<string>();

  const mcpConfigPaths = [
    path.join(os.homedir(), '.claude', 'settings.json'),           // Claude Code global
    path.join(os.homedir(), '.cursor', 'mcp.json'),                // Cursor MCP
    path.join(os.homedir(), '.config', 'claude', 'settings.json'), // Claude Code alt
  ];

  for (const configPath of mcpConfigPaths) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);

      // Claude Code format: { mcpServers: { "name": { ... } } }
      const servers = config.mcpServers || config.mcp?.servers || {};
      for (const serverName of Object.keys(servers)) {
        const lower = serverName.toLowerCase();
        for (const [key, toolName] of Object.entries(MCP_SERVER_NAMES)) {
          if (lower.includes(key)) {
            found.add(toolName);
          }
        }
      }
    } catch { /* can't read or parse */ }
  }

  return [...found];
}
