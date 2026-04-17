import { useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { Session, agentColor, buildSessionSummary, fmtCost, timeAgo } from './utils';

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

  function buildLabel(s: Session): string {
    const agent = s.agentName || s.model.split('/').pop()?.split('-').slice(0, 2).join('-') || 'AI';
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
  );
}
