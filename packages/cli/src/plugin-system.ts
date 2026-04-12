import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PluginConfig {
  name: string;
  command: string;
  events: string[];
  description?: string;
  installedAt?: string;
}

export interface PluginRequest {
  event: string;
  data: Record<string, any>;
  timestamp: string;
}

export interface PluginResponse {
  status: 'ok' | 'error' | 'skip';
  data?: Record<string, any>;
  error?: string;
}

interface PluginRegistry {
  version: number;
  plugins: PluginConfig[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const PLUGINS_PATH = path.join(os.homedir(), '.origin', 'plugins.json');
const PLUGIN_TIMEOUT_MS = 30_000; // 30 seconds per plugin call

/** Environment variable names that must be stripped before executing plugins. */
const SENSITIVE_ENV_VARS = [
  'ORIGIN_API_KEY',
  'API_KEY',
  'SECRET_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NPM_TOKEN',
  'DOCKER_PASSWORD',
];

// ─── Plugin Registry ───────────────────────────────────────────────────────

/**
 * Load all registered plugins from ~/.origin/plugins.json.
 */
export function loadPlugins(): PluginConfig[] {
  try {
    const registry = loadRegistry();
    return registry.plugins;
  } catch {
    return [];
  }
}

/**
 * Register a new plugin.
 *
 * @param name - Unique plugin name
 * @param command - Command to execute (e.g., "node /path/to/plugin.js" or "my-plugin")
 * @param events - List of events to subscribe to (e.g., ["session-start", "post-commit"])
 */
export function registerPlugin(
  name: string,
  command: string,
  events: string[],
  description?: string,
): { success: boolean; message: string } {
  const registry = loadRegistry();

  // Check for duplicate name
  const existing = registry.plugins.findIndex(p => p.name === name);
  if (existing >= 0) {
    return {
      success: false,
      message: `Plugin "${name}" is already registered. Remove it first with: origin plugin remove ${name}`,
    };
  }

  // Validate the command is accessible
  if (!isCommandAccessible(command)) {
    return {
      success: false,
      message: `Command "${command}" is not accessible. Make sure it's installed and in your PATH.`,
    };
  }

  const plugin: PluginConfig = {
    name,
    command,
    events,
    description,
    installedAt: new Date().toISOString(),
  };

  registry.plugins.push(plugin);
  saveRegistry(registry);

  return {
    success: true,
    message: `Plugin "${name}" registered for events: ${events.join(', ')}`,
  };
}

/**
 * Remove a plugin by name.
 */
export function removePlugin(name: string): { success: boolean; message: string } {
  const registry = loadRegistry();
  const index = registry.plugins.findIndex(p => p.name === name);

  if (index < 0) {
    return { success: false, message: `Plugin "${name}" is not registered.` };
  }

  registry.plugins.splice(index, 1);
  saveRegistry(registry);

  return { success: true, message: `Plugin "${name}" removed.` };
}

/**
 * Execute a plugin for a specific event.
 * Uses JSON-over-stdio protocol: writes event JSON to stdin, reads response from stdout.
 *
 * @param plugin - Plugin configuration
 * @param event - Event name
 * @param data - Event data to send to the plugin
 * @returns Plugin response or null if execution failed
 */
export function executePlugin(
  plugin: PluginConfig,
  event: string,
  data: Record<string, any>,
): Promise<PluginResponse | null> {
  return new Promise((resolve) => {
    const request: PluginRequest = {
      event,
      data,
      timestamp: new Date().toISOString(),
    };

    const requestJson = JSON.stringify(request);

    try {
      // Warn about plugin access
      console.warn(`\u26a0\ufe0f Loading plugin: ${plugin.name} — plugins have access to your filesystem`);
      debugLog(`Executing plugin "${plugin.name}" for event "${event}"`);

      // Build a sanitized environment, stripping sensitive keys
      const sanitizedEnv: Record<string, string | undefined> = { ...process.env };
      for (const key of SENSITIVE_ENV_VARS) {
        delete sanitizedEnv[key];
      }

      // Split command into parts for spawn
      const parts = plugin.command.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: PLUGIN_TIMEOUT_MS,
        env: {
          ...sanitizedEnv,
          ORIGIN_PLUGIN_EVENT: event,
          ORIGIN_PLUGIN_NAME: plugin.name,
        },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        debugLog(`Plugin "${plugin.name}" spawn error: ${err.message}`);
        resolve(null);
      });

      child.on('close', (code) => {
        if (code !== 0) {
          debugLog(`Plugin "${plugin.name}" exited with code ${code}: ${stderr}`);
          resolve({ status: 'error', error: stderr || `Exit code ${code}` });
          return;
        }

        try {
          const response = JSON.parse(stdout.trim());
          resolve(response as PluginResponse);
        } catch {
          // If stdout is not valid JSON, treat as ok with raw output
          resolve({ status: 'ok', data: { output: stdout.trim() } });
        }
      });

      // Set up timeout
      const timer = setTimeout(() => {
        debugLog(`Plugin "${plugin.name}" timed out after ${PLUGIN_TIMEOUT_MS}ms`);
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        resolve({ status: 'error', error: `Timed out after ${PLUGIN_TIMEOUT_MS}ms` });
      }, PLUGIN_TIMEOUT_MS);

      child.on('close', () => clearTimeout(timer));

      // Write request to stdin
      child.stdin.write(requestJson);
      child.stdin.end();
    } catch (err: any) {
      debugLog(`Plugin "${plugin.name}" execution error: ${err.message}`);
      resolve(null);
    }
  });
}

