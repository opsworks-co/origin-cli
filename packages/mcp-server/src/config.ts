import fs from 'fs';
import path from 'path';
import os from 'os';

export interface OriginConfig {
  apiUrl: string;
  apiKey: string;
  orgId: string;
  machineId?: string;
}

export function loadConfig(): OriginConfig | null {
  // Prefer environment variables (documented in README for MCP server usage)
  if (process.env.ORIGIN_API_URL && process.env.ORIGIN_API_KEY) {
    return {
      apiUrl: process.env.ORIGIN_API_URL,
      apiKey: process.env.ORIGIN_API_KEY,
      orgId: process.env.ORIGIN_ORG_ID || '',
    };
  }
  // Fall back to config file
  try {
    const configPath = path.join(os.homedir(), '.origin', 'config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch { return null; }
}

export function loadAgentConfig(): { machineId: string } | null {
  try {
    const agentPath = path.join(os.homedir(), '.origin', 'agent.json');
    return JSON.parse(fs.readFileSync(agentPath, 'utf-8'));
  } catch { return null; }
}
