import React, { useMemo } from 'react';
import { ArrowRight, GitBranch } from 'lucide-react';
import { Session, agentColor, dayLabel, fmt, fmtCost, fmtDuration } from './utils';
import { displayAgentName } from '../../utils';

// ── Session Timeline ────────────────────────────────────────────────────────

export function SessionTimeline({ sessions, navigate }: { sessions: Session[]; navigate: (path: string) => void }) {
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
                        Switched from {displayAgentName(prevAgent) || 'Unknown'} to {displayAgentName(s.agentName) || 'Unknown'}
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
                            {displayAgentName(s.agentName) || s.model.split('/').pop()?.split('-').slice(0, 2).join('-')}
                          </span>
                          {s.org && (
                            // Federated view chip — only shown when /api/me/sessions
                            // populated `org`. Lets users tell apart same-named
                            // repos across orgs ("api in Brigada LTD" vs. "api
                            // in Personal").
                            <span className="hidden sm:inline px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 whitespace-nowrap">
                              {s.org.name}
                            </span>
                          )}
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
