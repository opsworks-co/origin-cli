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
  pushStrategy?: 'auto' | 'prompt' | 'false';
  telemetry?: boolean;
  autoUpdate?: boolean;
  secretRedaction?: boolean;
  hookChaining?: boolean;
}

export interface AgentConfig {
  machineId: string;
  hostname: string;
  detectedTools: string[];
  orgId: string;
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
  fs.writeFileSync(AGENT_PATH, JSON.stringify(config, null, 2));
}

// ── Per-repo config (.origin.json in repo root) ─────────────────────────────

export interface RepoConfig {
  agent?: string;  // Origin agent slug to link sessions to
  ignorePatterns?: string[];
  trackTabCompletions?: boolean;
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
