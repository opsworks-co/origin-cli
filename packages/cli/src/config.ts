import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.origin');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const AGENT_PATH = path.join(CONFIG_DIR, 'agent.json');

export interface OriginConfig {
  apiUrl: string;
  apiKey: string;
  orgId: string;
  userId: string;
  machineId?: string;
  // Feature flags
  commitLinking?: 'always' | 'prompt' | 'never';
  pushStrategy?: 'auto' | 'prompt' | 'false' | 'always';
  telemetry?: boolean;
  autoUpdate?: boolean;
  secretRedaction?: boolean;
  secretScan?: boolean;        // Pre-commit secret scanning (default: true)
  hookChaining?: boolean;
  mode?: 'standalone' | 'auto'; // Force standalone even when logged in
  checkpointRepo?: string; // External git remote URL for origin-sessions branch
  autoSnapshot?: boolean;  // Auto-save snapshots before agent file edits (default: false)
  agentSlugs?: Record<string, string>; // Per-tool agent slug overrides (e.g. { cursor: 'cursor-frontend' })
}

export interface AgentConfig {
  machineId: string;
  hostname: string;
  detectedTools: string[];
  orgId: string;
  lastToolDetection?: string; // ISO timestamp of last tool scan
  agentSlug?: string; // Default agent slug (selected during init)
}

export function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

let _configCache: { data: OriginConfig | null; ts: number } = { data: null, ts: 0 };
const CONFIG_CACHE_TTL = 5000;

export function loadConfig(): OriginConfig | null {
  const now = Date.now();
  if (_configCache.data && (now - _configCache.ts) < CONFIG_CACHE_TTL) {
    return _configCache.data;
  }
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    _configCache = { data: config, ts: now };
    return config;
  } catch {
    return null;
  }
}

export function clearConfigCache(): void {
  _configCache = { data: null, ts: 0 };
}

export function saveConfig(config: OriginConfig) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  clearConfigCache();
}

export function loadAgentConfig(): AgentConfig | null {
  try { return JSON.parse(fs.readFileSync(AGENT_PATH, 'utf-8')); } catch { return null; }
}

export function saveAgentConfig(config: AgentConfig) {
  ensureConfigDir();
  fs.writeFileSync(AGENT_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── Per-repo config (.origin.json in repo root) ─────────────────────────────

export interface RepoConfig {
  agent?: string;  // Origin agent slug to link sessions to
  ignorePatterns?: string[];
  trackTabCompletions?: boolean;
  secretScan?: boolean;  // Pre-commit secret scanning (default: true)
}

export function loadRepoConfig(repoPath: string): RepoConfig | null {
  try {
    const configPath = path.join(repoPath, '.origin.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch { return null; }
}

export function saveRepoConfig(repoPath: string, config: RepoConfig) {
  fs.writeFileSync(path.join(repoPath, '.origin.json'), JSON.stringify(config, null, 2) + '\n');
}

export function clearRepoConfig(repoPath: string) {
  const configPath = path.join(repoPath, '.origin.json');
  try { fs.unlinkSync(configPath); } catch { /* ignore */ }
}

// ── Mode detection ────────────────────────────────────────────────────────────

/**
 * Returns true if CLI is connected to the Origin platform (has API key configured).
 * When false, CLI operates in standalone/local-only mode.
 */
export function isConnectedMode(): boolean {
  const config = loadConfig();
  if (config?.mode === 'standalone') return false;
  return !!(config?.apiKey);
}

/**
 * Guard for commands that require the Origin platform.
 * Returns false (and prints message) if in standalone mode.
 */
export function requirePlatform(commandName: string): boolean {
  if (!isConnectedMode()) {
    console.log(`\n  'origin ${commandName}' requires the Origin platform.`);
    console.log('  Run: origin login\n');
    return false;
  }
  return true;
}
