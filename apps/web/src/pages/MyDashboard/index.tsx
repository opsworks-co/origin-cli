import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { request } from '../../api';
import {
  Play,
  Flame,
  Bot,
  X,
  Activity,
  BarChart3,
  Timer,
  Gauge,
  GitCommit,
  Terminal,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ArrowRight,
  Search,
} from 'lucide-react';
import {
  Session,
  MyStats,
  AgentCard,
  CodingPatterns,
  Efficiency,
  PromptEntry,
  fmt,
  fmtCost,
} from './utils';
import { StatCardsRow } from './StatCardsRow';
import { TodayActivityFeed } from './TodayActivityFeed';
import { TimelineTab } from './tabs/TimelineTab';
import { AgentsTab } from './tabs/AgentsTab';
import { StatsTab } from './tabs/StatsTab';
import { PatternsTab } from './tabs/PatternsTab';
import { EfficiencyTab } from './tabs/EfficiencyTab';
import { PromptsTab } from './tabs/PromptsTab';
import { CommitsTab, CommitEntry, CommitSort } from './tabs/CommitsTab';

// ── Main component ──────────────────────────────────────────────────────────

// Sessions lives on /sessions (left-nav) — don't duplicate it here.
type Tab = 'timeline' | 'commits' | 'prompts' | 'agents' | 'stats' | 'patterns' | 'efficiency';

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'timeline', label: 'Timeline', icon: Activity },
  { key: 'commits', label: 'Commits', icon: GitCommit },
  { key: 'prompts', label: 'Prompt Search', icon: Search },
  { key: 'agents', label: 'Agents', icon: Bot },
  { key: 'stats', label: 'Stats', icon: BarChart3 },
  { key: 'patterns', label: 'Patterns', icon: Timer },
  { key: 'efficiency', label: 'Efficiency', icon: Gauge },
];

