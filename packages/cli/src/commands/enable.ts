import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadConfig, saveRepoConfig, isConnectedMode } from '../config.js';
import { api } from '../api.js';
import { getGitRoot } from '../session-state.js';

// ─── Agent Definitions ────────────────────────────────────────────────────

type AgentType = 'claude-code' | 'cursor' | 'gemini' | 'windsurf' | 'codex' | 'aider';

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
    SessionStart: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code session-start' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code stop' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code user-prompt-submit' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code session-end' }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code pre-tool-use' }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code post-tool-use' }] }],
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
}

// ── Cursor Hooks ───────────────────────────────────────────────────────────

function installCursorHooks(gitRoot: string): void {
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

  const hooks: Record<string, any[]> = {
    sessionStart: [{ command: 'origin hooks cursor session-start' }],
    stop: [{ command: 'origin hooks cursor stop' }],
    beforeSubmitPrompt: [{ command: 'origin hooks cursor user-prompt-submit' }],
    sessionEnd: [{ command: 'origin hooks cursor session-end' }],
  };

  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!config.hooks[eventType]) config.hooks[eventType] = [];
    config.hooks[eventType] = config.hooks[eventType].filter(
      (h: any) => !(h.command && typeof h.command === 'string' && h.command.startsWith('origin hooks'))
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
    SessionStart: [{ hooks: [{ name: 'origin-session-start', type: 'command', command: 'origin hooks gemini session-start' }] }],
    SessionEnd: [
      { matcher: 'exit', hooks: [{ name: 'origin-session-end', type: 'command', command: 'origin hooks gemini session-end' }] },
      { matcher: 'logout', hooks: [{ name: 'origin-session-end-logout', type: 'command', command: 'origin hooks gemini session-end' }] },
    ],
    BeforeAgent: [{ hooks: [{ name: 'origin-before-agent', type: 'command', command: 'origin hooks gemini user-prompt-submit' }] }],
    AfterAgent: [{ hooks: [{ name: 'origin-after-agent', type: 'command', command: 'origin hooks gemini stop' }] }],
  };

  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!settings.hooks[eventType]) settings.hooks[eventType] = [];
    // Remove existing Origin hooks
    settings.hooks[eventType] = settings.hooks[eventType].filter((entry: any) => {
      if (entry.hooks) {
        entry.hooks = entry.hooks.filter(
          (h: any) => !(h.command && typeof h.command === 'string' && h.command.startsWith('origin hooks'))
        );
        return entry.hooks.length > 0;
      }
      return !(entry.command && typeof entry.command === 'string' && entry.command.startsWith('origin hooks'));
    });
    settings.hooks[eventType].push(...entries);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  const geminiLabel = gitRoot === os.homedir() ? `~/.gemini/settings.json` : `.gemini/settings.json`;
  console.log(chalk.green(`  ✓ Hooks installed in ${geminiLabel}`));
}

// ── Windsurf Hooks ────────────────────────────────────────────────────────

function installWindsurfHooks(gitRoot: string): void {
  const windsurfDir = path.join(gitRoot, '.windsurf');
  const hooksPath = path.join(windsurfDir, 'hooks.json');

  if (!fs.existsSync(windsurfDir)) {
    fs.mkdirSync(windsurfDir, { recursive: true });
  }

  let config: Record<string, any> = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    backupExistingHooks(hooksPath);
    try { config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')); } catch { config = { version: 1, hooks: {} }; }
  }

  if (!config.hooks) config.hooks = {};

  const hooks: Record<string, any[]> = {
    sessionStart: [{ command: 'origin hooks windsurf session-start' }],
    stop: [{ command: 'origin hooks windsurf stop' }],
    beforeSubmitPrompt: [{ command: 'origin hooks windsurf user-prompt-submit' }],
    sessionEnd: [{ command: 'origin hooks windsurf session-end' }],
  };

  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!config.hooks[eventType]) config.hooks[eventType] = [];
    config.hooks[eventType] = config.hooks[eventType].filter(
      (h: any) => !(h.command && typeof h.command === 'string' && h.command.startsWith('origin hooks'))
    );
    config.hooks[eventType].push(...entries);
  }

  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  const windsurfLabel = gitRoot === os.homedir() ? `~/.windsurf/hooks.json` : `.windsurf/hooks.json`;
  console.log(chalk.green(`  ✓ Hooks installed in ${windsurfLabel}`));
}

