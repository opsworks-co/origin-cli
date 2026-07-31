// Agent execution keys for headless bake-off runs. The runner injects these
// into each agent subprocess (ANTHROPIC_API_KEY / OPENAI_API_KEY) so
// `claude -p` / `codex exec` authenticate by key instead of the interactive
// Keychain/OAuth login — which isn't reachable from a non-interactive shell
// (the "Invalid API key · Please run /login" failure).
//
// Resolution precedence, highest first:
//   1. process.env.ANTHROPIC_API_KEY / OPENAI_API_KEY   (a shell export)
//   2. ~/.origin/agent-keys.json                        (`origin benchmark key`)
//   3. the org's key stored in Origin (fetched via the API)
// So a LOCAL key always beats the server copy — the UI/server value is a
// convenience, never the only place a key can live.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { api } from './api.js';

export const AGENT_KEY_PROVIDERS = ['anthropic', 'openai'] as const;
export type AgentKeyProvider = (typeof AGENT_KEY_PROVIDERS)[number];

// Which env var each provider's key is exported as for the agent subprocess.
export const PROVIDER_ENV_VAR: Record<AgentKeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export type AgentKeys = Partial<Record<AgentKeyProvider, string>>;

const LOCAL_PATH = path.join(os.homedir(), '.origin', 'agent-keys.json');

export function isAgentKeyProvider(v: string): v is AgentKeyProvider {
  return (AGENT_KEY_PROVIDERS as readonly string[]).includes(v);
}

export function readLocalAgentKeys(): AgentKeys {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf-8'));
    const out: AgentKeys = {};
    for (const p of AGENT_KEY_PROVIDERS) if (typeof raw?.[p] === 'string' && raw[p]) out[p] = raw[p];
    return out;
  } catch {
    return {};
  }
}

export function setLocalAgentKey(provider: AgentKeyProvider, key: string): void {
  const cur = readLocalAgentKeys();
  cur[provider] = key;
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(cur, null, 2), { mode: 0o600 });
  try { fs.chmodSync(LOCAL_PATH, 0o600); } catch { /* best-effort */ }
}

export function clearLocalAgentKey(provider: AgentKeyProvider): void {
  const cur = readLocalAgentKeys();
  delete cur[provider];
  try {
    if (Object.keys(cur).length === 0) fs.unlinkSync(LOCAL_PATH);
    else fs.writeFileSync(LOCAL_PATH, JSON.stringify(cur, null, 2), { mode: 0o600 });
  } catch { /* already gone */ }
}

/**
 * Effective agent keys for injection, precedence env > local file > server.
 * env is not returned here (it's already in process.env and applied at spawn);
 * this merges the LOCAL file over the SERVER copy. Server fetch is best-effort —
 * offline / logged-out just yields the local keys.
 */
export async function resolveAgentKeys(): Promise<AgentKeys> {
  const local = readLocalAgentKeys();
  let server: AgentKeys = {};
  try {
    const res = await api.getAgentKeys() as { keys?: Record<string, string | null> };
    for (const p of AGENT_KEY_PROVIDERS) {
      const v = res?.keys?.[p];
      if (typeof v === 'string' && v) server[p] = v;
    }
  } catch {
    server = {};
  }
  return { ...server, ...local }; // local wins
}

/**
 * Build the env for an agent subprocess: process.env plus any resolved key the
 * env doesn't already carry (so a shell export still wins). `envVar` picks which
 * provider's key applies to this agent.
 */
export function agentEnvWithKey(envVar: string | undefined, keys: AgentKeys): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!envVar) return env;
  if (env[envVar]) return env; // shell export wins — don't override
  const provider = (Object.keys(PROVIDER_ENV_VAR) as AgentKeyProvider[]).find((p) => PROVIDER_ENV_VAR[p] === envVar);
  const key = provider ? keys[provider] : undefined;
  if (key) env[envVar] = key;
  return env;
}
