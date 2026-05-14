import { displayAgentName } from '../../utils';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  model: string;
  agentName: string | null;
  repoName: string | null;
  branch: string | null;
  durationMs: number;
  costUsd: number;
  tokensUsed: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  review: { status: string; score: number | null } | null;
  bookmark?: { id: string; tags: string[]; note: string };
  mergedFrom: string[] | null;
  mergedInto: string | null;
  parentSessionId: string | null;
  // Federated personal view chip — populated by /api/me/sessions so the
  // row renderer can show "Brigada LTD" alongside the repo name. Null for
  // org-scoped sessions returned by the legacy /api/sessions path.
  org?: { id: string; name: string } | null;
}

export interface MyStats {
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalToolCalls: number;
  thisWeek: { sessions: number; cost: number; tokens: number };
  lastWeek: { sessions: number; cost: number; tokens: number };
  agentBreakdown: Array<{ agentId: string | null; agentName: string; sessions: number; cost: number; tokens: number; linesAdded: number; linesRemoved: number }>;
  modelBreakdown: Array<{ model: string; sessions: number; cost: number }>;
  topFiles: Array<{ file: string; count: number; repoId?: string | null }>;
  sessionsByRepo: Array<{ repoId: string; repoName: string; sessions: number }>;
  heatmap: Record<string, number>;
  streak: number;
}

export interface AgentCard {
  agentId: string | null;
  agentName: string;
  model: string;
  totalSessions: number;
  totalCost: number;
  totalTokens: number;
  costThisMonth: number;
  sessionsThisMonth: number;
  lastActive: string | null;
  status: 'active' | 'inactive';
  avgSessionDuration: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface CodingPatterns {
  hourly: number[];
  daily: number[];
  avgSessionDuration: number;
  avgTokensPerSession: number;
  avgCostPerSession: number;
  peakHour: number;
  peakDay: string;
  sessionsThisMonth: number;
  costThisMonth: number;
}

export interface Efficiency {
  tokensPerLine: number;
  costPerCommit: number;
  costPerSession: number;
  avgLinesPerSession: number;
  cacheTokens: { read: number; created: number };
  toolCallBreakdown: Array<{ tool: string; count: number }>;
  commitStats: {
    totalCommits: number;
    commitsPerSession: number;
    avgFilesPerCommit: number;
  };
}

export interface PromptEntry {
  sessionId: string;
  agentName: string | null;
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  diff: string;
  createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────


export function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function fmtDuration(ms: number) {
  if (!ms) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtCost(n: number) {
  return `$${n.toFixed(2)}`;
}

export function timeAgo(date: string) {
  const ms = Date.now() - new Date(date).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(date).toLocaleDateString();
}

export function dayLabel(date: string) {
  const d = new Date(date);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

// Agent color map — consistent colors per agent name. Match against the
// lowercased name — order matters: longer keys first (e.g. "claude code"
// before "claude") so the right entry wins.
const AGENT_COLORS: Array<[string, string]> = [
  ['claude code', '#a78bfa'], // lavender/purple
  ['claude', '#a78bfa'],
  ['cursor', '#38bdf8'],      // sky blue
  ['gemini', '#fbbf24'],      // amber
  ['codex', '#34d399'],       // emerald
  ['copilot', '#f472b6'],     // pink
  ['gpt', '#34d399'],         // OpenAI fallback → emerald (same as Codex)
  ['aider', '#fb7185'],       // rose
];
export function agentColor(name: string | null) {
  if (!name) return '#6b7280';
  const lower = name.toLowerCase();
  for (const [key, color] of AGENT_COLORS) {
    if (lower.includes(key)) return color;
  }
  return '#8b5cf6';
}

// ── Session summary builder ─────────────────────────────────────────────────

export function buildSessionSummary(s: Session): string {
  const agent = displayAgentName(s.agentName) || s.model.split('/').pop()?.split('-').slice(0, 2).join('-') || 'AI';
  let files: string[] = [];
  try { files = JSON.parse(s.filesChanged); } catch { /* ignore */ }

  const parts: string[] = [];

  // What happened
  if (s.linesAdded > 0 && s.linesRemoved > 0) {
    parts.push(`${agent} added ${s.linesAdded} and removed ${s.linesRemoved} lines`);
  } else if (s.linesAdded > 0) {
    parts.push(`${agent} wrote ${s.linesAdded} line${s.linesAdded !== 1 ? 's' : ''} of code`);
  } else if (files.length > 0) {
    parts.push(`${agent} worked on ${files.length} file${files.length !== 1 ? 's' : ''}`);
  } else {
    parts.push(`${agent} coding session`);
  }

  // Where
  if (s.repoName) parts.push(`in ${s.repoName}`);
  if (s.branch) parts.push(`on branch ${s.branch}`);

  // Files detail
  if (files.length > 0) {
    const shortFiles = files.slice(0, 3).map(f => f.split('/').pop());
    const detail = shortFiles.join(', ') + (files.length > 3 ? ` +${files.length - 3} more` : '');
    parts.push(`— files: ${detail}`);
  }

  // Duration
  if (s.durationMs > 0) {
    const mins = Math.round(s.durationMs / 60000);
    if (mins > 0) parts.push(`(${mins} min)`);
  }

  return parts.join(' ');
}