// ── Codex CLI Hooks ──────────────────────────────────────────────────────

function installCodexHooks(gitRoot: string): void {
  const codexDir = path.join(gitRoot, '.codex');
  const hooksPath = path.join(codexDir, 'hooks.json');

  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });
  }

  let config: Record<string, any> = { hooks: {} };
  if (fs.existsSync(hooksPath)) {
    backupExistingHooks(hooksPath);
    try { config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')); } catch { config = { hooks: {} }; }
  }

  if (!config.hooks) config.hooks = {};

  const hooks: Record<string, any[]> = {
    SessionStart: [{ hooks: [{ type: 'command', command: 'origin hooks codex session-start', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'origin hooks codex stop', timeout: 10 }] }],
  };

  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!config.hooks[eventType]) config.hooks[eventType] = [];
    config.hooks[eventType] = filterOriginHooks(config.hooks[eventType]);
    config.hooks[eventType].push(...entries);
  }

  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  const codexLabel = gitRoot === os.homedir() ? `~/.codex/hooks.json` : `.codex/hooks.json`;
  console.log(chalk.green(`  ✓ Hooks installed in ${codexLabel}`));
  console.log(chalk.gray('    Note: Enable hooks in Codex with: codex -c features.codex_hooks=true'));
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
    'notifications-command: origin hooks aider stop',
    '',
  ].join('\n');

  fs.appendFileSync(aiderConfPath, originBlock);
  console.log(chalk.green('  ✓ Hooks installed in .aider.conf.yml'));
  console.log(chalk.gray('    • git-commit-verify: enabled (runs Origin post-commit hook)'));
  console.log(chalk.gray('    • notifications-command: origin hooks aider stop'));
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
      h.command && typeof h.command === 'string' && h.command.startsWith('origin hooks')
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
  windsurf: {
    name: 'Windsurf',
    configDir: '.windsurf',
    configFile: 'hooks.json',
    detectDir: '.windsurf',
    command: 'windsurf',
    hookCommand: 'origin hooks windsurf',
    installHooks: installWindsurfHooks,
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
};

function detectAgents(gitRoot: string): AgentType[] {
  const detected: AgentType[] = [];
  for (const [type, agent] of Object.entries(AGENTS) as [AgentType, AgentConfig][]) {
    // Check for config directory
    if (agent.detectDir && fs.existsSync(path.join(gitRoot, agent.detectDir))) {
      detected.push(type);
      continue;
    }
    // For agents without a config dir (aider), check if binary exists
    if (!agent.detectDir) {
      try {
        execSync(`which ${agent.command}`, { stdio: 'ignore' });
        detected.push(type);
      } catch { /* not installed */ }
    }
  }
  return detected;
}

// ─── Main Command ──────────────────────────────────────────────────────────

// Agents that support global (~/) hook installation
const GLOBAL_CAPABLE_AGENTS: AgentType[] = ['claude-code', 'cursor', 'gemini', 'windsurf', 'codex'];

