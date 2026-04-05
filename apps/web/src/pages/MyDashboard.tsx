import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { request } from '../api';
import {
  Play,
  Clock,
  DollarSign,
  Zap,
  TrendingUp,
  TrendingDown,
  Minus,
  Star,
  Search,
  Bookmark,
  Flame,
  Bot,
  Tag,
  X,
  Plus,
  GitBranch,
  FileCode,
  ArrowRight,
  Activity,
  Code2,
  BarChart3,
  Timer,
  Gauge,
  MessageSquare,
  GitCommit,
  FileText,
  Terminal,
  Download,
  Key,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

interface Session {
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
  status: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  review: { status: string; score: number | null } | null;
  bookmark?: { id: string; tags: string[]; note: string };
}

interface MyStats {
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalToolCalls: number;
  thisWeek: { sessions: number; cost: number; tokens: number };
  lastWeek: { sessions: number; cost: number; tokens: number };
  agentBreakdown: Array<{ agentId: string | null; agentName: string; sessions: number; cost: number }>;
  modelBreakdown: Array<{ model: string; sessions: number; cost: number }>;
  topFiles: Array<{ file: string; count: number }>;
  sessionsByRepo: Array<{ repoId: string; repoName: string; sessions: number }>;
  heatmap: Record<string, number>;
  streak: number;
}

interface AgentCard {
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

interface CodingPatterns {
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

interface Efficiency {
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

interface PromptEntry {
  sessionId: string;
  agentName: string | null;
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  diff: string;
  createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtDuration(ms: number) {
  if (!ms) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtCost(n: number) {
  return `$${n.toFixed(2)}`;
}

function timeAgo(date: string) {
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

function dayLabel(date: string) {
  const d = new Date(date);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

// Agent color map — consistent colors per agent name
const AGENT_COLORS: Record<string, string> = {
  'Claude Code': '#a78bfa',
  Claude: '#a78bfa',
  Cursor: '#60a5fa',
  Gemini: '#fbbf24',
  Codex: '#34d399',
  Copilot: '#818cf8',
};
function agentColor(name: string | null) {
  if (!name) return '#6b7280';
  for (const [key, color] of Object.entries(AGENT_COLORS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return '#8b5cf6';
}

function Trend({ current, previous }: { current: number; previous: number }) {
  const diff = previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;
  const up = diff > 0;
  const flat = diff === 0;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {flat ? (
        <Minus className="w-3 h-3 text-gray-500" />
      ) : up ? (
        <TrendingUp className="w-3 h-3 text-green-400" />
      ) : (
        <TrendingDown className="w-3 h-3 text-red-400" />
      )}
      <span className={flat ? 'text-gray-500' : up ? 'text-green-400' : 'text-red-400'}>
        {flat ? '—' : `${up ? '+' : ''}${diff.toFixed(0)}%`}
      </span>
      <span className="text-gray-600">vs last week</span>
    </div>
  );
}

// ── Heatmap component ───────────────────────────────────────────────────────

function ActivityHeatmap({ data }: { data: Record<string, number> }) {
  const today = new Date();
  const cells: Array<{ date: string; count: number; dayOfWeek: number }> = [];

  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    cells.push({ date: key, count: data[key] || 0, dayOfWeek: d.getDay() });
  }

  const weeks: typeof cells[] = [];
  let currentWeek: typeof cells = [];
  for (const cell of cells) {
    if (cell.dayOfWeek === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push(cell);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  const maxCount = Math.max(1, ...Object.values(data));

  function cellColor(count: number) {
    if (count === 0) return 'bg-gray-800/50';
    const intensity = count / maxCount;
    if (intensity < 0.25) return 'bg-indigo-900/60';
    if (intensity < 0.5) return 'bg-indigo-700/70';
    if (intensity < 0.75) return 'bg-indigo-600/80';
    return 'bg-indigo-500';
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-[3px] min-w-fit">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {wi === 0 && week[0]?.dayOfWeek > 0 &&
              Array.from({ length: week[0].dayOfWeek }).map((_, i) => (
                <div key={`pad-${i}`} className="w-[11px] h-[11px]" />
              ))
            }
            {week.map((cell) => (
              <div
                key={cell.date}
                className={`w-[11px] h-[11px] rounded-[2px] ${cellColor(cell.count)}`}
                title={`${cell.date}: ${cell.count} session${cell.count !== 1 ? 's' : ''}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5 mt-2 text-[10px] text-gray-500">
        <span>Less</span>
        <div className="w-[11px] h-[11px] rounded-[2px] bg-gray-800/50" />
        <div className="w-[11px] h-[11px] rounded-[2px] bg-indigo-900/60" />
        <div className="w-[11px] h-[11px] rounded-[2px] bg-indigo-700/70" />
        <div className="w-[11px] h-[11px] rounded-[2px] bg-indigo-600/80" />
        <div className="w-[11px] h-[11px] rounded-[2px] bg-indigo-500" />
        <span>More</span>
      </div>
    </div>
  );
}

// ── Agent pie chart ─────────────────────────────────────────────────────────

const COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

function AgentPie({ data }: { data: Array<{ agentName: string; sessions: number }> }) {
  const total = data.reduce((s, d) => s + d.sessions, 0);
  if (total === 0) return <div className="text-xs text-gray-600 text-center py-6">No sessions yet</div>;

  let cumAngle = 0;
  const slices = data.map((d, i) => {
    const angle = (d.sessions / total) * 360;
    const start = cumAngle;
    cumAngle += angle;
    return { ...d, start, angle, color: COLORS[i % COLORS.length] };
  });

  function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
  }

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 100 100" className="w-24 h-24 flex-shrink-0">
        {slices.length === 1 ? (
          <circle cx="50" cy="50" r="45" fill={slices[0].color} />
        ) : (
          slices.map((s, i) => (
            <path key={i} d={describeArc(50, 50, 45, s.start, s.start + s.angle)} fill={s.color} />
          ))
        )}
        <circle cx="50" cy="50" r="25" className="fill-gray-900" />
      </svg>
      <div className="space-y-1">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-gray-300">{s.agentName}</span>
            <span className="text-gray-600">{((s.sessions / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tag input component ─────────────────────────────────────────────────────

function TagEditor({
  tags,
  onSave,
}: {
  tags: string[];
  onSave: (tags: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [localTags, setLocalTags] = useState(tags);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setLocalTags(tags), [tags]);

  const addTag = () => {
    const t = draft.trim().toLowerCase();
    if (t && !localTags.includes(t)) {
      const next = [...localTags, t];
      setLocalTags(next);
      onSave(next);
    }
    setDraft('');
  };

  const removeTag = (tag: string) => {
    const next = localTags.filter((t) => t !== tag);
    setLocalTags(next);
    onSave(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {localTags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20"
        >
          {t}
          <button onClick={() => removeTag(t)} className="hover:text-red-400 ml-0.5">
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { addTag(); }
            if (e.key === 'Escape') { setEditing(false); setDraft(''); }
          }}
          onBlur={() => { if (draft.trim()) addTag(); setEditing(false); }}
          className="w-16 bg-transparent text-[10px] text-gray-300 outline-none border-b border-gray-600 px-0.5 py-0.5"
          placeholder="tag..."
          autoFocus
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="p-0.5 rounded hover:bg-gray-700 text-gray-600 hover:text-gray-400 transition-colors"
          title="Add tag"
        >
          <Plus className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ── Session Timeline ────────────────────────────────────────────────────────

function SessionTimeline({ sessions, navigate }: { sessions: Session[]; navigate: (path: string) => void }) {
  // Group sessions by day
  const groups = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const s of sessions) {
      const day = s.createdAt.split('T')[0];
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(s);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [sessions]);

  if (sessions.length === 0) {
    return <div className="text-sm text-gray-600 text-center py-12">No sessions to display</div>;
  }

  return (
    <div className="space-y-6">
      {groups.map(([day, daySessions]) => (
        <div key={day}>
          <div className="flex items-center gap-3 mb-3">
            <div className="text-xs font-semibold text-gray-400">{dayLabel(day)}</div>
            <div className="flex-1 border-t border-gray-800/50" />
            <span className="text-[10px] text-gray-600">{daySessions.length} session{daySessions.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="relative ml-4 pl-6 border-l-2 border-gray-800 space-y-3">
            {daySessions.map((s, i) => {
              const prevAgent = i > 0 ? daySessions[i - 1].agentName : null;
              const showSwitch = i > 0 && s.agentName !== prevAgent;
              const color = agentColor(s.agentName);

              return (
                <React.Fragment key={s.id}>
                  {showSwitch && (
                    <div className="flex items-center gap-2 -ml-[31px] py-1">
                      <div className="w-4 h-4 rounded-full bg-gray-800 border-2 border-gray-700 flex items-center justify-center">
                        <ArrowRight className="w-2 h-2 text-gray-500" />
                      </div>
                      <span className="text-[10px] text-gray-600 italic">
                        Switched from {prevAgent || 'Unknown'} to {s.agentName || 'Unknown'}
                      </span>
                    </div>
                  )}
                  <div
                    className="relative group cursor-pointer"
                    onClick={() => navigate(`/sessions/${s.id}`)}
                  >
                    {/* Timeline dot */}
                    <div
                      className="absolute -left-[31px] top-2 w-4 h-4 rounded-full border-2 flex items-center justify-center"
                      style={{ borderColor: color, backgroundColor: `${color}20` }}
                    >
                      {s.status === 'RUNNING' && (
                        <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
                      )}
                    </div>

                    <div className="bg-gray-900/50 border border-gray-800 hover:border-gray-700 rounded-lg px-4 py-3 transition-colors">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                            style={{ backgroundColor: `${color}20`, color }}
                          >
                            {s.agentName || s.model.split('/').pop()?.split('-').slice(0, 2).join('-')}
                          </span>
                          {s.repoName && (
                            <span className="text-xs text-gray-500 truncate">{s.repoName}</span>
                          )}
                          {s.branch && (
                            <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-gray-600 font-mono">
                              <GitBranch className="w-3 h-3" />
                              {s.branch}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-600 whitespace-nowrap flex-shrink-0">
                          {new Date(s.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-[10px] text-gray-500">
                        <span>{fmtDuration(s.durationMs)}</span>
                        <span>{fmtCost(s.costUsd)}</span>
                        <span>{fmt(s.tokensUsed)} tokens</span>
                        {(s.linesAdded > 0 || s.linesRemoved > 0) && (
                          <span>
                            <span className="text-green-500">+{s.linesAdded}</span>
                            {' / '}
                            <span className="text-red-400">-{s.linesRemoved}</span>
                          </span>
                        )}
                        {s.status === 'RUNNING' && (
                          <span className="text-green-400 font-medium">Running</span>
                        )}
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Agent Cards ─────────────────────────────────────────────────────────────

function AgentCards({ agents }: { agents: AgentCard[] }) {
  if (agents.length === 0) {
    return (
      <div className="text-sm text-gray-600 text-center py-12">
        No agents used yet. Start a coding session to see your agents here.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {agents.map((a) => {
        const color = agentColor(a.agentName);
        return (
          <div
            key={a.agentId || a.agentName}
            className="card hover:border-gray-700 transition-all"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: `${color}15`, border: `1px solid ${color}30` }}
                >
                  <Bot className="w-4 h-4" style={{ color }} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-200">{a.agentName}</div>
                  <div className="text-[10px] text-gray-600 font-mono">{a.model}</div>
                </div>
              </div>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  a.status === 'active'
                    ? 'bg-green-900/30 text-green-400'
                    : 'bg-gray-800 text-gray-500'
                }`}
              >
                {a.status}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div>
                <span className="text-gray-500">Total sessions</span>
                <div className="text-gray-200 font-medium">{a.totalSessions}</div>
              </div>
              <div>
                <span className="text-gray-500">This month</span>
                <div className="text-gray-200 font-medium">{a.sessionsThisMonth} sessions</div>
              </div>
              <div>
                <span className="text-gray-500">Total cost</span>
                <div className="text-gray-200 font-medium">{fmtCost(a.totalCost)}</div>
              </div>
              <div>
                <span className="text-gray-500">Cost this month</span>
                <div className="text-gray-200 font-medium">{fmtCost(a.costThisMonth)}</div>
              </div>
              <div>
                <span className="text-gray-500">Avg duration</span>
                <div className="text-gray-200 font-medium">{fmtDuration(a.avgSessionDuration)}</div>
              </div>
              <div>
                <span className="text-gray-500">Lines</span>
                <div className="text-gray-200 font-medium">
                  <span className="text-green-400">+{fmt(a.linesAdded)}</span>{' / '}
                  <span className="text-red-400">-{fmt(a.linesRemoved)}</span>
                </div>
              </div>
            </div>

            {a.lastActive && (
              <div className="mt-3 pt-2 border-t border-gray-800 text-[10px] text-gray-600">
                Last active: {timeAgo(a.lastActive)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

type Tab = 'sessions' | 'timeline' | 'agents' | 'stats' | 'patterns' | 'efficiency' | 'prompts';

export default function MyDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Stats
  const [stats, setStats] = useState<MyStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // Agent cards
  const [agentCards, setAgentCards] = useState<AgentCard[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);

  // Sessions
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsOffset, setSessionsOffset] = useState(0);
  const LIMIT = 30;

  // Bookmarks
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [bookmarkTags, setBookmarkTags] = useState<Record<string, string[]>>({});
  const [showBookmarked, setShowBookmarked] = useState(false);
  const [bookmarkedSessions, setBookmarkedSessions] = useState<Session[]>([]);

  // Timeline sessions (all recent, no pagination)
  const [timelineSessions, setTimelineSessions] = useState<Session[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [repoFilter, setRepoFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Patterns
  const [patterns, setPatterns] = useState<CodingPatterns | null>(null);
  const [patternsLoading, setPatternsLoading] = useState(false);

  // Efficiency
  const [efficiency, setEfficiency] = useState<Efficiency | null>(null);
  const [efficiencyLoading, setEfficiencyLoading] = useState(false);

  // Prompts explorer
  const [promptEntries, setPromptEntries] = useState<PromptEntry[]>([]);
  const [promptsTotal, setPromptsTotal] = useState(0);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptsOffset, setPromptsOffset] = useState(0);
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
  const [promptSearch, setPromptSearch] = useState('');
  const [promptSearchDebounced, setPromptSearchDebounced] = useState('');

  // Compare
  const [compareIds, setCompareIds] = useState<string[]>([]);

  // Tab
  const [tab, setTab] = useState<Tab>('sessions');

  // ── Fetch stats ─────────────────────────────────────────────────────
  useEffect(() => {
    setStatsLoading(true);
    request<MyStats>('/api/stats/me')
      .then(setStats)
      .catch(() => {})
      .finally(() => setStatsLoading(false));
  }, []);

  // ── Fetch agent cards ──────────────────────────────────────────────
  useEffect(() => {
    setAgentsLoading(true);
    request<{ agents: AgentCard[] }>('/api/stats/me/agents')
      .then((data) => setAgentCards(data.agents))
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }, []);

  // ── Fetch sessions ──────────────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('mine', 'true');
      params.set('limit', String(LIMIT));
      params.set('offset', String(sessionsOffset));
      if (agentFilter) params.set('model', agentFilter);
      if (repoFilter) params.set('repoName', repoFilter);
      if (statusFilter) params.set('status', statusFilter);

      const data = await request<{ sessions: Session[]; total: number }>(
        `/api/sessions?${params.toString()}`,
      );
      setSessions(data.sessions);
      setSessionsTotal(data.total);
    } catch {
      // ignore
    }
    setSessionsLoading(false);
  }, [sessionsOffset, agentFilter, repoFilter, statusFilter]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // ── Fetch timeline sessions (last 100, no offset) ─────────────────
  useEffect(() => {
    if (tab !== 'timeline') return;
    setTimelineLoading(true);
    const params = new URLSearchParams();
    params.set('mine', 'true');
    params.set('limit', '100');
    params.set('offset', '0');
    request<{ sessions: Session[]; total: number }>(`/api/sessions?${params.toString()}`)
      .then((data) => setTimelineSessions(data.sessions))
      .catch(() => {})
      .finally(() => setTimelineLoading(false));
  }, [tab]);

  // ── Fetch patterns (lazy) ─────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'patterns' || patterns) return;
    setPatternsLoading(true);
    request<CodingPatterns>('/api/stats/me/patterns')
      .then(setPatterns)
      .catch(() => {})
      .finally(() => setPatternsLoading(false));
  }, [tab, patterns]);

  // ── Fetch efficiency (lazy) ────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'efficiency' || efficiency) return;
    setEfficiencyLoading(true);
    request<Efficiency>('/api/stats/me/efficiency')
      .then(setEfficiency)
      .catch(() => {})
      .finally(() => setEfficiencyLoading(false));
  }, [tab, efficiency]);

  // ── Debounce prompt search ──────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setPromptSearchDebounced(promptSearch);
      setPromptsOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [promptSearch]);

  // ── Fetch prompts (lazy) ───────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'prompts') return;
    setPromptsLoading(true);
    const params = new URLSearchParams();
    params.set('limit', '30');
    params.set('offset', String(promptsOffset));
    if (promptSearchDebounced) params.set('q', promptSearchDebounced);
    request<{ prompts: PromptEntry[]; total: number }>(`/api/stats/me/prompts?${params.toString()}`)
      .then((data) => {
        setPromptEntries(data.prompts);
        setPromptsTotal(data.total);
      })
      .catch(() => {})
      .finally(() => setPromptsLoading(false));
  }, [tab, promptsOffset, promptSearchDebounced]);

  // ── Fetch bookmarked IDs ────────────────────────────────────────────
  useEffect(() => {
    request<Session[]>('/api/sessions/bookmarked')
      .then((data) => {
        setBookmarkedIds(new Set(data.map((s) => s.id)));
        setBookmarkedSessions(data);
        const tagMap: Record<string, string[]> = {};
        for (const s of data) {
          if (s.bookmark?.tags?.length) tagMap[s.id] = s.bookmark.tags;
        }
        setBookmarkTags(tagMap);
      })
      .catch(() => {});
  }, []);

  // ── Bookmark toggle ─────────────────────────────────────────────────
  const toggleBookmark = async (sessionId: string) => {
    const isBookmarked = bookmarkedIds.has(sessionId);
    try {
      if (isBookmarked) {
        await request(`/api/sessions/${sessionId}/bookmark`, { method: 'DELETE' });
        setBookmarkedIds((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
        setBookmarkedSessions((prev) => prev.filter((s) => s.id !== sessionId));
        setBookmarkTags((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      } else {
        await request(`/api/sessions/${sessionId}/bookmark`, {
          method: 'POST',
          body: JSON.stringify({ tags: [], note: '' }),
        });
        setBookmarkedIds((prev) => new Set(prev).add(sessionId));
      }
    } catch {
      // ignore
    }
  };

  // ── Update tags for a session bookmark ──────────────────────────────
  const updateBookmarkTags = async (sessionId: string, tags: string[]) => {
    try {
      // Ensure bookmarked first
      if (!bookmarkedIds.has(sessionId)) {
        await request(`/api/sessions/${sessionId}/bookmark`, {
          method: 'POST',
          body: JSON.stringify({ tags, note: '' }),
        });
        setBookmarkedIds((prev) => new Set(prev).add(sessionId));
      } else {
        await request(`/api/sessions/${sessionId}/bookmark`, {
          method: 'POST',
          body: JSON.stringify({ tags, note: '' }),
        });
      }
      setBookmarkTags((prev) => ({ ...prev, [sessionId]: tags }));
    } catch {
      // ignore
    }
  };

  // Filter sessions by search text
  const filteredSessions = useMemo(() => {
    const list = showBookmarked ? bookmarkedSessions : sessions;
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (s) =>
        (s.model || '').toLowerCase().includes(q) ||
        (s.agentName || '').toLowerCase().includes(q) ||
        (s.repoName || '').toLowerCase().includes(q) ||
        (s.branch || '').toLowerCase().includes(q),
    );
  }, [sessions, bookmarkedSessions, showBookmarked, search]);

  // Unique agents and repos for filter dropdowns
  const uniqueAgents = useMemo(() => {
    if (!stats) return [];
    return stats.agentBreakdown.map((a) => a.agentName).filter(Boolean);
  }, [stats]);

  const uniqueRepos = useMemo(() => {
    if (!stats) return [];
    return stats.sessionsByRepo.map((r) => r.repoName).filter(Boolean);
  }, [stats]);

  const totalPages = Math.ceil((showBookmarked ? bookmarkedSessions.length : sessionsTotal) / LIMIT);
  const currentPage = Math.floor(sessionsOffset / LIMIT) + 1;

  const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: 'sessions', label: 'Sessions', icon: Play },
    { key: 'timeline', label: 'Timeline', icon: Activity },
    { key: 'agents', label: 'Agents', icon: Bot },
    { key: 'stats', label: 'Stats', icon: BarChart3 },
    { key: 'patterns', label: 'Patterns', icon: Timer },
    { key: 'efficiency', label: 'Efficiency', icon: Gauge },
    { key: 'prompts', label: 'Prompt Search', icon: Search },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-100">My Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {user?.name || user?.email} &middot; Personal coding activity
          </p>
        </div>
        {stats && stats.streak > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20">
            <Flame className="w-4 h-4 text-orange-400" />
            <span className="text-sm font-semibold text-orange-400">{stats.streak} day streak</span>
          </div>
        )}
      </div>

      {/* Stat cards row */}
      {statsLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card py-4 animate-pulse">
              <div className="h-4 w-16 bg-gray-800 rounded mb-2" />
              <div className="h-6 w-24 bg-gray-800 rounded" />
            </div>
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="card py-4">
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <Play className="w-3.5 h-3.5" />
              Sessions
            </div>
            <div className="text-2xl font-bold text-gray-100">{fmt(stats.totalSessions)}</div>
            <Trend current={stats.thisWeek.sessions} previous={stats.lastWeek.sessions} />
          </div>
          <div className="card py-4">
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <Zap className="w-3.5 h-3.5" />
              Tokens
            </div>
            <div className="text-2xl font-bold text-gray-100">{fmt(stats.totalTokens)}</div>
            <Trend current={stats.thisWeek.tokens} previous={stats.lastWeek.tokens} />
          </div>
          <div className="card py-4">
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <DollarSign className="w-3.5 h-3.5" />
              Cost
            </div>
            <div className="text-2xl font-bold text-gray-100">{fmtCost(stats.totalCost)}</div>
            <Trend current={stats.thisWeek.cost} previous={stats.lastWeek.cost} />
          </div>
          <div className="card py-4">
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <Code2 className="w-3.5 h-3.5" />
              Lines Written
            </div>
            <div className="text-2xl font-bold text-gray-100">{fmt(stats.totalLinesAdded)}</div>
            <div className="text-xs text-gray-600">
              <span className="text-green-500">+{fmt(stats.totalLinesAdded)}</span>
              {' / '}
              <span className="text-red-400">-{fmt(stats.totalLinesRemoved)}</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Quick Start Guide — shows when no sessions */}
      {stats && stats.totalSessions === 0 && !statsLoading && (
        <div className="rounded-xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
              <Terminal className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-100">Get Started with Origin</h2>
              <p className="text-sm text-gray-500">Set up session tracking in under 2 minutes</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Step 1 */}
            <div className="bg-gray-900/60 rounded-lg p-4 border border-gray-800">
              <div className="flex items-center gap-2 mb-3">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold">1</span>
                <span className="text-sm font-semibold text-gray-200">Install CLI</span>
              </div>
              <div className="bg-gray-950 rounded-md p-3 font-mono text-xs text-emerald-400 mb-3 overflow-x-auto">
                npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
              </div>
              <p className="text-xs text-gray-500">Works on macOS, Linux, and WSL</p>
            </div>

            {/* Step 2 */}
            <div className="bg-gray-900/60 rounded-lg p-4 border border-gray-800">
              <div className="flex items-center gap-2 mb-3">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold">2</span>
                <span className="text-sm font-semibold text-gray-200">Create API Key</span>
              </div>
              <p className="text-xs text-gray-400 mb-3">
                Go to{' '}
                <a href="/settings" className="text-emerald-400 hover:text-emerald-300 underline">Settings</a>
                {' '}&rarr; General &rarr; create an API key. Copy it &mdash; you&apos;ll need it next.
              </p>
              <p className="text-xs text-gray-500">The key connects the CLI to your account</p>
            </div>

            {/* Step 3 */}
            <div className="bg-gray-900/60 rounded-lg p-4 border border-gray-800">
              <div className="flex items-center gap-2 mb-3">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold">3</span>
                <span className="text-sm font-semibold text-gray-200">Configure &amp; Init</span>
              </div>
              <div className="bg-gray-950 rounded-md p-3 font-mono text-xs text-gray-300 space-y-1 mb-3">
                <div><span className="text-gray-500">$</span> origin config set api-key <span className="text-emerald-400">YOUR_KEY</span></div>
                <div><span className="text-gray-500">$</span> origin init</div>
              </div>
              <p className="text-xs text-gray-500">Auto-detects Claude, Cursor, Copilot, Gemini &amp; more</p>
            </div>

            {/* Step 4 */}
            <div className="bg-gray-900/60 rounded-lg p-4 border border-gray-800">
              <div className="flex items-center gap-2 mb-3">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold">4</span>
                <span className="text-sm font-semibold text-gray-200">Start Coding</span>
              </div>
              <div className="bg-gray-950 rounded-md p-3 font-mono text-xs text-gray-300 space-y-1 mb-3">
                <div><span className="text-gray-500">#</span> Use any AI coding tool</div>
                <div><span className="text-gray-500">#</span> Sessions auto-track</div>
                <div><span className="text-gray-500">$</span> origin sessions</div>
              </div>
              <p className="text-xs text-gray-500">Every AI session appears here automatically</p>
            </div>
          </div>

          <div className="flex items-center gap-4 pt-1">
            <a
              href="/docs/cli-install"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              Full documentation <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <a
              href="/docs/cli-hooks"
              className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              How hooks work <ArrowRight className="w-3.5 h-3.5" />
            </a>
            <a
              href="/docs/cli-local"
              className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              Local / standalone mode <ArrowRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-800 pb-0 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              tab === t.key
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══════════════════ SESSIONS TAB ═══════════════════ */}
      {tab === 'sessions' && (
        <div className="space-y-4">
          {/* Filters row */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                placeholder="Search sessions..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input w-full pl-9 text-sm"
              />
            </div>
            <select
              value={agentFilter}
              onChange={(e) => { setAgentFilter(e.target.value); setSessionsOffset(0); }}
              className="select text-sm"
            >
              <option value="">All agents</option>
              {uniqueAgents.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <select
              value={repoFilter}
              onChange={(e) => { setRepoFilter(e.target.value); setSessionsOffset(0); }}
              className="select text-sm"
            >
              <option value="">All repos</option>
              {uniqueRepos.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setSessionsOffset(0); }}
              className="select text-sm"
            >
              <option value="">All statuses</option>
              <option value="RUNNING">Running</option>
              <option value="COMPLETED">Completed</option>
              <option value="approved">Approved</option>
              <option value="flagged">Flagged</option>
              <option value="rejected">Rejected</option>
              <option value="unreviewed">Unreviewed</option>
            </select>
            <button
              onClick={() => setShowBookmarked(!showBookmarked)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                showBookmarked
                  ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700'
              }`}
            >
              <Bookmark className="w-3.5 h-3.5" />
              Saved
            </button>
            {compareIds.length > 0 && (
              <button
                disabled={compareIds.length !== 2}
                onClick={() => navigate(`/compare/${compareIds[0]}/${compareIds[1]}`)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                  compareIds.length === 2
                    ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/25'
                    : 'bg-gray-800 text-gray-500 border-gray-700 opacity-60'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" />
                Compare {compareIds.length}/2
              </button>
            )}
          </div>

          {/* Sessions table */}
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="px-2 py-3 font-medium w-8"></th>
                    <th className="px-4 py-3 font-medium w-8"></th>
                    <th className="px-4 py-3 font-medium">Agent</th>
                    <th className="px-4 py-3 font-medium">Repo</th>
                    <th className="px-4 py-3 font-medium hidden md:table-cell">Branch</th>
                    <th className="px-4 py-3 font-medium">Duration</th>
                    <th className="px-4 py-3 font-medium">Cost</th>
                    <th className="px-4 py-3 font-medium hidden lg:table-cell">Tokens</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium hidden xl:table-cell">Tags</th>
                    <th className="px-4 py-3 font-medium text-right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionsLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i} className="border-b border-gray-800/50">
                        <td colSpan={11} className="px-4 py-3">
                          <div className="h-4 bg-gray-800 rounded animate-pulse" />
                        </td>
                      </tr>
                    ))
                  ) : filteredSessions.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-4 py-8 text-center text-gray-600">
                        {showBookmarked ? 'No saved sessions yet. Star a session to save it.' : 'No sessions found.'}
                      </td>
                    </tr>
                  ) : (
                    filteredSessions.map((s) => (
                      <tr
                        key={s.id}
                        className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors cursor-pointer"
                        onClick={() => navigate(`/sessions/${s.id}`)}
                      >
                        <td className="px-2 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={compareIds.includes(s.id)}
                            disabled={!compareIds.includes(s.id) && compareIds.length >= 2}
                            onChange={() => {
                              setCompareIds((prev) =>
                                prev.includes(s.id)
                                  ? prev.filter((x) => x !== s.id)
                                  : prev.length < 2 ? [...prev, s.id] : prev
                              );
                            }}
                            className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500/30 cursor-pointer"
                            title="Select to compare"
                          />
                        </td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => toggleBookmark(s.id)}
                            className="p-0.5 rounded hover:bg-gray-700 transition-colors"
                            title={bookmarkedIds.has(s.id) ? 'Remove bookmark' : 'Bookmark session'}
                          >
                            <Star
                              className={`w-4 h-4 ${
                                bookmarkedIds.has(s.id) ? 'text-amber-400 fill-amber-400' : 'text-gray-600'
                              }`}
                            />
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded"
                            style={{
                              backgroundColor: `${agentColor(s.agentName)}15`,
                              color: agentColor(s.agentName),
                            }}
                          >
                            {s.agentName || s.model.split('/').pop()?.split('-').slice(0, 2).join('-') || s.model}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-400">{s.repoName || '—'}</td>
                        <td className="px-4 py-3 text-gray-500 hidden md:table-cell font-mono text-xs">
                          {s.branch || '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-300">{fmtDuration(s.durationMs)}</td>
                        <td className="px-4 py-3 text-gray-300">{fmtCost(s.costUsd)}</td>
                        <td className="px-4 py-3 text-gray-400 hidden lg:table-cell">{fmt(s.tokensUsed)}</td>
                        <td className="px-4 py-3">
                          {s.status === 'RUNNING' ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-900/30 text-green-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                              Running
                            </span>
                          ) : s.review ? (
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                s.review.status === 'APPROVED'
                                  ? 'bg-green-900/30 text-green-400'
                                  : s.review.status === 'FLAGGED'
                                  ? 'bg-amber-900/30 text-amber-400'
                                  : s.review.status === 'REJECTED'
                                  ? 'bg-red-900/30 text-red-400'
                                  : 'bg-gray-800 text-gray-400'
                              }`}
                            >
                              {s.review.status.charAt(0) + s.review.status.slice(1).toLowerCase()}
                              {s.review.score !== null && ` ${s.review.score}`}
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-800 text-gray-500">
                              Done
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 hidden xl:table-cell" onClick={(e) => e.stopPropagation()}>
                          <TagEditor
                            tags={bookmarkTags[s.id] || []}
                            onSave={(tags) => updateBookmarkTags(s.id, tags)}
                          />
                        </td>
                        <td className="px-4 py-3 text-right text-gray-500 text-xs whitespace-nowrap">
                          {timeAgo(s.createdAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {!showBookmarked && totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
                <span className="text-xs text-gray-500">
                  {sessionsOffset + 1}–{Math.min(sessionsOffset + LIMIT, sessionsTotal)} of {sessionsTotal}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    disabled={sessionsOffset === 0}
                    onClick={() => setSessionsOffset(Math.max(0, sessionsOffset - LIMIT))}
                    className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                  >
                    Prev
                  </button>
                  <span className="text-xs text-gray-500 px-2">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    disabled={sessionsOffset + LIMIT >= sessionsTotal}
                    onClick={() => setSessionsOffset(sessionsOffset + LIMIT)}
                    className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════════ TIMELINE TAB ═══════════════════ */}
      {tab === 'timeline' && (
        <div>
          {timelineLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-4 w-32 bg-gray-800 rounded mb-3" />
                  <div className="ml-4 pl-6 border-l-2 border-gray-800 space-y-3">
                    {Array.from({ length: 2 }).map((_, j) => (
                      <div key={j} className="h-16 bg-gray-800/50 rounded-lg" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <SessionTimeline sessions={timelineSessions} navigate={navigate} />
          )}
        </div>
      )}

      {/* ═══════════════════ AGENTS TAB ═══════════════════ */}
      {tab === 'agents' && (
        <div>
          {agentsLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-8 w-32 bg-gray-800 rounded mb-3" />
                  <div className="h-20 bg-gray-800/50 rounded" />
                </div>
              ))}
            </div>
          ) : (
            <AgentCards agents={agentCards} />
          )}
        </div>
      )}

      {/* ═══════════════════ STATS TAB ═══════════════════ */}
      {tab === 'stats' && (
        <div className="space-y-6">
          {statsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="card py-8 animate-pulse">
                  <div className="h-4 w-32 bg-gray-800 rounded mb-3" />
                  <div className="h-20 bg-gray-800 rounded" />
                </div>
              ))}
            </div>
          ) : stats ? (
            <>
              {/* Activity heatmap */}
              <div className="card">
                <h3 className="text-sm font-semibold text-gray-300 mb-3">Activity</h3>
                <ActivityHeatmap data={stats.heatmap} />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Agent breakdown */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Agents Used</h3>
                  <AgentPie data={stats.agentBreakdown} />
                  <div className="mt-3 space-y-1">
                    {stats.agentBreakdown.map((a, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-gray-400">{a.agentName}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-gray-500">{a.sessions} sessions</span>
                          <span className="text-gray-300">{fmtCost(a.cost)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Top files */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Most Modified Files</h3>
                  {stats.topFiles.length === 0 ? (
                    <p className="text-xs text-gray-600">No file data yet</p>
                  ) : (
                    <div className="space-y-2">
                      {stats.topFiles.slice(0, 10).map((f, i) => {
                        const maxCount = stats.topFiles[0]?.count || 1;
                        return (
                          <div key={i}>
                            <div className="flex items-center justify-between text-xs mb-0.5">
                              <span className="text-gray-400 font-mono truncate max-w-[250px]" title={f.file}>
                                {f.file}
                              </span>
                              <span className="text-gray-500 ml-2 flex-shrink-0">{f.count}x</span>
                            </div>
                            <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-indigo-500/60 rounded-full"
                                style={{ width: `${(f.count / maxCount) * 100}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Sessions by repo */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Sessions by Repository</h3>
                  {stats.sessionsByRepo.length === 0 ? (
                    <p className="text-xs text-gray-600">No repo data yet</p>
                  ) : (
                    <div className="space-y-2">
                      {stats.sessionsByRepo.slice(0, 8).map((r, i) => {
                        const maxSessions = stats.sessionsByRepo[0]?.sessions || 1;
                        return (
                          <div key={i}>
                            <div className="flex items-center justify-between text-xs mb-0.5">
                              <span className="text-gray-400">{r.repoName}</span>
                              <span className="text-gray-500">{r.sessions} sessions</span>
                            </div>
                            <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-cyan-500/60 rounded-full"
                                style={{ width: `${(r.sessions / maxSessions) * 100}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Model breakdown */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Models Used</h3>
                  {stats.modelBreakdown.length === 0 ? (
                    <p className="text-xs text-gray-600">No model data yet</p>
                  ) : (
                    <div className="space-y-1.5">
                      {stats.modelBreakdown.map((m, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="text-gray-400 font-mono">{m.model}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-gray-500">{m.sessions}x</span>
                            <span className="text-gray-300">{fmtCost(m.cost)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Code impact summary */}
              <div className="card">
                <h3 className="text-sm font-semibold text-gray-300 mb-3">Code Impact</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs text-gray-500 mb-0.5">Lines Added</div>
                    <div className="text-lg font-bold text-green-400">+{fmt(stats.totalLinesAdded)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-0.5">Lines Removed</div>
                    <div className="text-lg font-bold text-red-400">-{fmt(stats.totalLinesRemoved)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-0.5">Tool Calls</div>
                    <div className="text-lg font-bold text-gray-200">{fmt(stats.totalToolCalls)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-0.5">Net Lines</div>
                    <div className={`text-lg font-bold ${stats.totalLinesAdded - stats.totalLinesRemoved >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {stats.totalLinesAdded - stats.totalLinesRemoved >= 0 ? '+' : ''}{fmt(stats.totalLinesAdded - stats.totalLinesRemoved)}
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="card py-12 text-center text-gray-600">
              Failed to load stats. Try refreshing.
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════ PATTERNS TAB ═══════════════════ */}
      {tab === 'patterns' && (
        <div className="space-y-6">
          {patternsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="card py-8 animate-pulse">
                  <div className="h-4 w-32 bg-gray-800 rounded mb-3" />
                  <div className="h-24 bg-gray-800 rounded" />
                </div>
              ))}
            </div>
          ) : patterns ? (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Peak Hour</div>
                  <div className="text-2xl font-bold text-gray-100">
                    {patterns.peakHour}:00
                  </div>
                  <div className="text-xs text-gray-600">most active time</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Peak Day</div>
                  <div className="text-2xl font-bold text-gray-100">{patterns.peakDay}</div>
                  <div className="text-xs text-gray-600">most sessions</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">This Month</div>
                  <div className="text-2xl font-bold text-gray-100">{patterns.sessionsThisMonth}</div>
                  <div className="text-xs text-gray-600">sessions &middot; {fmtCost(patterns.costThisMonth)}</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Avg Session</div>
                  <div className="text-2xl font-bold text-gray-100">{fmtDuration(patterns.avgSessionDuration)}</div>
                  <div className="text-xs text-gray-600">{fmt(patterns.avgTokensPerSession)} tokens &middot; {fmtCost(patterns.avgCostPerSession)}</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Hour-of-day chart */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-4">Sessions by Hour</h3>
                  <div className="flex items-end gap-[3px] h-32">
                    {patterns.hourly.map((count, h) => {
                      const max = Math.max(1, ...patterns.hourly);
                      const pct = (count / max) * 100;
                      const isPeak = h === patterns.peakHour;
                      return (
                        <div key={h} className="flex-1 flex flex-col items-center gap-1">
                          <div
                            className={`w-full rounded-t transition-all ${isPeak ? 'bg-indigo-500' : 'bg-indigo-500/40'}`}
                            style={{ height: `${Math.max(pct, 2)}%` }}
                            title={`${h}:00 — ${count} sessions`}
                          />
                          {h % 4 === 0 && (
                            <span className="text-[9px] text-gray-600">{h}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-[9px] text-gray-600 mt-1">
                    <span>12am</span>
                    <span>12pm</span>
                    <span>11pm</span>
                  </div>
                </div>

                {/* Day-of-week chart */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-4">Sessions by Day</h3>
                  <div className="space-y-2">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => {
                      const count = patterns.daily[i] || 0;
                      const max = Math.max(1, ...patterns.daily);
                      const pct = (count / max) * 100;
                      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                      const isPeak = dayNames[i] === patterns.peakDay;
                      return (
                        <div key={day} className="flex items-center gap-3">
                          <span className={`text-xs w-8 ${isPeak ? 'text-indigo-400 font-semibold' : 'text-gray-500'}`}>{day}</span>
                          <div className="flex-1 h-4 bg-gray-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${isPeak ? 'bg-indigo-500' : 'bg-indigo-500/40'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500 w-8 text-right">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="card py-12 text-center text-gray-600">No pattern data available.</div>
          )}
        </div>
      )}

      {/* ═══════════════════ EFFICIENCY TAB ═══════════════════ */}
      {tab === 'efficiency' && (
        <div className="space-y-6">
          {efficiencyLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="card py-8 animate-pulse">
                  <div className="h-4 w-32 bg-gray-800 rounded mb-3" />
                  <div className="h-24 bg-gray-800 rounded" />
                </div>
              ))}
            </div>
          ) : efficiency ? (
            <>
              {/* Efficiency metrics */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Tokens / Line</div>
                  <div className="text-2xl font-bold text-gray-100">
                    {efficiency.tokensPerLine > 0 ? efficiency.tokensPerLine.toFixed(0) : '—'}
                  </div>
                  <div className="text-xs text-gray-600">token efficiency</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Cost / Session</div>
                  <div className="text-2xl font-bold text-gray-100">{fmtCost(efficiency.costPerSession)}</div>
                  <div className="text-xs text-gray-600">average spend</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Cost / Commit</div>
                  <div className="text-2xl font-bold text-gray-100">{fmtCost(efficiency.costPerCommit)}</div>
                  <div className="text-xs text-gray-600">per code commit</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Lines / Session</div>
                  <div className="text-2xl font-bold text-gray-100">{efficiency.avgLinesPerSession.toFixed(0)}</div>
                  <div className="text-xs text-gray-600">avg output</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Commit stats */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">
                    <GitCommit className="w-4 h-4 inline mr-1.5 text-gray-500" />
                    Commit Stats
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <div className="text-xs text-gray-500 mb-0.5">Total Commits</div>
                      <div className="text-lg font-bold text-gray-200">{efficiency.commitStats.totalCommits}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-0.5">Per Session</div>
                      <div className="text-lg font-bold text-gray-200">{efficiency.commitStats.commitsPerSession.toFixed(1)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-0.5">Files / Commit</div>
                      <div className="text-lg font-bold text-gray-200">{efficiency.commitStats.avgFilesPerCommit.toFixed(1)}</div>
                    </div>
                  </div>
                </div>

                {/* Cost breakdown visual */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">
                    <DollarSign className="w-4 h-4 inline mr-1.5 text-gray-500" />
                    Efficiency Ratios
                  </h3>
                  <div className="space-y-3">
                    {[
                      { label: 'Tokens per line of code', value: efficiency.tokensPerLine, unit: '', good: efficiency.tokensPerLine < 200 },
                      { label: 'Avg cost per session', value: efficiency.costPerSession, unit: '$', good: efficiency.costPerSession < 0.50 },
                      { label: 'Commits per session', value: efficiency.commitStats.commitsPerSession, unit: '', good: efficiency.commitStats.commitsPerSession > 1 },
                    ].map((m, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-xs text-gray-400">{m.label}</span>
                        <span className={`text-sm font-semibold ${m.good ? 'text-green-400' : 'text-amber-400'}`}>
                          {m.unit === '$' ? fmtCost(m.value) : m.value.toFixed(1)}
                          {m.good ? ' ✓' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="card py-12 text-center text-gray-600">No efficiency data available.</div>
          )}
        </div>
      )}

      {/* ═══════════════════ PROMPTS TAB ═══════════════════ */}
      {tab === 'prompts' && (
        <div className="space-y-4">
          {/* Prompt search bar */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={promptSearch}
                onChange={(e) => setPromptSearch(e.target.value)}
                placeholder="Search across all prompts..."
                className="input pl-10 w-full"
              />
            </div>
            <span className="text-xs text-gray-500 whitespace-nowrap">{promptsTotal} result{promptsTotal !== 1 ? 's' : ''}</span>
          </div>
          {promptsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-4 w-48 bg-gray-800 rounded mb-2" />
                  <div className="h-3 w-96 bg-gray-800/50 rounded" />
                </div>
              ))}
            </div>
          ) : promptEntries.length === 0 ? (
            <div className="card py-12 text-center text-gray-600">
              No prompts recorded yet. Prompts are captured during AI coding sessions.
            </div>
          ) : (
            <>
              <div className="text-xs text-gray-500">{promptsTotal} total prompts</div>
              <div className="space-y-2">
                {promptEntries.map((p, i) => {
                  const key = `${p.sessionId}-${p.promptIndex}`;
                  const isExpanded = expandedPrompt === key;
                  const color = agentColor(p.agentName);
                  return (
                    <div key={i} className="card hover:border-gray-700 transition-colors">
                      <div
                        className="flex items-start gap-3 cursor-pointer"
                        onClick={() => setExpandedPrompt(isExpanded ? null : key)}
                      >
                        <div className="flex-shrink-0 mt-0.5">
                          <MessageSquare className="w-4 h-4 text-gray-600" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                              style={{ backgroundColor: `${color}20`, color }}
                            >
                              {p.agentName || 'Unknown'}
                            </span>
                            <span className="text-[10px] text-gray-600">
                              prompt #{p.promptIndex + 1}
                            </span>
                            <span className="text-[10px] text-gray-600">
                              &middot; {timeAgo(p.createdAt)}
                            </span>
                            {p.filesChanged.length > 0 && (
                              <span className="text-[10px] text-gray-500">
                                <FileText className="w-3 h-3 inline mr-0.5" />
                                {p.filesChanged.length} file{p.filesChanged.length !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-300 line-clamp-2">
                            {promptSearchDebounced ? (() => {
                              const idx = p.promptText.toLowerCase().indexOf(promptSearchDebounced.toLowerCase());
                              if (idx === -1) return p.promptText;
                              const before = p.promptText.slice(0, idx);
                              const match = p.promptText.slice(idx, idx + promptSearchDebounced.length);
                              const after = p.promptText.slice(idx + promptSearchDebounced.length);
                              return <>{before}<mark className="bg-indigo-500/30 text-indigo-300 rounded px-0.5">{match}</mark>{after}</>;
                            })() : p.promptText}
                          </p>
                        </div>
                        <button
                          className="text-gray-600 hover:text-gray-400 flex-shrink-0"
                          onClick={(e) => { e.stopPropagation(); navigate(`/sessions/${p.sessionId}`); }}
                          title="View session"
                        >
                          <ArrowRight className="w-4 h-4" />
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
                          {p.filesChanged.length > 0 && (
                            <div>
                              <div className="text-[10px] text-gray-500 mb-1">Files changed:</div>
                              <div className="flex flex-wrap gap-1">
                                {p.filesChanged.map((f, fi) => (
                                  <span key={fi} className="px-1.5 py-0.5 rounded text-[10px] bg-gray-800 text-gray-400 font-mono">
                                    {f}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {p.diff && (
                            <div>
                              <div className="text-[10px] text-gray-500 mb-1">Diff:</div>
                              <pre className="text-[10px] font-mono leading-relaxed bg-gray-900/80 border border-gray-800 rounded-lg px-3 py-2 overflow-x-auto max-h-60">
                                {p.diff.split('\n').slice(0, 50).map((line, li) => (
                                  <div
                                    key={li}
                                    className={
                                      line.startsWith('+') && !line.startsWith('+++')
                                        ? 'text-green-400'
                                        : line.startsWith('-') && !line.startsWith('---')
                                        ? 'text-red-400'
                                        : line.startsWith('@@')
                                        ? 'text-cyan-400'
                                        : 'text-gray-500'
                                    }
                                  >
                                    {line}
                                  </div>
                                ))}
                                {p.diff.split('\n').length > 50 && (
                                  <div className="text-gray-600 mt-1">... {p.diff.split('\n').length - 50} more lines</div>
                                )}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Pagination */}
              {promptsTotal > 30 && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">
                    {promptsOffset + 1}–{Math.min(promptsOffset + 30, promptsTotal)} of {promptsTotal}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      disabled={promptsOffset === 0}
                      onClick={() => setPromptsOffset(Math.max(0, promptsOffset - 30))}
                      className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                    >
                      Prev
                    </button>
                    <button
                      disabled={promptsOffset + 30 >= promptsTotal}
                      onClick={() => setPromptsOffset(promptsOffset + 30)}
                      className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
