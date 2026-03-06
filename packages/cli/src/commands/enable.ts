import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { getGitRoot } from '../session-state.js';

// ─── Agent Definitions ────────────────────────────────────────────────────

type AgentType = 'claude-code' | 'cursor' | 'gemini';

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
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
  }

  if (!settings.hooks) settings.hooks = {};

  const hooks: Record<string, any[]> = {
    SessionStart: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code session-start' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code stop' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code user-prompt-submit' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'origin hooks claude-code session-end' }] }],
  };

  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!settings.hooks[eventType]) settings.hooks[eventType] = [];
    settings.hooks[eventType] = filterOriginHooks(settings.hooks[eventType]);
    settings.hooks[eventType].push(...entries);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(chalk.green('  ✓ Hooks installed in .claude/settings.json'));
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
  console.log(chalk.green('  ✓ Hooks installed in .cursor/hooks.json'));
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
  console.log(chalk.green('  ✓ Hooks installed in .gemini/settings.json'));
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
};

function detectAgents(gitRoot: string): AgentType[] {
  const detected: AgentType[] = [];
  for (const [type, agent] of Object.entries(AGENTS) as [AgentType, AgentConfig][]) {
    if (fs.existsSync(path.join(gitRoot, agent.detectDir))) {
      detected.push(type);
    }
  }
  return detected;
}

// ─── Main Command ──────────────────────────────────────────────────────────

export async function enableCommand(opts: { agent?: string }): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('Not logged in. Run: origin login'));
    process.exit(1);
  }

  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.log(chalk.red('Not inside a git repository. Run this from your project directory.'));
    process.exit(1);
  }

  console.log(chalk.bold('\n🔗 Enabling Origin session tracking\n'));

  // Determine which agents to enable
  let agentsToEnable: AgentType[];

  if (opts.agent) {
    const agent = opts.agent.toLowerCase() as AgentType;
    if (!AGENTS[agent]) {
      console.log(chalk.red(`Unknown agent: ${opts.agent}`));
      console.log(chalk.gray(`Supported agents: ${Object.keys(AGENTS).join(', ')}`));
      process.exit(1);
    }
    agentsToEnable = [agent];
  } else {
    // Auto-detect agents
    agentsToEnable = detectAgents(gitRoot);
    if (agentsToEnable.length === 0) {
      // Default to claude-code if nothing detected
      agentsToEnable = ['claude-code'];
      console.log(chalk.gray('  No agent config detected, defaulting to Claude Code'));
    } else {
      console.log(chalk.gray(`  Detected: ${agentsToEnable.map((a) => AGENTS[a].name).join(', ')}`));
    }
  }

  // Install hooks for each agent
  for (const agentType of agentsToEnable) {
    const agent = AGENTS[agentType];
    console.log(chalk.cyan(`\n  ${agent.name}:`));
    agent.installHooks(gitRoot);
    console.log(chalk.gray('    • Session start/end — lifecycle tracking'));
    console.log(chalk.gray('    • Prompt capture — real user prompts'));
    console.log(chalk.gray('    • Turn end — files, tokens, tool calls'));
  }

  console.log(chalk.bold('\n📋 Next steps:\n'));
  const firstAgent = AGENTS[agentsToEnable[0]];
  console.log(chalk.white('  1. Start coding: ') + chalk.cyan(firstAgent.command));
  console.log(chalk.white('  2. Work normally — Origin captures everything automatically'));
  console.log(chalk.white('  3. View sessions: ') + chalk.cyan('origin sessions'));
  console.log(chalk.white('  4. Or check the dashboard: ') + chalk.cyan(config.apiUrl));

  console.log(chalk.green('\n✓ Origin session tracking enabled.\n'));
}