export async function enableCommand(opts: { agent?: string; global?: boolean; link?: string }): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Not logged in. Run: origin login'));
    process.exit(1);
  }

  const isGlobal = !!opts.global;
  let basePath: string;

  if (isGlobal) {
    basePath = os.homedir();
    console.log(chalk.bold('\n🌐 Enabling Origin session tracking globally\n'));
    console.log(chalk.gray(`  Home directory: ${basePath}`));
  } else {
    const gitRoot = getGitRoot();
    if (!gitRoot) {
      console.log(chalk.red('Not inside a git repository. Run this from your project directory.'));
      console.log(chalk.gray('  Tip: Use --global to install hooks for ALL repos.'));
      process.exit(1);
    }
    basePath = gitRoot;
    console.log(chalk.bold('\n🔗 Enabling Origin session tracking\n'));
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
      // In global mode, detect which agent binaries are installed
      agentsToEnable = GLOBAL_CAPABLE_AGENTS.filter((type) => {
        try {
          execSync(`which ${AGENTS[type].command}`, { stdio: 'ignore' });
          return true;
        } catch { return false; }
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
    installGitPostCommitHook(basePath);
    installGitPrePushHook(basePath);
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

  console.log(chalk.bold('\n📋 Next steps:\n'));
  const firstAgent = AGENTS[agentsToEnable[0]];
  const connected = isConnectedMode();
  if (isGlobal) {
    console.log(chalk.white('  1. Open any repo and start coding with ') + chalk.cyan(firstAgent.command));
    console.log(chalk.white('  2. Sessions are captured automatically for ALL repos'));
    console.log(chalk.white('  3. View sessions: ') + chalk.cyan('origin sessions'));
    if (connected && config?.apiUrl) {
      console.log(chalk.white('  4. Or check the dashboard: ') + chalk.cyan(config.apiUrl));
    }
  } else {
    console.log(chalk.white('  1. Start coding: ') + chalk.cyan(firstAgent.command));
    console.log(chalk.white('  2. Work normally — Origin captures everything automatically'));
    console.log(chalk.white('  3. View sessions: ') + chalk.cyan('origin sessions'));
    if (connected && config?.apiUrl) {
      console.log(chalk.white('  4. Or check the dashboard: ') + chalk.cyan(config.apiUrl));
    }
  }

  console.log(chalk.green(`\n✓ Origin session tracking enabled${isGlobal ? ' globally' : ''}.\n`));
}

// ─── Global Git Hooks (core.hooksPath) ────────────────────────────────────

function installGlobalGitHooks(): void {
  const globalHooksDir = path.join(os.homedir(), '.origin', 'git-hooks');

  // Create global hooks directory
  if (!fs.existsSync(globalHooksDir)) {
    fs.mkdirSync(globalHooksDir, { recursive: true });
  }

  // Resolve full path to origin binary
  let originBin = 'origin';
  try {
    originBin = execSync('which origin', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { /* fallback to bare name */ }

  // Post-commit hook that also chains to local repo hooks
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
  "$ORIGIN_BIN" hooks git-post-commit &
fi

# Chain to local repo hooks if they exist
LOCAL_HOOK="\$(git rev-parse --git-dir 2>/dev/null)/hooks/post-commit"
if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@"
fi
`;
  fs.writeFileSync(postCommitPath, postCommitContent);
  fs.chmodSync(postCommitPath, '755');

  // Pre-push hook that also chains to local repo hooks
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
fi

# Chain to local repo hooks if they exist
LOCAL_HOOK="\$(git rev-parse --git-dir 2>/dev/null)/hooks/pre-push"
if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then
  "$LOCAL_HOOK" "$@"
fi
`;
  fs.writeFileSync(prePushPath, prePushContent);
  fs.chmodSync(prePushPath, '755');

  // Set git config to use our global hooks directory
  try {
    execSync(`git config --global core.hooksPath ${globalHooksDir}`, { stdio: 'pipe' });
    console.log(chalk.green('\n  ✓ Global git hooks installed'));
    console.log(chalk.gray(`    Hooks directory: ${globalHooksDir}`));
    console.log(chalk.gray('    Local repo hooks are chained automatically'));
  } catch (err: any) {
    console.log(chalk.yellow(`\n  ⚠ Could not set global git hooks: ${err.message}`));
  }
}

// ─── Git Post-Commit Hook ─────────────────────────────────────────────────

function installGitPostCommitHook(gitRoot: string): void {
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'post-commit');

  // Ensure hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const ORIGIN_MARKER = '# origin-post-commit';
  const hookScript = `origin hooks git-post-commit`;

  // Check if hook file already exists
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes(ORIGIN_MARKER)) {
      console.log(chalk.gray('  ✓ Git post-commit hook already installed'));
      return;
    }
    // Append to existing hook
    const append = `\n${ORIGIN_MARKER}\n${hookScript} &\n`;
    fs.appendFileSync(hookPath, append);
  } else {
    // Create new hook file
    const content = `#!/bin/sh\n${ORIGIN_MARKER}\n${hookScript} &\n`;
    fs.writeFileSync(hookPath, content);
  }

  // Make executable
  fs.chmodSync(hookPath, '755');
  console.log(chalk.green('  ✓ Git post-commit hook installed'));
}

// ─── Git Pre-Push Hook (F14) ──────────────────────────────────────────────

function installGitPrePushHook(gitRoot: string): void {
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-push');

  // Ensure hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const ORIGIN_MARKER = '# origin-pre-push';
  const hookScript = `origin hooks git-pre-push`;

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
