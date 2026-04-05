import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.origin');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const AGENT_PATH = path.join(CONFIG_DIR, 'agent.json');
const PROFILES_DIR = path.join(CONFIG_DIR, 'profiles');

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
  keyType?: 'solo' | 'team';       // solo = personal dev key, team = org-managed key
  accountType?: 'developer' | 'org'; // Account type of the key owner
  orgName?: string;                 // Organization name for display
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

export function loadConfig(): OriginConfig | null {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return null; }
}

export function saveConfig(config: OriginConfig) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
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

// ── Multi-account profiles ───────────────────────────────────────────────────

export interface Profile {
  name: string;
  apiUrl: string;
  apiKey: string;
  orgId: string;
  orgName: string;
  keyType: 'solo' | 'team';
  accountType: 'developer' | 'org';
}

function ensureProfilesDir() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

/** Save a named profile (e.g. "dev", "team") */
export function saveProfile(name: string, profile: Profile) {
  ensureProfilesDir();
  fs.writeFileSync(path.join(PROFILES_DIR, `${name}.json`), JSON.stringify(profile, null, 2), { mode: 0o600 });
}

/** Load a specific profile by name */
export function loadProfile(name: string): Profile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, `${name}.json`), 'utf-8'));
  } catch { return null; }
}

/** Delete a profile */
export function deleteProfile(name: string) {
  try { fs.unlinkSync(path.join(PROFILES_DIR, `${name}.json`)); } catch { /* ignore */ }
}

/** Read profile files from disk (no migration) */
function readProfiles(): Profile[] {
  ensureProfilesDir();
  try {
    return fs.readdirSync(PROFILES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf-8')); } catch { return null; }
      })
      .filter(Boolean) as Profile[];
  } catch { return []; }
}

/**
 * Ensure the current primary config is saved as a profile.
 * Auto-migrates configs created before multi-account was added.
 */
function ensurePrimaryProfile(): void {
  const config = loadConfig();
  if (!config?.apiKey) return;

  const existing = readProfiles();
  if (existing.some(p => p.apiKey === config.apiKey)) return;

  const isSolo = config.keyType === 'solo' || config.accountType === 'developer';
  const name = isSolo ? 'dev' : 'team';

  saveProfile(name, {
    name,
    apiUrl: config.apiUrl || 'https://getorigin.io',
    apiKey: config.apiKey,
    orgId: config.orgId || '',
    orgName: config.orgName || '',
    keyType: config.keyType || 'team',
    accountType: config.accountType || 'org',
  });
}

/** List all saved profiles (auto-migrates primary config if needed) */
export function listProfiles(): Profile[] {
  ensurePrimaryProfile();
  return readProfiles();
}

/**
 * Load all profiles EXCEPT the one matching the primary config.
 * Used as fallback targets when primary key rejects a session (e.g. repo not in scope).
 */
export function loadSecondaryProfiles(): Profile[] {
  const primary = loadConfig();
  if (!primary?.apiKey) return [];
  return listProfiles().filter(p => p.apiKey !== primary.apiKey);
}

/** Load a specific profile by key match (for routed sessions) */
export function loadProfileByName(name: string): Profile | null {
  return loadProfile(name);
}
