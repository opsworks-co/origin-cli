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
  { name: 'devin',     cmd: 'which devin' },
  { name: 'copilot',   cmd: 'which github-copilot-cli' },
  { name: 'cody',      cmd: 'which cody' },
  { name: 'continue',  cmd: 'which continue' },
  { name: 'code',      cmd: 'which code' },       // VS Code
  { name: 'codium',    cmd: 'which codium' },      // VSCodium
  { name: 'codex',     cmd: 'which codex' },       // OpenAI Codex CLI
  { name: 'antigravity', cmd: 'which agy' },        // Google Antigravity CLI (binary: agy)
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
      execFileSync(parts[0], parts.slice(1), { windowsHide: true, stdio: 'ignore', timeout: 3000 });
      found.add(name);
    } catch { /* not installed */ }
  }

  // Also check `gh copilot` sub-command (GitHub CLI extension)
  try {
    execFileSync('gh', ['copilot', '--help'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
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
    '.devin': 'devin',
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

  // Installed is not usable for Gemini: Google retired the Gemini CLI for
  // personal accounts ("migrate to Antigravity", 2026-10). The web's Start
  // menu offers Gemini only where it can run (see geminiCanRun).
  if (found.has('gemini') && geminiCanRun()) found.add(GEMINI_USABLE_TOOL);

  return [...found].sort();
}

/** Reported beside `gemini` when the Gemini CLI can actually run here. */
export const GEMINI_USABLE_TOOL = 'gemini-api-key';

/** Gemini auth types that still work: an API key, Vertex AI, or Google Cloud credentials. */
const GEMINI_RUNNABLE_AUTH = new Set(['gemini-api-key', 'vertex-ai', 'compute-default-credentials', 'cloud-shell']);

/**
 * Can the Gemini CLI run on this machine? An API key or Vertex in the
 * environment or `~/.gemini/.env`, or a non-personal auth type in
 * `~/.gemini/settings.json`. The personal Google login (`oauth-personal`) is
 * refused by Google now: "This client is no longer supported for Gemini Code
 * Assist for individuals".
 */
export function geminiCanRun(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): boolean {
  const truthy = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false';
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || truthy(env.GOOGLE_GENAI_USE_VERTEXAI)) return true;
  try {
    const dotenv = fs.readFileSync(path.join(home, '.gemini', '.env'), 'utf-8');
    if (/^\s*(?:export\s+)?(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*\S/m.test(dotenv)) return true;
    if (/^\s*(?:export\s+)?GOOGLE_GENAI_USE_VERTEXAI\s*=\s*(true|1)\b/im.test(dotenv)) return true;
  } catch { /* no .env */ }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf-8'));
    const type = s?.security?.auth?.selectedType ?? s?.selectedAuthType;
    if (typeof type === 'string' && GEMINI_RUNNABLE_AUTH.has(type)) return true;
  } catch { /* no settings */ }
  return false;
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
        windowsHide: true,
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
    path.join(os.homedir(), '.devin', 'extensions'),
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
