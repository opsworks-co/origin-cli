import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { SessionStreamEvent } from '../api';
import { useAuth } from '../context/AuthContext';
import { request } from '../api/_client';
import {
  Radio,
  Zap,
  DollarSign,
  Clock,
  Bot,
  FolderGit2,
  GitBranch,
  ArrowRight,
  Wifi,
  WifiOff,
  Activity,
  FileCode,
  Pause,
  Play,
  Trash2,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

interface ActiveSession {
  id: string;
  model: string;
  agentName: string | null;
  repoName: string | null;
  branch: string | null;
  status: string;
  costUsd: number;
  tokensUsed: number;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  toolCalls: number;
  filesChanged: string;
  createdAt: string;
  startedAt: string | null;
  userId?: string;
  userName?: string;
}

interface FeedEvent {
  id: string;
  type: string;
  sessionId?: string;
  timestamp: string;
  data?: Record<string, unknown>;
  // Enriched after fetch
  agentName?: string;
  repoName?: string;
  model?: string;
  costUsd?: number;
  tokensUsed?: number;
  durationMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtCost(n: number) {
  return `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function liveTimer(startedAt: string | null, createdAt: string) {
  const start = new Date(startedAt || createdAt).getTime();
  return Date.now() - start;
}

function timeAgo(ts: string) {
  const ms = Date.now() - new Date(ts).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// Agent color map
const AGENT_COLORS: Record<string, string> = {
  'claude': '#a78bfa',
  'cursor': '#60a5fa',
  'gemini': '#fbbf24',
  'codex': '#34d399',
  'copilot': '#818cf8',
  'windsurf': '#22d3ee',
  'aider': '#f97316',
};

function agentColor(name: string | null) {
  if (!name) return '#6b7280';
  const lower = name.toLowerCase();
  for (const [key, color] of Object.entries(AGENT_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return '#8b5cf6';
}

// Event type styling
function eventIcon(type: string) {
  switch (type) {
    case 'session:started': return { icon: Play, color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'Started' };
    case 'session:updated': return { icon: Activity, color: 'text-indigo-400', bg: 'bg-indigo-500/10', label: 'Activity' };
    case 'session:ended': return { icon: Pause, color: 'text-amber-400', bg: 'bg-amber-500/10', label: 'Ended' };
    case 'session:reviewed': return { icon: FileCode, color: 'text-cyan-400', bg: 'bg-cyan-500/10', label: 'Reviewed' };
    default: return { icon: Zap, color: 'text-gray-400', bg: 'bg-gray-500/10', label: type };
  }
}

// ── Active Session Card ──────────────────────────────────────────────────────

function ActiveSessionCard({ session, navigate }: { session: ActiveSession; navigate: (to: string) => void }) {
  const [elapsed, setElapsed] = useState(liveTimer(session.startedAt, session.createdAt));

  // Live timer tick
  useEffect(() => {
    if (session.status !== 'RUNNING') return;
    const iv = setInterval(() => setElapsed(liveTimer(session.startedAt, session.createdAt)), 1000);
    return () => clearInterval(iv);
  }, [session.startedAt, session.createdAt, session.status]);

  const color = agentColor(session.agentName);
  const isIdle = session.status === 'IDLE';

  return (
    <button
      onClick={() => navigate(`/sessions/${session.id}`)}
      className="w-full text-left rounded-xl border border-white/[0.08] bg-gray-900/50 hover:bg-gray-900/80 hover:border-white/[0.12] transition-all overflow-hidden group"
    >
      {/* Live indicator bar */}
      <div className="h-0.5 w-full" style={{ backgroundColor: isIdle ? '#6b7280' : color }}>
        {!isIdle && (
          <div className="h-full animate-pulse" style={{ backgroundColor: color, width: '100%' }} />
        )}
      </div>

      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: isIdle ? '#6b7280' : color }} />
            <span className="text-sm font-semibold text-gray-200">{session.agentName || session.model}</span>
            {isIdle && <span className="text-[10px] text-gray-500 px-1.5 py-0.5 rounded bg-gray-800">IDLE</span>}
          </div>
          <span className="text-xs font-mono text-gray-400 tabular-nums">{fmtDuration(elapsed)}</span>
        </div>

        {/* Repo + branch */}
        {session.repoName && (
          <div className="flex items-center gap-2 mb-3 text-xs text-gray-500">
            <FolderGit2 className="w-3 h-3" />
            <span className="truncate">{session.repoName}</span>
            {session.branch && (
              <>
                <GitBranch className="w-3 h-3 ml-1" />
                <span className="truncate">{session.branch}</span>
              </>
            )}
          </div>
        )}

        {/* Live metrics */}
        <div className="grid grid-cols-4 gap-3">
          <div>
            <p className="text-[10px] text-gray-600 uppercase">Tokens</p>
            <p className="text-sm font-medium text-gray-300 tabular-nums">{fmt(session.tokensUsed)}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-600 uppercase">Cost</p>
            <p className="text-sm font-medium text-gray-300 tabular-nums">{fmtCost(session.costUsd)}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-600 uppercase">Tools</p>
            <p className="text-sm font-medium text-gray-300 tabular-nums">{session.toolCalls}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-600 uppercase">Lines</p>
            <p className="text-sm font-medium text-gray-300 tabular-nums">
              <span className="text-emerald-400">+{session.linesAdded}</span>
              <span className="text-gray-600">/</span>
              <span className="text-red-400">-{session.linesRemoved}</span>
            </p>
          </div>
        </div>
      </div>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function LiveFeed() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [connected, setConnected] = useState(false);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const feedBottomRef = useRef<HTMLDivElement>(null);

  // Aggregate live stats
  const totalCost = activeSessions.reduce((s, a) => s + a.costUsd, 0);
  const totalTokens = activeSessions.reduce((s, a) => s + a.tokensUsed, 0);

  // ── Fetch active sessions ─────────────────────────────────────────────
  const fetchActive = useCallback(async () => {
    try {
      const data = await request<{ sessions: ActiveSession[] }>('/api/sessions/active');
      setActiveSessions(data.sessions || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchActive(); }, [fetchActive]);

  // Refresh active sessions every 5s for live metrics
  useEffect(() => {
    const iv = setInterval(fetchActive, 5000);
    return () => clearInterval(iv);
  }, [fetchActive]);

  // ── SSE stream ────────────────────────────────────────────────────────
  useEffect(() => {
    const es = api.createSessionStream((event: SessionStreamEvent) => {
      if (event.type === 'connected') {
        setConnected(true);
        return;
      }

      // Add to feed
      if (!paused) {
        const feedItem: FeedEvent = {
          id: `${event.type}-${event.sessionId}-${Date.now()}`,
          type: event.type,
          sessionId: event.sessionId,
          timestamp: event.timestamp || new Date().toISOString(),
          data: event.data,
          agentName: event.data?.agentSlug as string,
          repoName: event.data?.repoPath as string,
          model: event.data?.model as string,
          costUsd: event.data?.costUsd as number,
          tokensUsed: event.data?.tokensUsed as number,
          durationMs: event.data?.durationMs as number,
        };
        setFeedEvents(prev => [feedItem, ...prev].slice(0, 100));
      }

      // Refresh active sessions on start/end
      if (event.type === 'session:started' || event.type === 'session:ended') {
        fetchActive();
      }
    });

    eventSourceRef.current = es;
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [fetchActive, paused]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-gray-100">Live Feed</h1>
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              connected
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
              {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {connected ? 'Connected' : 'Disconnected'}
            </div>
          </div>
          <p className="text-sm text-gray-500 mt-0.5">
            Real-time AI coding sessions &middot; {activeSessions.length} active
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Live aggregates */}
          {activeSessions.length > 0 && (
            <div className="hidden sm:flex items-center gap-4 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Zap className="w-3 h-3 text-purple-400" />
                {fmt(totalTokens)} tokens
              </span>
              <span className="flex items-center gap-1">
                <DollarSign className="w-3 h-3 text-cyan-400" />
                {fmtCost(totalCost)} spent
              </span>
            </div>
          )}

          {/* Pause/Resume feed */}
          <button
            onClick={() => setPaused(!paused)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              paused
                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                : 'bg-gray-800 text-gray-400 border border-white/[0.06] hover:text-gray-200'
            }`}
          >
            {paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>

      {/* ── Active Sessions Grid ───────────────────────────────────────── */}
      {activeSessions.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
            Active Now
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeSessions.map(session => (
              <ActiveSessionCard key={session.id} session={session} navigate={navigate} />
            ))}
          </div>
        </div>
      )}

      {/* ── Empty State ────────────────────────────────────────────────── */}
      {!loading && activeSessions.length === 0 && feedEvents.length === 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-gray-900/30 p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-gray-800/50 flex items-center justify-center mx-auto mb-4">
            <Radio className="w-7 h-7 text-gray-600" />
          </div>
          <h2 className="text-lg font-semibold text-gray-300 mb-2">No active sessions</h2>
          <p className="text-sm text-gray-500 max-w-md mx-auto">
            Start an AI coding agent in a project with <code className="text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded text-xs">origin init</code> — it'll appear here in real time.
          </p>
        </div>
      )}

      {/* ── Event Feed ─────────────────────────────────────────────────── */}
      {feedEvents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
              <Activity className="w-3 h-3" />
              Event Log
            </h2>
            <button
              onClick={() => setFeedEvents([])}
              className="text-[11px] text-gray-600 hover:text-gray-400 flex items-center gap-1 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </button>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-gray-950/50 overflow-hidden">
            <div className="max-h-[400px] overflow-y-auto">
              {feedEvents.map((event) => {
                const ev = eventIcon(event.type);
                const Icon = ev.icon;
                return (
                  <div
                    key={event.id}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02] transition-colors"
                  >
                    {/* Icon */}
                    <div className={`w-7 h-7 rounded-lg ${ev.bg} flex items-center justify-center shrink-0`}>
                      <Icon className={`w-3.5 h-3.5 ${ev.color}`} />
                    </div>

                    {/* Event info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium ${ev.color}`}>{ev.label}</span>
                        {event.agentName && (
                          <span className="text-xs text-gray-400">{event.agentName}</span>
                        )}
                        {event.model && (
                          <span className="text-[11px] text-gray-600">{event.model}</span>
                        )}
                      </div>
                      {event.repoName && (
                        <p className="text-[11px] text-gray-600 truncate">{event.repoName}</p>
                      )}
                      {event.type === 'session:ended' && event.costUsd != null && (
                        <p className="text-[11px] text-gray-500">
                          {fmtCost(event.costUsd)} &middot; {fmt(event.tokensUsed || 0)} tokens &middot; {fmtDuration(event.durationMs || 0)}
                        </p>
                      )}
                    </div>

                    {/* Timestamp + link */}
                    <span className="text-[11px] text-gray-600 shrink-0">{timeAgo(event.timestamp)}</span>
                    {event.sessionId && (
                      <button
                        onClick={() => navigate(`/sessions/${event.sessionId}`)}
                        className="p-1 rounded text-gray-600 hover:text-indigo-400 transition-colors shrink-0"
                      >
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div ref={feedBottomRef} />
        </div>
      )}
    </div>
  );
}
