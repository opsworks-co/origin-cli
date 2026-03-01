import { loadConfig } from './config.js';

export async function originRequest(path: string, opts: RequestInit = {}) {
  const config = loadConfig();
  if (!config) throw new Error('Origin not configured. Run: origin login && origin init');

  const res = await fetch(`${config.apiUrl}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
      ...(opts.headers as Record<string, string> || {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchPolicies() {
  return originRequest('/api/mcp/policies');
}

export async function startSession(data: { machineId: string; prompt: string; model: string; repoPath: string }) {
  return originRequest('/api/mcp/session/start', { method: 'POST', body: JSON.stringify(data) });
}

export async function endSession(data: { sessionId: string; summary: string; tokensUsed: number; toolCalls: number; linesAdded?: number; linesRemoved?: number; costUsd?: number; filesChanged?: string; durationMs?: number }) {
  return originRequest('/api/mcp/session/end', { method: 'POST', body: JSON.stringify(data) });
}

export async function reportViolation(data: { machineId: string; policyId: string; description: string; filepath: string }) {
  return originRequest('/api/mcp/violations', { method: 'POST', body: JSON.stringify(data) });
}
