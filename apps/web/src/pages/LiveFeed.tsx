import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { SessionStreamEvent } from '../api';
import { request } from '../api/_client';
import {
  Radio,
  Zap,
  DollarSign,
  FolderGit2,
  GitBranch,
  GitCommit,
  ArrowUpRight,
  Wifi,
  WifiOff,
  Activity,
  Pause,
  Play,
  Trash2,
  MessageSquare,
  Terminal,
  FileText,
  ChevronDown,
  ChevronUp,
  FileCode,
  Clock,
  Code2,
  ExternalLink,
  Archive,
  CheckCircle2,
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
}

interface PromptChange {
  promptIndex: number;
  promptText: string;
  filesChanged: string; // JSON array
  diff: string;
  uncommittedDiff: string;
}

interface SessionDetail {
  id: string;
  prompt?: string;
  model?: string;
  agentName?: string;
  repoName?: string;
  branch?: string;
  status?: string;
  costUsd?: number;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  linesAdded?: number;
  linesRemoved?: number;
  toolCalls?: number;
  durationMs?: number;
  createdAt?: string;
  promptChanges?: PromptChange[];
}

interface SessionActivity {
  id: string;
  type: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}
function fmtCost(n: number) { return `$${n.toFixed(2)}`; }
function fmtDuration(ms: number) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function liveTimer(startedAt: string | null, createdAt: string) {
  return Date.now() - new Date(startedAt || createdAt).getTime();
}
function timeAgo(ts: string) {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const AGENT_COLORS: Record<string, string> = {
  'claude': '#a78bfa', 'cursor': '#60a5fa', 'gemini': '#fbbf24',
  'codex': '#34d399', 'copilot': '#818cf8', 'windsurf': '#22d3ee', 'aider': '#f97316',
};
function agentColor(name: string | null) {
  if (!name) return '#6b7280';
  const l = name.toLowerCase();
  for (const [k, c] of Object.entries(AGENT_COLORS)) { if (l.includes(k)) return c; }
  return '#8b5cf6';
}

function parseFiles(json: string): string[] {
  try { const arr = JSON.parse(json); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

// Parse transcript (JSON array of {role, content} or raw text) into displayable lines
interface TranscriptTurn { role: string; content: string }
function parseTranscript(raw: string): TranscriptTurn[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].role) {
      return parsed as TranscriptTurn[];
    }
    // Could be a single object
    if (parsed.role && parsed.content) return [parsed as TranscriptTurn];
  } catch { /* not JSON — treat as raw text */ }
  return null;
}

// ── Diff renderer ───────────────────────────────────────────────────────────

function DiffBlock({ diff }: { diff: string }) {
  if (!diff || diff === '(no diff captured)') {
    return <p className="text-[11px] text-gray-600 italic py-1">No diff captured</p>;
  }
  const lines = diff.split('\n').slice(0, 60);
  const truncated = diff.split('\n').length > 60;
  return (
    <div className="font-mono text-[11px] leading-relaxed overflow-x-auto max-h-[240px] overflow-y-auto">
      {lines.map((line, i) => {
        let cls = 'text-gray-500';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-500/5';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-500/5';
        else if (line.startsWith('@@')) cls = 'text-indigo-400';
        else if (line.startsWith('diff ')) cls = 'text-gray-400 font-semibold';
        return (
          <div key={i} className={`px-2 whitespace-pre ${cls}`}>
            {line}
          </div>
        );
      })}
      {truncated && <div className="px-2 text-gray-600 italic">... truncated</div>}
    </div>
  );
}

// ── Inline prompt card ──────────────────────────────────────────────────────

