import { useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { Session, agentColor, buildSessionSummary, fmtCost, timeAgo } from './utils';
import { displayAgentName } from '../../utils';

// Build a 2-3 sentence narrative summary of today's activity. No LLM call —
// just a deterministic roll-up of the session data we already have.
function buildTodaySummary(sessions: Session[]): { headline: string; details: string } | null {
  if (sessions.length === 0) return null;

  const totalCost = sessions.reduce((s, x) => s + (x.costUsd || 0), 0);
  const totalTokens = sessions.reduce((s, x) => s + (x.tokensUsed || 0), 0);
  const totalAdded = sessions.reduce((s, x) => s + (x.linesAdded || 0), 0);
  const totalRemoved = sessions.reduce((s, x) => s + (x.linesRemoved || 0), 0);

  // Agent share
  const byAgent = new Map<string, number>();
  for (const s of sessions) {
    const k = displayAgentName(s.agentName) || s.model || 'AI';
    byAgent.set(k, (byAgent.get(k) || 0) + 1);
  }
  const topAgents = Array.from(byAgent.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k);

  // Repos touched
  const repos = new Set<string>();
  for (const s of sessions) if (s.repoName) repos.add(s.repoName);

  // Most-edited files
  const fileCount = new Map<string, number>();
  for (const s of sessions) {
    let files: string[] = [];
    try { files = JSON.parse(s.filesChanged) || []; } catch { /* ignore */ }
    for (const f of files) fileCount.set(f, (fileCount.get(f) || 0) + 1);
  }
  const topFiles = Array.from(fileCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([f]) => f.split('/').pop() || f);

  const sessionsWord = sessions.length === 1 ? 'session' : 'sessions';
  const repoWord = repos.size === 1 ? 'repo' : 'repos';
  const agentList = topAgents.join(' and ');
  const headline = `${sessions.length} AI ${sessionsWord} today${
    agentList ? ` via ${agentList}` : ''
  }${repos.size > 0 ? ` across ${repos.size} ${repoWord}` : ''}.`;

  const detailParts: string[] = [];
  if (totalAdded > 0 || totalRemoved > 0) {
    detailParts.push(
      `+${totalAdded.toLocaleString()} / −${totalRemoved.toLocaleString()} lines`
    );
  }
  if (totalTokens > 0) {
    detailParts.push(`${(totalTokens / 1000).toFixed(0)}K tokens`);
  }
  if (totalCost > 0) {
    detailParts.push(fmtCost(totalCost));
  }
  if (topFiles.length > 0) {
    detailParts.push(`mostly ${topFiles.join(', ')}`);
  }
  const details = detailParts.join(' · ');

  return { headline, details };
}

// ── Today's Activity Feed ───────────────────────────────────────────────────

export function TodayActivityFeed({
  sessions,
  loading,
  navigate,
}: {
  sessions: Session[];
  loading: boolean;
  navigate: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-10 bg-gray-800/50 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (sessions.length === 0) return null;

  const sorted = [...sessions].sort(
    (a, b) =>
      new Date(b.startedAt || b.createdAt).getTime() -
      new Date(a.startedAt || a.createdAt).getTime()
  );

  const summary = useMemo(() => buildTodaySummary(sessions), [sessions]);

  function buildLabel(s: Session): string {
    const agent = displayAgentName(s.agentName) || s.model.split('/').pop()?.split('-').slice(0, 2).join('-') || 'AI';
    let files: string[] = [];
    try { files = JSON.parse(s.filesChanged); } catch { /* ignore */ }

    if (s.linesAdded > 0 && files[0]) {
      return `${agent} wrote ${s.linesAdded} line${s.linesAdded !== 1 ? 's' : ''} in ${files[0].split('/').pop()}`;
    }
    if (files.length > 0 && s.repoName) {
      return `${agent} edited ${files.length} file${files.length !== 1 ? 's' : ''} in ${s.repoName}`;
    }
    if (s.repoName) return `${agent} session in ${s.repoName}`;
    return `${agent} session`;
  }

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div className="space-y-3">
      {/* Generated summary — narrative roll-up of today's activity. */}
      {summary && (
        <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-2.5">
          <p className="text-xs text-gray-200 leading-relaxed">{summary.headline}</p>
          {summary.details && (
            <p className="text-[11px] text-gray-500 mt-1 font-mono">{summary.details}</p>
          )}
        </div>
      )}

      <div className="space-y-1">
      {sorted.map((s) => {
        const color = agentColor(s.agentName);
        const label = buildLabel(s);
        const isRunning = s.status === 'RUNNING';
        const isOpen = expanded.has(s.id);
        const summary = buildSessionSummary(s);

        return (
          <div key={s.id} className="rounded-lg bg-gray-900/40 border border-gray-800/60 overflow-hidden">
            {/* Compact row */}
            <button
              onClick={() => toggle(s.id)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-900/70 transition-all text-left group"
            >
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              <span className="flex-1 text-xs text-gray-300 truncate group-hover:text-gray-100 transition-colors">
                {label}
              </span>
              <div className="flex items-center gap-2 flex-shrink-0 text-[11px] text-gray-500">
                {s.costUsd > 0 && <span className="font-medium text-gray-400">{fmtCost(s.costUsd)}</span>}
                {isRunning ? (
                  <span className="text-green-400 font-medium flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
                    live
                  </span>
                ) : (
                  <span>{timeAgo(s.startedAt || s.createdAt)}</span>
                )}
                {isOpen ? <ChevronUp className="w-3 h-3 text-gray-500" /> : <ChevronDown className="w-3 h-3 text-gray-500" />}
              </div>
            </button>

            {/* Expanded detail */}
            {isOpen && (
              <div className="px-3 pb-3 pt-0 border-t border-gray-800/40">
                <p className="text-xs text-gray-400 mt-2 leading-relaxed">{summary}</p>
                <div className="flex items-center gap-3 mt-2 text-[11px] text-gray-500">
                  {s.tokensUsed > 0 && <span>{(s.tokensUsed / 1000).toFixed(0)}K tokens</span>}
                  {s.linesAdded > 0 && <span className="text-green-500/70">+{s.linesAdded}</span>}
                  {s.linesRemoved > 0 && <span className="text-red-500/70">-{s.linesRemoved}</span>}
                  {s.model && <span>{s.model.split('/').pop()}</span>}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); navigate(`/sessions/${s.id}`); }}
                  className="mt-2 text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                >
                  View full session <ArrowRight className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