/**
 * Execute all plugins subscribed to a specific event.
 * Runs plugins sequentially to avoid conflicts.
 *
 * @param event - Event name
 * @param data - Event data
 * @returns Array of results (plugin name + response)
 */
export async function executePluginsForEvent(
  event: string,
  data: Record<string, any>,
): Promise<Array<{ plugin: string; response: PluginResponse | null }>> {
  const plugins = loadPlugins();
  const results: Array<{ plugin: string; response: PluginResponse | null }> = [];

  for (const plugin of plugins) {
    // Only execute if the plugin is subscribed to this event
    if (!plugin.events.includes(event) && !plugin.events.includes('*')) {
      continue;
    }

    const response = await executePlugin(plugin, event, data);
    results.push({ plugin: plugin.name, response });
  }

  return results;
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

/**
 * Load the plugin registry from disk.
 */
function loadRegistry(): PluginRegistry {
  try {
    if (fs.existsSync(PLUGINS_PATH)) {
      return JSON.parse(fs.readFileSync(PLUGINS_PATH, 'utf-8'));
    }
  } catch { /* corrupt file */ }

  return { version: 1, plugins: [] };
}

/**
 * Save the plugin registry to disk.
 */
function saveRegistry(registry: PluginRegistry): void {
  const dir = path.dirname(PLUGINS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PLUGINS_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Check if a command is accessible (exists in PATH or is an absolute path).
 */
function isCommandAccessible(command: string): boolean {
  const parts = command.split(/\s+/);
  const cmd = parts[0];

  // Absolute path
  if (path.isAbsolute(cmd)) {
    return fs.existsSync(cmd);
  }

  // Check PATH
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a debug log entry.
 * Rotates the log file when it exceeds 5 MB.
 */
function debugLog(message: string): void {
  try {
    const logPath = path.join(os.homedir(), '.origin', 'hooks.log');
    try {
      const stats = fs.statSync(logPath);
      if (stats.size >= 5 * 1024 * 1024) {
        fs.renameSync(logPath, logPath + '.old');
      }
    } catch { /* file may not exist yet */ }
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] [plugin-system] ${message}\n`);
  } catch {
    // Never fail on logging
  }
}