function PromptCard({ pc, index }: { pc: PromptChange; index: number }) {
  const [showDiff, setShowDiff] = useState(false);
  const files = parseFiles(pc.filesChanged);
  const hasDiff = pc.diff && pc.diff.length > 0;

  return (
    <div className="border border-white/[0.06] rounded-lg bg-gray-950/40 overflow-hidden">
      {/* Prompt header */}
      <div className="px-3 py-2 flex items-start gap-2.5">
        <div className="w-6 h-6 rounded-full bg-indigo-500/15 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-[10px] font-bold text-indigo-400">{index + 1}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-gray-300 leading-relaxed">
            {pc.promptText || <span className="italic text-gray-600">No prompt text</span>}
          </p>
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {files.slice(0, 8).map((f, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400/80 font-mono truncate max-w-[200px]">
                  {f.split('/').pop()}
                </span>
              ))}
              {files.length > 8 && <span className="text-[10px] text-gray-600">+{files.length - 8} more</span>}
            </div>
          )}
        </div>
        <span className="text-[10px] text-gray-600 shrink-0">{files.length} file{files.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Diff toggle + content */}
      {hasDiff && (
        <>
          <button
            onClick={() => setShowDiff(!showDiff)}
            className="w-full flex items-center gap-2 px-3 py-1.5 border-t border-white/[0.04] text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
          >
            <Code2 className="w-3 h-3" />
            <span>{showDiff ? 'Hide diff' : 'Show diff'}</span>
            {showDiff ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
          </button>
          {showDiff && (
            <div className="border-t border-white/[0.04] bg-gray-950/60">
              <DiffBlock diff={pc.diff} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Activity item renderer ───────────────────────────────────────────────────

function ActivityItem({ event }: { event: SessionActivity }) {
  const d = event.data || {};

  switch (event.type) {
    case 'session:prompt':
      return (
        <div className="flex items-start gap-2.5 py-2 px-3">
          <MessageSquare className="w-3.5 h-3.5 text-indigo-400 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-gray-300 leading-relaxed">
              <span className="text-indigo-400 font-medium">Prompt #{((d.promptIndex as number) ?? 0) + 1}</span>
              {typeof d.promptText === 'string' && (
                <span className="text-gray-500 ml-1.5">"{d.promptText.slice(0, 100)}{d.promptText.length > 100 ? '...' : ''}"</span>
              )}
            </p>
            {Array.isArray(d.filesChanged) && (d.filesChanged as string[]).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {(d.filesChanged as string[]).slice(0, 5).map((f, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400/80 font-mono truncate max-w-[200px]">
                    {f.split('/').pop()}
                  </span>
                ))}
                {(d.filesChanged as string[]).length > 5 && (
                  <span className="text-[10px] text-gray-600">+{(d.filesChanged as string[]).length - 5} more</span>
                )}
              </div>
            )}
          </div>
          <span className="text-[10px] text-gray-600 shrink-0">{timeAgo(event.timestamp)}</span>
        </div>
      );

    case 'session:metrics':
      return (
        <div className="flex items-center gap-2.5 py-1.5 px-3">
          <Activity className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <div className="flex items-center gap-3 text-[11px] text-gray-500">
            {d.tokensUsed != null && <span><Zap className="w-2.5 h-2.5 inline text-purple-400" /> {fmt(d.tokensUsed as number)}</span>}
            {d.costUsd != null && <span><DollarSign className="w-2.5 h-2.5 inline text-cyan-400" /> {fmtCost(d.costUsd as number)}</span>}
            {(d.linesAdded != null || d.linesRemoved != null) && (
              <span>
                <span className="text-emerald-400">+{Number(d.linesAdded) || 0}</span>
                <span className="text-gray-600">/</span>
                <span className="text-red-400">-{Number(d.linesRemoved) || 0}</span>
              </span>
            )}
          </div>
          <span className="text-[10px] text-gray-600 ml-auto shrink-0">{timeAgo(event.timestamp)}</span>
        </div>
      );

    case 'session:files':
      return (
        <div className="flex items-start gap-2.5 py-1.5 px-3">
          <FileText className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
          <div className="flex flex-wrap gap-1 min-w-0 flex-1">
            {Array.isArray(d.files) && (d.files as string[]).slice(0, 8).map((f, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400/80 font-mono truncate max-w-[180px]">
                {f.split('/').pop()}
              </span>
            ))}
            {Array.isArray(d.files) && (d.files as string[]).length > 8 && (
              <span className="text-[10px] text-gray-600">+{(d.files as string[]).length - 8} more</span>
            )}
          </div>
          <span className="text-[10px] text-gray-600 shrink-0">{timeAgo(event.timestamp)}</span>
        </div>
      );

    case 'session:commit':
      return (
        <div className="flex items-center gap-2.5 py-2 px-3">
          <GitCommit className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-gray-300">
              <span className="font-mono text-emerald-400 text-[11px]">{String(d.sha || '')}</span>
              <span className="text-gray-500 ml-1.5">{String(d.message || '').slice(0, 80)}</span>
            </p>
            {d.filesChanged != null && (
              <p className="text-[10px] text-gray-600 mt-0.5">{Number(d.filesChanged)} files changed</p>
            )}
          </div>
          <span className="text-[10px] text-gray-600 shrink-0">{timeAgo(event.timestamp)}</span>
        </div>
      );

    default:
      return null;
  }
}

// ── Active Session Card (expandable with inline detail) ─────────────────────

function ActiveSessionCard({
  session,
  activities,
  output,
  onOutputLoaded,
}: {
  session: ActiveSession;
  activities: SessionActivity[];
  output: string;
  onOutputLoaded?: (sessionId: string, transcript: string) => void;
}) {
  const [elapsed, setElapsed] = useState(liveTimer(session.startedAt, session.createdAt));
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<'prompts' | 'console' | 'activity'>('console');
  const consoleRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll console to bottom when new output arrives
  useEffect(() => {
    if (consoleRef.current && activeTab === 'console') {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [output, activeTab]);

  useEffect(() => {
    if (session.status !== 'RUNNING') return;
    const iv = setInterval(() => setElapsed(liveTimer(session.startedAt, session.createdAt)), 1000);
    return () => clearInterval(iv);
  }, [session.startedAt, session.createdAt, session.status]);

  // Fetch session detail (with prompt changes + transcript) when expanded
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const load = async () => {
      setLoadingDetail(true);
      try {
        const data = await request<SessionDetail & { transcript?: string }>(`/api/sessions/${session.id}`);
        if (!cancelled) {
          setDetail(data);
          // Seed console output from stored transcript if no SSE output yet
          if (data.transcript && !output && onOutputLoaded) {
            onOutputLoaded(session.id, data.transcript);
          }
        }
      } catch {}
      if (!cancelled) setLoadingDetail(false);
    };
    load();
    // Refresh detail every 8s while expanded
    const iv = setInterval(load, 8000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [expanded, session.id]);

  const color = agentColor(session.agentName);
  const isIdle = session.status === 'IDLE';
  const prompts = detail?.promptChanges || [];

  return (
    <div className={`rounded-xl border overflow-hidden transition-all ${
      expanded ? 'border-white/[0.12] bg-gray-900/70 col-span-full' : 'border-white/[0.08] bg-gray-900/50'
    }`}>
      {/* Color bar */}
      <div className="h-1 w-full relative" style={{ backgroundColor: `${color}33` }}>
        {!isIdle && (
          <div className="h-full animate-pulse rounded-full" style={{ backgroundColor: color, width: '100%' }} />
        )}
      </div>

      {/* Header — click to expand inline */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 pt-3 pb-2 hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2.5">
            <div className="w-2.5 h-2.5 rounded-full relative" style={{ backgroundColor: isIdle ? '#6b7280' : color }}>
              {!isIdle && <div className="absolute inset-0 rounded-full animate-ping opacity-30" style={{ backgroundColor: color }} />}
            </div>
            <span className="text-sm font-semibold text-gray-200">{session.agentName || session.model}</span>
            {isIdle && <span className="text-[10px] text-gray-500 px-1.5 py-0.5 rounded bg-gray-800 font-medium">IDLE</span>}
            {!isIdle && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ backgroundColor: `${color}15`, color }}>RUNNING</span>}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-gray-400 tabular-nums">{fmtDuration(elapsed)}</span>
            {expanded ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
          </div>
        </div>

        {/* Repo + branch */}
        {session.repoName && (
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
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
            <p className="text-sm font-medium tabular-nums">
              <span className="text-emerald-400">+{session.linesAdded}</span>
              <span className="text-gray-600">/</span>
              <span className="text-red-400">-{session.linesRemoved}</span>
            </p>
          </div>
        </div>
      </button>

      {/* ── Expanded inline detail ──────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-white/[0.06]">
          {/* Tab bar */}
          <div className="flex items-center justify-between px-4 border-b border-white/[0.06]">
            <div className="flex gap-0">
              {([
                { key: 'console' as const, label: 'Console', icon: Terminal, color: 'text-emerald-400' },
                { key: 'prompts' as const, label: `Prompts (${prompts.length})`, icon: MessageSquare, color: 'text-indigo-400' },
                { key: 'activity' as const, label: `Activity (${activities.length})`, icon: Activity, color: 'text-purple-400' },
              ] as const).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors border-b-2 ${
                    activeTab === tab.key
                      ? `${tab.color} border-current`
                      : 'text-gray-600 border-transparent hover:text-gray-400'
                  }`}
                >
                  <tab.icon className="w-3 h-3" />
                  {tab.label}
                </button>
              ))}
            </div>
            <Link
              to={`/sessions/${session.id}`}
              className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
            >
              Full session <ExternalLink className="w-3 h-3" />
            </Link>
          </div>

          {/* Console output */}
          {activeTab === 'console' && (
            <div className="bg-gray-950/80">
              {output ? (() => {
                const turns = parseTranscript(output);
                if (turns) {
                  // Structured conversation view
                  return (
                    <div ref={consoleRef} className="max-h-[420px] overflow-y-auto p-3 space-y-3">
                      {turns.map((turn, i) => {
                        const isUser = turn.role === 'user' || turn.role === 'human';
                        const isSystem = turn.role === 'system';
                        const content = typeof turn.content === 'string'
                          ? turn.content
                          : JSON.stringify(turn.content);
                        return (
                          <div key={i} className={`rounded-lg px-3 py-2 ${
                            isUser
                              ? 'bg-indigo-500/10 border border-indigo-500/20'
                              : isSystem
                                ? 'bg-gray-800/50 border border-gray-700/30'
                                : 'bg-gray-900/50 border border-white/[0.04]'
                          }`}>
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`text-[10px] font-bold uppercase tracking-wider ${
                                isUser ? 'text-indigo-400' : isSystem ? 'text-gray-500' : 'text-emerald-400'
                              }`}>
                                {isUser ? '▶ You' : isSystem ? '⚙ System' : '◀ Agent'}
                              </span>
                            </div>
                            <div className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap font-mono">
                              {content.split('\n').map((line, j) => {
                                let cls = '';
                                if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400/80';
                                else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400/80';
                                else if (line.startsWith('@@')) cls = 'text-indigo-400/80';
                                return <div key={j} className={cls}>{line || '\u00a0'}</div>;
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                }
                // Raw text fallback
                return (
                  <div
                    ref={consoleRef}
                    className="max-h-[420px] overflow-y-auto overflow-x-auto p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-gray-400"
                  >
                    {output.split('\n').map((line, i) => {
                      let cls = 'text-gray-400';
                      if (line.startsWith('> ') || line.startsWith('$ ')) cls = 'text-emerald-400';
                      else if (line.startsWith('Error') || line.startsWith('error')) cls = 'text-red-400';
                      else if (line.match(/^(Human|User|human|user):/i)) cls = 'text-indigo-400 font-semibold';
                      else if (line.match(/^(Assistant|assistant|Claude|claude):/i)) cls = 'text-cyan-400';
                      else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400/70';
                      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400/70';
                      return <div key={i} className={cls}>{line || '\u00a0'}</div>;
                    })}
                  </div>
                );
              })() : (
                <div className="text-center py-10">
                  <Terminal className="w-6 h-6 text-gray-700 mx-auto mb-2" />
                  <p className="text-xs text-gray-600">Waiting for agent output...</p>
                  <p className="text-[10px] text-gray-700 mt-1">Console output streams here as the agent works</p>
                </div>
              )}
            </div>
          )}

          {/* Prompts & diffs */}
          {activeTab === 'prompts' && (
            <div className="p-4">
              {loadingDetail && prompts.length === 0 && (
                <div className="flex items-center justify-center py-8">
                  <div className="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-400 rounded-full animate-spin" />
                </div>
              )}

              {prompts.length === 0 && !loadingDetail && (
                <div className="text-center py-6">
                  <Clock className="w-5 h-5 text-gray-700 mx-auto mb-2" />
                  <p className="text-xs text-gray-600">Waiting for first prompt...</p>
                </div>
              )}

              <div className="space-y-2">
                {prompts
                  .sort((a, b) => b.promptIndex - a.promptIndex)
                  .map(pc => (
                    <PromptCard key={pc.promptIndex} pc={pc} index={pc.promptIndex} />
                  ))}
              </div>
            </div>
          )}

          {/* Live activity stream */}
          {activeTab === 'activity' && (
            <div className="p-0">
              {activities.length === 0 ? (
                <div className="text-center py-8">
                  <Radio className="w-5 h-5 text-gray-700 mx-auto mb-2" />
                  <p className="text-xs text-gray-600">Waiting for events...</p>
                </div>
              ) : (
                <div className="max-h-[400px] overflow-y-auto divide-y divide-white/[0.03]">
                  {activities.slice(0, 30).map(event => (
                    <ActivityItem key={event.id} event={event} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Collapsed: show activity count hint */}
      {!expanded && activities.length > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-1.5 border-t border-white/[0.04] text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
        >
          <Activity className="w-3 h-3" />
          <span>{activities.length} event{activities.length !== 1 ? 's' : ''} — click to expand</span>
        </button>
      )}
    </div>
  );
}

// ── Global Event Log item styling ───────────────────────────────────────────

function eventStyle(type: string) {
  switch (type) {
    case 'session:started': return { icon: Play, color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'Session Started' };
    case 'session:ended': return { icon: Pause, color: 'text-amber-400', bg: 'bg-amber-500/10', label: 'Session Ended' };
    case 'session:prompt': return { icon: MessageSquare, color: 'text-indigo-400', bg: 'bg-indigo-500/10', label: 'Prompt' };
    case 'session:commit': return { icon: GitCommit, color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'Commit' };
    case 'session:metrics': return { icon: Activity, color: 'text-purple-400', bg: 'bg-purple-500/10', label: 'Metrics' };
    case 'session:files': return { icon: FileText, color: 'text-amber-400', bg: 'bg-amber-500/10', label: 'Files' };
    default: return { icon: Zap, color: 'text-gray-400', bg: 'bg-gray-500/10', label: type.replace('session:', '') };
  }
}

// ── Archived (ended) session card ──────────────────────────────────────────

interface ArchivedSession {
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
  endedAt: string | null;
  createdAt: string;
}

function ArchivedSessionCard({ session }: { session: ArchivedSession }) {
  const color = agentColor(session.agentName);
  return (
    <Link
      to={`/sessions/${session.id}`}
      className="flex items-center gap-4 px-4 py-3 border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02] transition-colors group"
    >
      {/* Agent dot + name */}
      <div className="flex items-center gap-2.5 min-w-[140px]">
        <div className="w-2 h-2 rounded-full opacity-50" style={{ backgroundColor: color }} />
        <span className="text-sm font-medium text-gray-300 group-hover:text-gray-100 transition-colors">
          {session.agentName || session.model}
        </span>
      </div>

      {/* Repo */}
      <div className="flex items-center gap-1.5 text-xs text-gray-500 min-w-0 flex-1">
        <FolderGit2 className="w-3 h-3 shrink-0" />
        <span className="truncate">{session.repoName || '—'}</span>
        {session.branch && (
          <>
            <GitBranch className="w-3 h-3 ml-1 shrink-0" />
            <span className="truncate">{session.branch}</span>
          </>
        )}
      </div>

      {/* Metrics */}
      <div className="hidden sm:flex items-center gap-4 text-xs text-gray-500 shrink-0">
        <span className="tabular-nums w-16 text-right">{fmt(session.tokensUsed)}</span>
        <span className="tabular-nums w-14 text-right">{fmtCost(session.costUsd)}</span>
        <span className="tabular-nums w-14 text-right">{fmtDuration(session.durationMs)}</span>
        <span className="tabular-nums w-16 text-right">
          <span className="text-emerald-400/60">+{session.linesAdded}</span>
          <span className="text-gray-600">/</span>
          <span className="text-red-400/60">-{session.linesRemoved}</span>
        </span>
      </div>

      {/* Time ago */}
      <span className="text-[10px] text-gray-600 shrink-0 w-14 text-right">
        {timeAgo(session.endedAt || session.createdAt)}
      </span>
      <ExternalLink className="w-3 h-3 text-gray-700 group-hover:text-gray-400 shrink-0 transition-colors" />
    </Link>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function LiveFeed() {
  const [connected, setConnected] = useState(false);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSession[]>([]);
  const [sessionActivities, setSessionActivities] = useState<Record<string, SessionActivity[]>>({});
  const [sessionOutputs, setSessionOutputs] = useState<Record<string, string>>({});
  const [globalLog, setGlobalLog] = useState<SessionActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [showAllArchived, setShowAllArchived] = useState(false);

  const totalCost = activeSessions.reduce((s, a) => s + a.costUsd, 0);
  const totalTokens = activeSessions.reduce((s, a) => s + a.tokensUsed, 0);

  // ── Fetch active sessions ─────────────────────────────────────────────
  const fetchActive = useCallback(async () => {
    try {
      const data = await request<{ sessions: ActiveSession[] }>('/api/sessions/active');
      setActiveSessions(data.sessions || []);
    } catch {}
    setLoading(false);
  }, []);

  // ── Fetch recent ended sessions for archive ───────────────────────
  const fetchArchived = useCallback(async () => {
    try {
      const data = await request<{ sessions: ArchivedSession[] }>('/api/sessions?status=COMPLETED&limit=20');
      setArchivedSessions(data.sessions || []);
    } catch {}
  }, []);

  useEffect(() => { fetchActive(); fetchArchived(); }, [fetchActive, fetchArchived]);
  useEffect(() => {
    const iv = setInterval(fetchActive, 5000);
    return () => clearInterval(iv);
  }, [fetchActive]);

  // ── SSE stream ────────────────────────────────────────────────────────
  useEffect(() => {
    const es = api.createSessionStream((event: SessionStreamEvent) => {
      if (event.type === 'connected') { setConnected(true); return; }
      if (paused) return;

      const item: SessionActivity = {
        id: `${event.type}-${event.sessionId}-${Date.now()}-${Math.random()}`,
        type: event.type,
        timestamp: event.timestamp || new Date().toISOString(),
        data: event.data,
      };

      // Add to per-session activity stream
      if (event.sessionId) {
        setSessionActivities(prev => ({
          ...prev,
          [event.sessionId!]: [item, ...(prev[event.sessionId!] || [])].slice(0, 50),
        }));
      }

      // Capture console output
      if (event.type === 'session:output' && event.sessionId && typeof event.data?.output === 'string') {
        setSessionOutputs(prev => ({
          ...prev,
          [event.sessionId!]: event.data!.output as string,
        }));
      }

      // Add significant events to global log (skip noisy metrics/files/output)
      if (['session:started', 'session:ended', 'session:prompt', 'session:commit'].includes(event.type)) {
        setGlobalLog(prev => [{ ...item, data: { ...event.data, sessionId: event.sessionId } }, ...prev].slice(0, 100));
      }

      // Refresh active sessions on lifecycle events
      if (event.type === 'session:started' || event.type === 'session:ended') {
        fetchActive();
      }
      // Refresh archive when a session ends
      if (event.type === 'session:ended') {
        fetchArchived();
      }
    });

    es.onerror = () => setConnected(false);
    return () => es.close();
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
            Real-time AI coding activity &middot; {activeSessions.length} active session{activeSessions.length !== 1 ? 's' : ''}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {activeSessions.length > 0 && (
            <div className="hidden sm:flex items-center gap-4 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Zap className="w-3 h-3 text-purple-400" /> {fmt(totalTokens)} tokens
              </span>
              <span className="flex items-center gap-1">
                <DollarSign className="w-3 h-3 text-cyan-400" /> {fmtCost(totalCost)}
              </span>
            </div>
          )}
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

      {/* ── Active Sessions ──────────────────────────────────────────── */}
      {activeSessions.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
            Active Now
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {activeSessions.map(session => (
              <ActiveSessionCard
                key={session.id}
                session={session}
                activities={sessionActivities[session.id] || []}
                output={sessionOutputs[session.id] || ''}
                onOutputLoaded={(sid, transcript) => setSessionOutputs(prev => ({ ...prev, [sid]: transcript }))}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Ended Sessions Archive ─────────────────────────────────── */}
      {archivedSessions.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
              <Archive className="w-3 h-3 text-gray-500" />
              Recent Sessions
            </h2>
            {archivedSessions.length > 5 && (
              <button
                onClick={() => setShowAllArchived(!showAllArchived)}
                className="text-[11px] text-gray-600 hover:text-gray-400 transition-colors"
              >
                {showAllArchived ? 'Show less' : `Show all (${archivedSessions.length})`}
              </button>
            )}
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-gray-950/50 overflow-hidden">
            {/* Column headers */}
            <div className="flex items-center gap-4 px-4 py-2 border-b border-white/[0.06] text-[10px] text-gray-600 uppercase tracking-wider font-medium">
              <span className="min-w-[140px]">Agent</span>
              <span className="flex-1">Repository</span>
              <div className="hidden sm:flex items-center gap-4 shrink-0">
                <span className="w-16 text-right">Tokens</span>
                <span className="w-14 text-right">Cost</span>
                <span className="w-14 text-right">Duration</span>
                <span className="w-16 text-right">Lines</span>
              </div>
              <span className="w-14 text-right">Ended</span>
              <span className="w-3" />
            </div>
            {(showAllArchived ? archivedSessions : archivedSessions.slice(0, 5)).map(session => (
              <ArchivedSessionCard key={session.id} session={session} />
            ))}
          </div>
        </div>
      )}

      {/* ── Empty state ──────────────────────────────────────────────── */}
      {!loading && activeSessions.length === 0 && archivedSessions.length === 0 && globalLog.length === 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-gray-900/30 p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-gray-800/50 flex items-center justify-center mx-auto mb-4">
            <Radio className="w-7 h-7 text-gray-600" />
          </div>
          <h2 className="text-lg font-semibold text-gray-300 mb-2">Waiting for sessions...</h2>
          <p className="text-sm text-gray-500 max-w-md mx-auto">
            Start an AI coding agent in a project with{' '}
            <code className="text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded text-xs">origin init</code>.
            Prompts, file changes, and commits will appear here in real time.
          </p>
        </div>
      )}

      {/* ── Global Event Log ─────────────────────────────────────────── */}
      {globalLog.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
              <Terminal className="w-3 h-3" />
              Event Log
            </h2>
            <button
              onClick={() => setGlobalLog([])}
              className="text-[11px] text-gray-600 hover:text-gray-400 flex items-center gap-1 transition-colors"
            >
              <Trash2 className="w-3 h-3" /> Clear
            </button>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-gray-950/50 overflow-hidden">
            <div className="max-h-[360px] overflow-y-auto">
              {globalLog.map(event => {
                const ev = eventStyle(event.type);
                const Icon = ev.icon;
                const d = event.data || {};
                return (
                  <div key={event.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02] transition-colors">
                    <div className={`w-7 h-7 rounded-lg ${ev.bg} flex items-center justify-center shrink-0`}>
                      <Icon className={`w-3.5 h-3.5 ${ev.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium ${ev.color}`}>{ev.label}</span>
                        {typeof d.agentSlug === 'string' && <span className="text-xs text-gray-400">{d.agentSlug}</span>}
                        {typeof d.model === 'string' && <span className="text-[11px] text-gray-600">{d.model}</span>}
                      </div>
                      {event.type === 'session:prompt' && typeof d.promptText === 'string' && (
                        <p className="text-[11px] text-gray-500 truncate">{`"${d.promptText.slice(0, 100)}"`}</p>
                      )}
                      {event.type === 'session:commit' && (
                        <p className="text-[11px] text-gray-500 truncate">
                          <span className="font-mono text-emerald-400">{String(d.sha || '')}</span>{' '}
                          {String(d.message || '').slice(0, 60)}
                        </p>
                      )}
                      {event.type === 'session:ended' && d.costUsd != null && (
                        <p className="text-[11px] text-gray-500">
                          {fmtCost(d.costUsd as number)} &middot; {fmt((d.tokensUsed as number) || 0)} tokens &middot; {fmtDuration((d.durationMs as number) || 0)}
                        </p>
                      )}
                      {typeof d.repoPath === 'string' && (
                        <p className="text-[10px] text-gray-600 truncate">{d.repoPath}</p>
                      )}
                    </div>
                    <span className="text-[10px] text-gray-600 shrink-0">{timeAgo(event.timestamp)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
