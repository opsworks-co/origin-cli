import chalk from 'chalk';
import { loadConfig, saveConfig, type OriginConfig } from '../config.js';

/**
 * origin config get <key>
 * origin config set <key> <value>
 *
 * Validates keys against OriginConfig interface. Persists to ~/.origin/config.json.
 */

// Valid config keys and their types/allowed values
const CONFIG_KEYS: Record<string, { type: 'string' | 'boolean' | 'enum'; values?: string[]; description: string }> = {
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
};

export async function configGetCommand(key: string): Promise<void> {
  if (!CONFIG_KEYS[key]) {
    console.log(chalk.red(`Unknown config key: ${key}`));
    console.log(chalk.gray(`Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`));
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.log(chalk.yellow('Not configured. Run: origin login'));
    process.exit(1);
  }

  const value = (config as Record<string, any>)[key];
  if (value === undefined || value === null) {
    console.log(chalk.gray('(not set)'));
  } else {
    console.log(String(value));
  }
}

export async function configSetCommand(key: string, value: string): Promise<void> {
  const keySpec = CONFIG_KEYS[key];
  if (!keySpec) {
    console.log(chalk.red(`Unknown config key: ${key}`));
    console.log(chalk.gray(`Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`));
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.log(chalk.yellow('Not configured. Run: origin login'));
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
    const value = config ? (config as Record<string, any>)[key] : undefined;
    const displayValue = value !== undefined && value !== null ? String(value) : chalk.gray('(not set)');
    const typeHint = spec.type === 'enum' ? chalk.gray(`[${spec.values!.join('|')}]`) : chalk.gray(`[${spec.type}]`);
    console.log(`  ${chalk.cyan(key.padEnd(18))} ${displayValue.padEnd(30)} ${typeHint}`);
    console.log(chalk.gray(`  ${''.padEnd(18)} ${spec.description}`));
  }
  console.log('');
}
