import chalk from 'chalk';
import { loadConfig, saveConfig, type OriginConfig } from '../config.js';

/**
 * origin config get <key>
 * origin config set <key> <value>
 *
 * Validates keys against OriginConfig interface. Persists to ~/.origin/config.json.
 *
 * Supports dotted keys for nested maps:
 *   origin config set agentSlugs.cursor cursor-frontend
 *   origin config get agentSlugs.cursor
 *   origin config get agentSlugs          → shows all overrides
 */

// Map kebab-case aliases to camelCase config keys
const KEY_ALIASES: Record<string, string> = {
  'checkpoint-repo': 'checkpointRepo',
  'commit-linking': 'commitLinking',
  'push-strategy': 'pushStrategy',
  'auto-update': 'autoUpdate',
  'secret-redaction': 'secretRedaction',
  'secret-scan': 'secretScan',
  'hook-chaining': 'hookChaining',
  'api-url': 'apiUrl',
  'api-key': 'apiKey',
  'org-id': 'orgId',
  'user-id': 'userId',
  'machine-id': 'machineId',
  'agent-slugs': 'agentSlugs',
};

function resolveKey(key: string): string {
  return KEY_ALIASES[key] || key;
}

// Valid config keys and their types/allowed values
const CONFIG_KEYS: Record<string, { type: 'string' | 'boolean' | 'enum' | 'map'; values?: string[]; description: string }> = {
  apiUrl:          { type: 'string',  description: 'Origin API URL' },
  apiKey:          { type: 'string',  description: 'API key (use "origin login" instead)' },
  orgId:           { type: 'string',  description: 'Organization ID' },
  userId:          { type: 'string',  description: 'User ID' },
  machineId:       { type: 'string',  description: 'Machine identifier' },
  commitLinking:   { type: 'enum',    values: ['always', 'prompt', 'never'], description: 'When to add Origin-Session trailers to commits' },
  pushStrategy:    { type: 'enum',    values: ['auto', 'prompt', 'false'], description: 'When to push origin-sessions branch' },
  telemetry:       { type: 'boolean', description: 'Enable anonymous telemetry (opt-in)' },
  autoUpdate:      { type: 'boolean', description: 'Check for CLI updates on startup' },
  secretRedaction: { type: 'boolean', description: 'Redact secrets before sending to API' },
  hookChaining:    { type: 'boolean', description: 'Chain existing hooks when installing Origin hooks' },
  checkpointRepo:  { type: 'string',  description: 'External git remote URL for session data (origin-sessions branch)' },
  mode:            { type: 'enum',    values: ['auto', 'standalone'], description: 'Force standalone mode (skip API even when logged in)' },
  agentSlugs:      { type: 'map',     description: 'Per-tool agent slug overrides (e.g. agentSlugs.cursor = cursor-frontend)' },
};

// ── Helpers for dotted key access (agentSlugs.cursor) ────────────────────────

function isDottedAgentSlugKey(rawKey: string): boolean {
  const parts = rawKey.replace('agent-slugs', 'agentSlugs').split('.');
  return parts[0] === 'agentSlugs' && parts.length === 2;
}

function parseDottedKey(rawKey: string): { tool: string } | null {
  const parts = rawKey.replace('agent-slugs', 'agentSlugs').split('.');
  if (parts[0] === 'agentSlugs' && parts.length === 2 && parts[1]) {
    return { tool: parts[1] };
  }
  return null;
}

export async function configGetCommand(rawKey: string): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.yellow('Not configured. Run: origin login'));
    process.exit(1);
  }

  // Handle dotted key: agentSlugs.cursor
  const dotted = parseDottedKey(rawKey);
  if (dotted) {
    const slug = config.agentSlugs?.[dotted.tool];
    if (slug) {
      console.log(slug);
    } else {
      console.log(chalk.gray('(not set)'));
    }
    return;
  }

  // Handle whole agentSlugs map
  const key = resolveKey(rawKey);
  if (key === 'agentSlugs') {
    const slugs = config.agentSlugs;
    if (!slugs || Object.keys(slugs).length === 0) {
      console.log(chalk.gray('(no agent slug overrides)'));
    } else {
      for (const [tool, slug] of Object.entries(slugs)) {
        console.log(`  ${chalk.cyan(tool.padEnd(16))} → ${slug}`);
      }
    }
    return;
  }

  if (!CONFIG_KEYS[key]) {
    console.log(chalk.red(`Unknown config key: ${key}`));
    console.log(chalk.gray(`Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`));
    console.log(chalk.gray('  Use agentSlugs.<tool> for per-tool slug overrides'));
    process.exit(1);
  }

  const value = (config as Record<string, any>)[key];
  if (value === undefined || value === null) {
    console.log(chalk.gray('(not set)'));
  } else {
    console.log(String(value));
  }
}

