import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

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
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } else {
    // Tighten existing dir — older releases may have created it with 0755.
    // Best-effort: ignore chmod errors on platforms where it's a no-op.
    try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* ignore */ }
  }
}

/**
 * Write a file atomically with restrictive permissions (0600).
 *
 * Why not just pass `{ mode: 0o600 }` to writeFileSync? Because Node only
 * honors the mode option when *creating* a new file. If the file already
 * exists (from an older release or a buggy install) with 0644, the option
 * is silently ignored and credentials sit on disk world-readable.
 *
 * This helper writes to a sibling temp file, chmods it to 0600, then
 * renames over the target. The chmod is unconditional so existing files
 * get their permissions fixed on the next save.
 */
function writeSecret(filePath: string, data: string): void {
  // Temp name must be unique per call — not just per-process. Two concurrent
  // Node processes could share a PID namespace (containers, forks), and even
  // within one process, parallel saveConfig/saveAgentConfig calls would
  // otherwise race on the same tmp path and corrupt each other's writes.
  // 8 random bytes (64 bits) is plenty of entropy to make collisions
  // astronomically unlikely for this local-file use case.
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* ignore */ }
    fs.renameSync(tmp, filePath);
    // Belt-and-suspenders: chmod the final path too, in case rename preserved
    // an older inode's mode on some filesystems.
    try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
  } catch (err) {
    // If rename failed after successful write, clean up the orphan tmp file
    // so `~/.origin/` doesn't accumulate stale writes on repeated failures.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// Distinguish "file does not exist" (first run / logged out) from
// "file exists but failed to parse" (corrupted by a crash mid-write).
// The old `catch { return null }` silently degraded a corrupted config
// into a logged-out state, which is confusing — the user sees their
// sessions stop uploading without any warning. Log the parse error so
// the next command surfaces the cause.
function loadJsonFileOrNull<T>(filePath: string, label: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return null;
    console.error(`[origin] warning: failed to read ${label} at ${filePath}:`, err?.message || err);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err: any) {
    console.error(`[origin] warning: ${label} at ${filePath} is corrupted and could not be parsed:`, err?.message || err);
    return null;
  }
}

// In-memory cache to avoid re-reading disk on every loadConfig() call.
// Hooks can call loadConfig() dozens of times per invocation.
let _configCache: { data: OriginConfig | null; ts: number } = { data: null, ts: 0 };
const CONFIG_CACHE_TTL = 5000; // 5 seconds

export function loadConfig(): OriginConfig | null {
  const now = Date.now();
  if (_configCache.data && (now - _configCache.ts) < CONFIG_CACHE_TTL) {
    return _configCache.data;
  }
  const config = loadJsonFileOrNull<OriginConfig>(CONFIG_PATH, 'config');
  _configCache = { data: config, ts: now };
  return config;
}

export function clearConfigCache(): void {
  _configCache = { data: null, ts: 0 };
}

export function saveConfig(config: OriginConfig) {
  ensureConfigDir();
  writeSecret(CONFIG_PATH, JSON.stringify(config, null, 2));
  clearConfigCache();
}

export function loadAgentConfig(): AgentConfig | null {
  return loadJsonFileOrNull<AgentConfig>(AGENT_PATH, 'agent config');
}

export function saveAgentConfig(config: AgentConfig) {
  ensureConfigDir();
  writeSecret(AGENT_PATH, JSON.stringify(config, null, 2));
}

// ── Per-repo config (.origin.json in repo root) ─────────────────────────────

export interface RepoConfig {
  agent?: string;  // Origin agent slug to link sessions to
  ignorePatterns?: string[];
  trackTabCompletions?: boolean;
  secretScan?: boolean;  // Pre-commit secret scanning (default: true)
}

export function loadRepoConfig(repoPath: string): RepoConfig | null {
  const configPath = path.join(repoPath, '.origin.json');
  let raw: string;
  try { raw = fs.readFileSync(configPath, 'utf-8'); }
  catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    console.error(`[origin] warning: failed to read .origin.json at ${configPath}:`, err?.message || err);
    return null;
  }
  try { return JSON.parse(raw); }
  catch (err: any) {
    console.error(`[origin] warning: .origin.json at ${configPath} is corrupted:`, err?.message || err);
    return null;
  }
}

export function saveRepoConfig(repoPath: string, config: RepoConfig) {
  // Atomic write: temp file → rename, so concurrent `origin link` commands
  // or crashes mid-write never leave a half-written .origin.json.
  const target = path.join(repoPath, '.origin.json');
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
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
  if (!fs.existsSync(PROFILES_DIR)) {
    fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(PROFILES_DIR, 0o700); } catch { /* ignore */ }
  }
}

/** Save a named profile (e.g. "dev", "team") */
export function saveProfile(name: string, profile: Profile) {
  ensureProfilesDir();
  // Profiles contain API keys — use the same atomic 0600 writer as config.
  writeSecret(path.join(PROFILES_DIR, `${name}.json`), JSON.stringify(profile, null, 2));
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