export default function MyDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Stats
  const [stats, setStats] = useState<MyStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [hideGuide, setHideGuide] = useState(() => {
    try { return localStorage.getItem('origin:hide-guide') === '1'; } catch { return false; }
  });

  // Show guide unless user dismissed it. Dismissal is always respected.
  const showGuide = !hideGuide;

  // Agent cards
  const [agentCards, setAgentCards] = useState<AgentCard[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);

  // Sessions
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsOffset, setSessionsOffset] = useState(0);
  const LIMIT = 30;

  // Session sorting
  type SortField = 'agent' | 'repo' | 'duration' | 'cost' | 'tokens' | 'status' | 'date';
  type SortDir = 'asc' | 'desc';
  const [sortBy, setSortBy] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const toggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir(field === 'date' ? 'desc' : 'asc');
    }
  };
  const sortedSessions = useMemo(() => {
    const list = [...sessions];
    list.sort((a, b) => {
      const aRunning = a.status === 'RUNNING' ? 1 : 0;
      const bRunning = b.status === 'RUNNING' ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      let cmp = 0;
      switch (sortBy) {
        case 'agent': cmp = (a.agentName || a.model || '').localeCompare(b.agentName || b.model || ''); break;
        case 'repo': cmp = ((a as any).repoName || '').localeCompare((b as any).repoName || ''); break;
        case 'duration': cmp = a.durationMs - b.durationMs; break;
        case 'cost': cmp = a.costUsd - b.costUsd; break;
        case 'tokens': cmp = a.tokensUsed - b.tokensUsed; break;
        case 'status': cmp = (a.status || '').localeCompare(b.status || ''); break;
        case 'date': default: cmp = new Date(a.startedAt || a.createdAt).getTime() - new Date(b.startedAt || b.createdAt).getTime(); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [sessions, sortBy, sortDir]);
  const SortHeader = ({ field, children, align, className = '' }: { field: SortField; children: React.ReactNode; align?: 'right'; className?: string }) => (
    <th className={`px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none ${align === 'right' ? 'text-right' : ''} ${className}`} onClick={() => toggleSort(field)}>
      <span className="inline-flex items-center gap-1">
        {children}
        {sortBy === field && <span className="text-indigo-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
      </span>
    </th>
  );

  // Bookmarks
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [bookmarkTags, setBookmarkTags] = useState<Record<string, string[]>>({});
  const [showBookmarked, setShowBookmarked] = useState(false);
  const [bookmarkedSessions, setBookmarkedSessions] = useState<Session[]>([]);

  // Today's activity feed
  const [todaySessions, setTodaySessions] = useState<Session[]>([]);
  const [todayLoading, setTodayLoading] = useState(true);
  const [feedOpen, setFeedOpen] = useState(false);

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

  // Commits
  const [commitEntries, setCommitEntries] = useState<CommitEntry[]>([]);
  const [commitsTotal, setCommitsTotal] = useState(0);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsOffset, setCommitsOffset] = useState(0);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitSort, setCommitSort] = useState<CommitSort>('date');

  // Compare
  const [compareIds, setCompareIds] = useState<string[]>([]);

  // Merge
  const [merging, setMerging] = useState(false);

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

  // ── Fetch today's sessions for activity feed ──────────────────────
  useEffect(() => {
    setTodayLoading(true);
    const params = new URLSearchParams();
    params.set('mine', 'true');
    params.set('limit', '50');
    params.set('offset', '0');
    request<{ sessions: Session[]; total: number }>(`/api/sessions?${params.toString()}`)
      .then((data) => {
        const todayStr = new Date().toDateString();
        setTodaySessions(
          data.sessions.filter((s) => new Date(s.startedAt || s.createdAt).toDateString() === todayStr)
        );
      })
      .catch(() => {})
      .finally(() => setTodayLoading(false));
  }, []);

  // ── Fetch commits ───────────────────────────────────────────────────
  useEffect(() => {
    setCommitsLoading(true);
    const params = new URLSearchParams();
    params.set('limit', '50');
    params.set('offset', String(commitsOffset));
    params.set('sort', commitSort);
    request<{ commits: CommitEntry[]; total: number }>(`/api/stats/me/commits?${params.toString()}`)
      .then((data) => {
        setCommitEntries(data.commits);
        setCommitsTotal(data.total);
      })
      .catch(() => {})
      .finally(() => setCommitsLoading(false));
  }, [commitsOffset, commitSort]);

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

  // Merge sessions
  const handleMerge = async () => {
    if (compareIds.length < 2 || merging) return;
    // Check: no running sessions
    const selected = sessions.filter((s) => compareIds.includes(s.id));
    if (selected.some((s) => s.status === 'RUNNING')) {
      alert('Cannot merge running sessions. Wait for them to complete.');
      return;
    }
    setMerging(true);
    try {
      const res = await request<{ mergedSessionId: string }>('/api/sessions/merge', {
        method: 'POST',
        body: JSON.stringify({ sessionIds: compareIds }),
      });
      setCompareIds([]);
      navigate(`/sessions/${res.mergedSessionId}`);
    } catch (err: any) {
      alert(err.message || 'Failed to merge sessions');
    } finally {
      setMerging(false);
    }
  };

  // Filter sessions by search text
  const filteredSessions = useMemo(() => {
    const list = showBookmarked ? bookmarkedSessions : sortedSessions;
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (s) =>
        (s.model || '').toLowerCase().includes(q) ||
        (s.agentName || '').toLowerCase().includes(q) ||
        (s.repoName || '').toLowerCase().includes(q) ||
        (s.branch || '').toLowerCase().includes(q),
    );
  }, [sortedSessions, bookmarkedSessions, showBookmarked, search]);

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

  // Tabs — preserve the selection across reloads so users don't get dumped
  // back on "sessions" after refreshing on a commits-tab bug report etc.
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem('origin:dashboard-tab') as Tab | null;
      if (saved && TABS.some((t) => t.key === saved)) return saved;
    } catch { /* ignore */ }
    return 'timeline';
  });
  useEffect(() => {
    try { localStorage.setItem('origin:dashboard-tab', tab); } catch { /* ignore */ }
  }, [tab]);

  // Lazy fetch per-tab data so we don't hammer the API for tabs the user
  // never opens. Same gating pattern the original dashboard used before
  // the split accidentally dropped these effects.
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

  useEffect(() => {
    if (tab !== 'patterns' || patterns) return;
    setPatternsLoading(true);
    request<CodingPatterns>('/api/stats/me/patterns')
      .then(setPatterns)
      .catch(() => {})
      .finally(() => setPatternsLoading(false));
  }, [tab, patterns]);

  useEffect(() => {
    if (tab !== 'efficiency' || efficiency) return;
    setEfficiencyLoading(true);
    request<Efficiency>('/api/stats/me/efficiency')
      .then(setEfficiency)
      .catch(() => {})
      .finally(() => setEfficiencyLoading(false));
  }, [tab, efficiency]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPromptSearchDebounced(promptSearch);
      setPromptsOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [promptSearch]);

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

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-100">Insights</h1>
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

      {/* Quick Start Guide — always visible until dismissed */}
      {showGuide && (
        <div className="rounded-xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                <Terminal className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-100">Get Started with Origin</h2>
                <p className="text-sm text-gray-500">Set up session tracking in under 2 minutes</p>
              </div>
            </div>
            {/* Always show the close button — users who already know the
                ropes shouldn't have to produce a session just to dismiss the
                onboarding card. */}
            <button
              onClick={() => { setHideGuide(true); try { localStorage.setItem('origin:hide-guide', '1'); } catch { /* ignore */ } }}
              className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
              title="Dismiss"
              aria-label="Dismiss onboarding card"
            >
              <X className="w-4 h-4" />
            </button>
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
                <a href="/api-keys" className="text-emerald-400 hover:text-emerald-300 underline">API Keys</a>
                {' '}&rarr; create a key and copy it &mdash; you&apos;ll need it next.
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
                <div><span className="text-gray-500">$</span> origin login --key YOUR_KEY</div>
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
        <StatCardsRow stats={stats} fmt={fmt} fmtCost={fmtCost} />
      ) : null}

      {/* Today's Activity feed — collapsible */}
      {(todayLoading || todaySessions.length > 0) && (
        <div className="rounded-xl border border-gray-800/80 bg-gray-900/30 overflow-hidden">
          <button
            onClick={() => setFeedOpen(prev => !prev)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-900/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
                What did AI write today?
              </span>
            </div>
            <div className="flex items-center gap-2">
              {!todayLoading && todaySessions.length > 0 && (
                <span className="text-[11px] text-gray-600">
                  {todaySessions.length} session{todaySessions.length !== 1 ? 's' : ''}
                  {' · '}
                  {fmtCost(todaySessions.reduce((sum, s) => sum + s.costUsd, 0))} total
                </span>
              )}
              {feedOpen ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
            </div>
          </button>
          {feedOpen && (
            <div className="px-4 pb-3">
              <TodayActivityFeed
                sessions={todaySessions}
                loading={todayLoading}
                navigate={navigate}
              />
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div data-tour="dashboard-tabs" className="flex items-center gap-1 border-b border-gray-800 pb-0 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            data-tour={`tab-${t.key}`}
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

      {tab === 'timeline' && (
        <TimelineTab
          timelineLoading={timelineLoading}
          timelineSessions={timelineSessions}
          navigate={navigate}
        />
      )}

      {tab === 'agents' && (
        <AgentsTab
          agentsLoading={agentsLoading}
          agentCards={agentCards}
        />
      )}

      {tab === 'stats' && (
        <StatsTab
          statsLoading={statsLoading}
          stats={stats}
        />
      )}

      {tab === 'patterns' && (
        <PatternsTab
          patternsLoading={patternsLoading}
          patterns={patterns}
        />
      )}

      {tab === 'efficiency' && (
        <EfficiencyTab
          efficiencyLoading={efficiencyLoading}
          efficiency={efficiency}
        />
      )}

      {tab === 'prompts' && (
        <PromptsTab
          promptSearch={promptSearch}
          setPromptSearch={setPromptSearch}
          promptsTotal={promptsTotal}
          promptsLoading={promptsLoading}
          promptEntries={promptEntries}
          expandedPrompt={expandedPrompt}
          setExpandedPrompt={setExpandedPrompt}
          promptSearchDebounced={promptSearchDebounced}
          promptsOffset={promptsOffset}
          setPromptsOffset={setPromptsOffset}
          navigate={navigate}
        />
      )}

      {tab === 'commits' && (
        <CommitsTab
          commitsTotal={commitsTotal}
          commitSort={commitSort}
          setCommitSort={setCommitSort}
          setCommitsOffset={setCommitsOffset}
          commitsLoading={commitsLoading}
          commitEntries={commitEntries}
          expandedCommit={expandedCommit}
          setExpandedCommit={setExpandedCommit}
          commitsOffset={commitsOffset}
          navigate={navigate}
        />
      )}

    </div>
  );
}