export async function configSetCommand(rawKey: string, value: string): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.yellow('Not configured. Run: origin login'));
    process.exit(1);
  }

  // Handle dotted key: agentSlugs.cursor cursor-frontend
  const dotted = parseDottedKey(rawKey);
  if (dotted) {
    if (!config.agentSlugs) config.agentSlugs = {};
    if (value === '' || value === 'unset' || value === 'default') {
      delete config.agentSlugs[dotted.tool];
      if (Object.keys(config.agentSlugs).length === 0) delete config.agentSlugs;
      saveConfig(config);
      console.log(chalk.green(`agentSlugs.${dotted.tool} removed (will use default slug)`));
    } else {
      config.agentSlugs[dotted.tool] = value;
      saveConfig(config);
      console.log(chalk.green(`agentSlugs.${dotted.tool} = ${value}`));
    }
    return;
  }

  const key = resolveKey(rawKey);
  const keySpec = CONFIG_KEYS[key];
  if (!keySpec) {
    console.log(chalk.red(`Unknown config key: ${key}`));
    console.log(chalk.gray(`Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`));
    console.log(chalk.gray('  Use agentSlugs.<tool> for per-tool slug overrides'));
    process.exit(1);
  }

  if (keySpec.type === 'map') {
    console.log(chalk.yellow(`Use dotted syntax: origin config set ${key}.<tool> <slug>`));
    console.log(chalk.gray(`  Example: origin config set agentSlugs.cursor cursor-frontend`));
    process.exit(1);
  }

  // Validate value
  let parsed: any = value;

  if (keySpec.type === 'boolean') {
    if (value === 'true' || value === '1' || value === 'yes') {
      parsed = true;
    } else if (value === 'false' || value === '0' || value === 'no') {
      parsed = false;
    } else {
      console.log(chalk.red(`Invalid value for ${key}: expected true/false`));
      process.exit(1);
    }
  } else if (keySpec.type === 'enum' && keySpec.values) {
    if (!keySpec.values.includes(value)) {
      console.log(chalk.red(`Invalid value for ${key}: must be one of ${keySpec.values.join(', ')}`));
      process.exit(1);
    }
  }

  (config as Record<string, any>)[key] = parsed;
  saveConfig(config);
  console.log(chalk.green(`${key} = ${parsed}`));
}

export async function configListCommand(): Promise<void> {
  const config = loadConfig();

  console.log(chalk.bold('\n  Origin Configuration\n'));

  for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    if (spec.type === 'map') {
      // Show map entries
      const map = config ? (config as Record<string, any>)[key] : undefined;
      if (map && typeof map === 'object' && Object.keys(map).length > 0) {
        console.log(`  ${chalk.cyan(key.padEnd(18))} ${chalk.gray('[map]')}`);
        console.log(chalk.gray(`  ${''.padEnd(18)} ${spec.description}`));
        for (const [subKey, subVal] of Object.entries(map)) {
          console.log(`    ${chalk.cyan(('.' + subKey).padEnd(16))} ${String(subVal)}`);
        }
      } else {
        console.log(`  ${chalk.cyan(key.padEnd(18))} ${chalk.gray('(no overrides)').padEnd(30)} ${chalk.gray('[map]')}`);
        console.log(chalk.gray(`  ${''.padEnd(18)} ${spec.description}`));
      }
      continue;
    }

    const value = config ? (config as Record<string, any>)[key] : undefined;
    const displayValue = value !== undefined && value !== null ? String(value) : chalk.gray('(not set)');
    const typeHint = spec.type === 'enum' ? chalk.gray(`[${spec.values!.join('|')}]`) : chalk.gray(`[${spec.type}]`);
    console.log(`  ${chalk.cyan(key.padEnd(18))} ${displayValue.padEnd(30)} ${typeHint}`);
    console.log(chalk.gray(`  ${''.padEnd(18)} ${spec.description}`));
  }
  console.log('');
}
