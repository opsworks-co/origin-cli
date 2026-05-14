// Shared utility functions used across multiple pages

export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Never';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const STATUS_BADGE_MAP: Record<string, string> = {
  approved: 'badge-green',
  rejected: 'badge-red',
  flagged: 'badge-amber',
  pending: 'badge-gray',
  completed: 'badge-blue',
  running: 'badge-purple',
  idle: 'badge-amber',
};

export function getStatusBadgeClass(status: string): string {
  return STATUS_BADGE_MAP[status.toLowerCase()] ?? 'badge-gray';
}

export function formatDuration(ms: number): string {
  ms = Math.round(ms);
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function parseJsonSafe<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

// Normalize agent label to its short form for display: "Claude Code" → "Claude",
// "Gemini CLI" → "Gemini", "Codex CLI" → "Codex", "Cursor" → "Cursor". Falls
// back to the raw value when the agent isn't one we recognize.
export function displayAgentName(name: string | null | undefined): string {
  if (!name) return '';
  const lower = name.toLowerCase();
  if (lower.includes('claude')) return 'Claude';
  if (lower.includes('gemini')) return 'Gemini';
  if (lower.includes('codex')) return 'Codex';
  if (lower.includes('cursor')) return 'Cursor';
  if (lower.includes('copilot')) return 'Copilot';
  if (lower.includes('aider')) return 'Aider';
  if (lower.includes('windsurf')) return 'Windsurf';
  return name;
}
