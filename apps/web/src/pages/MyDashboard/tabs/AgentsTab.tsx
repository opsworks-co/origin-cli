import { AgentCard } from '../utils';
import { AgentCards } from '../AgentCards';

export function AgentsTab({
  agentsLoading,
  agentCards,
}: {
  agentsLoading: boolean;
  agentCards: AgentCard[];
}) {
  return (
        <div data-tour="tab-content-agents">
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
  );
}
