import React, { useState } from 'react';
import { Play, DollarSign, Zap, X, Code2, ChevronDown } from 'lucide-react';
import { MyStats, agentColor } from './utils';
import { displayAgentName } from '../../utils';
import { Trend } from './Trend';

// ── Clickable stat cards with agent breakdown ─────────────────────────────
type StatKey = 'sessions' | 'tokens' | 'cost' | 'lines';

export function StatCardsRow({ stats, fmt, fmtCost }: { stats: MyStats; fmt: (n: number) => string; fmtCost: (n: number) => string }) {
  const [expanded, setExpanded] = useState<StatKey | null>(null);

  const toggle = (key: StatKey) => setExpanded(expanded === key ? null : key);

  const agentValue = (a: MyStats['agentBreakdown'][0], key: StatKey) => {
    switch (key) {
      case 'sessions': return fmt(a.sessions);
      case 'tokens': return fmt(a.tokens);
      case 'cost': return fmtCost(a.cost);
      case 'lines': return `+${fmt(a.linesAdded)} / -${fmt(a.linesRemoved)}`;
    }
  };

  const sorted = (key: StatKey) => [...stats.agentBreakdown].sort((a, b) => {
    switch (key) {
      case 'sessions': return b.sessions - a.sessions;
      case 'tokens': return b.tokens - a.tokens;
      case 'cost': return b.cost - a.cost;
      case 'lines': return b.linesAdded - a.linesAdded;
    }
  });

  const total = (key: StatKey) => {
    switch (key) {
      case 'sessions': return stats.totalSessions;
      case 'tokens': return stats.totalTokens;
      case 'cost': return stats.totalCost;
      case 'lines': return stats.totalLinesAdded;
    }
  };

  const pct = (a: MyStats['agentBreakdown'][0], key: StatKey) => {
    const t = total(key);
    if (!t) return 0;
    const v = key === 'sessions' ? a.sessions : key === 'tokens' ? a.tokens : key === 'cost' ? a.cost : a.linesAdded;
    return (v / t) * 100;
  };

  // ── Gradient stat card (same style used on Insights) ──────────────────
  const renderCard = (
    key: StatKey,
    label: string,
    Icon: React.ComponentType<{ className?: string }>,
    value: React.ReactNode,
    sub: React.ReactNode,
    accent: 'indigo' | 'purple' | 'cyan' | 'amber',
  ) => {
    const accentMap: Record<string, { grad: string; text: string; ring: string }> = {
      indigo: { grad: 'from-indigo-500/20 to-indigo-500/0', text: 'text-indigo-300', ring: 'ring-indigo-500/40' },
      purple: { grad: 'from-purple-500/20 to-purple-500/0', text: 'text-purple-300', ring: 'ring-purple-500/40' },
      cyan:   { grad: 'from-cyan-500/20 to-cyan-500/0',     text: 'text-cyan-300',   ring: 'ring-cyan-500/40' },
      amber:  { grad: 'from-amber-500/20 to-amber-500/0',   text: 'text-amber-300',  ring: 'ring-amber-500/40' },
    };
    const a = accentMap[accent];
    const isActive = expanded === key;
    return (
      <button
        onClick={() => toggle(key)}
        className={`relative rounded-xl border p-4 text-left overflow-hidden transition-all hover:border-gray-700 ${
          isActive ? `border-gray-600 ring-1 ${a.ring}` : 'border-gray-800/80'
        } bg-gray-900/40`}
      >
        <div className={`absolute inset-0 bg-gradient-to-br ${a.grad} opacity-60 pointer-events-none`} />
        <div className="relative">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <Icon className={`w-3 h-3 ${a.text}`} />
              {label}
            </span>
            <ChevronDown
              className={`w-3 h-3 text-gray-600 transition-transform ${isActive ? 'rotate-180' : ''}`}
            />
          </div>
          <div className="text-2xl font-semibold text-gray-50 tabular-nums">{value}</div>
          <div className="text-[11px] text-gray-500 mt-1">{sub}</div>
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-2" data-tour="stat-cards">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {renderCard(
          'sessions',
          'Sessions',
          Play,
          fmt(stats.totalSessions),
          <Trend current={stats.thisWeek.sessions} previous={stats.lastWeek.sessions} />,
          'indigo',
        )}
        {renderCard(
          'tokens',
          'Tokens',
          Zap,
          fmt(stats.totalTokens),
          <Trend current={stats.thisWeek.tokens} previous={stats.lastWeek.tokens} />,
          'purple',
        )}
        {renderCard(
          'cost',
          'Cost',
          DollarSign,
          fmtCost(stats.totalCost),
          <Trend current={stats.thisWeek.cost} previous={stats.lastWeek.cost} />,
          'cyan',
        )}
        {renderCard(
          'lines',
          'Lines Written',
          Code2,
          fmt(stats.totalLinesAdded),
          <>
            <span className="text-emerald-400">+{fmt(stats.totalLinesAdded)}</span>
            {' / '}
            <span className="text-red-400">-{fmt(stats.totalLinesRemoved)}</span>
          </>,
          'amber',
        )}
      </div>

      {/* Agent breakdown panel */}
      {expanded && stats.agentBreakdown.length > 0 && (
        <div className="card py-3 px-4 animate-fade-in">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">By Agent</span>
            <button onClick={() => setExpanded(null)} className="text-gray-600 hover:text-gray-400">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-2">
            {sorted(expanded).map((a, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: agentColor(a.agentName) }} />
                <span className="text-sm text-gray-300 w-28 truncate">{displayAgentName(a.agentName) || a.agentName}</span>
                <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.max(pct(a, expanded), 2)}%`, backgroundColor: agentColor(a.agentName) }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-200 w-24 text-right">{agentValue(a, expanded)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
