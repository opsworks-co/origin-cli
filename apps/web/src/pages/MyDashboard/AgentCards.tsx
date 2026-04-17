import { Bot } from 'lucide-react';
import { AgentCard, agentColor, fmt, fmtCost, fmtDuration, timeAgo } from './utils';

// ── Agent Cards ─────────────────────────────────────────────────────────────

export function AgentCards({ agents }: { agents: AgentCard[] }) {
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
