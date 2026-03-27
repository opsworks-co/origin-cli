import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { Machine, Agent, IntegrationConfig } from '../api';
import { timeAgo } from '../utils';
import { Server, Bot, Plug, HeartPulse, Trash2, RefreshCw } from 'lucide-react';
import KpiCard from '../components/KpiCard';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

export default function Infrastructure() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    Promise.all([
      api.getMachines(),
      api.getAgents().then((data: any) => data.agents || data || []),
      api.getIntegrations().catch(() => []),
    ])
      .then(([m, a, integ]) => {
        setMachines(m);
        setAgents(a);
        setIntegrations(integ);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  const isOnline = (lastSeen: string) =>
    (Date.now() - new Date(lastSeen).getTime()) < 1000 * 60 * 30;

  const onlineCount = machines.filter(m => isOnline(m.lastSeenAt)).length;

  const handleDeleteMachine = async (id: string) => {
    setDeleteTarget(null);
    try {
      await api.deleteMachine(id);
      toast('success', 'Machine removed');
      setMachines(prev => prev.filter(x => x.id !== id));
    } catch (err: any) {
      toast('error', err.message || 'Failed to delete machine');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Infrastructure</h1>
        <p className="text-sm text-gray-500 mt-1">
          Machines, integrations, and agents connected to your org
        </p>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard label="Machines" value={machines.length} icon={Server} subtext={`${onlineCount} online`} />
        <KpiCard label="Agents" value={agents.length} icon={Bot} color="purple" subtext={`${agents.filter(a => a.status === 'ACTIVE').length} active`} />
        <KpiCard label="Integrations" value={integrations.length} icon={Plug} subtext={integrations.length > 0 ? integrations.map(i => i.provider).join(', ') : 'None connected'} />
        <KpiCard label="Status" value={onlineCount > 0 ? 'Healthy' : 'Idle'} icon={HeartPulse} color={onlineCount > 0 ? 'green' : 'default'} subtext={onlineCount > 0 ? `${onlineCount} machine${onlineCount !== 1 ? 's' : ''} reporting` : 'No recent activity'} />
      </div>

      {/* Machines */}
      <div>
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Machines</h2>
        {machines.length === 0 ? (
          <div className="card text-center py-8">
            <p className="text-gray-400 mb-2">No machines registered</p>
            <p className="text-sm text-gray-500">
              Run <code className="text-indigo-400 bg-gray-800 px-1.5 py-0.5 rounded text-xs">origin init</code> on a developer machine to register it.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {machines.map((m) => {
              const online = isOnline(m.lastSeenAt);
              const tools: string[] = (() => {
                try { return JSON.parse(m.detectedTools); } catch { return []; }
              })();
              return (
                <div
                  key={m.id}
                  className="card hover:border-gray-700 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    {/* Status + hostname */}
                    <Link to={`/machines/${m.id}`} className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`h-2 w-2 rounded-full flex-shrink-0 ${online ? 'bg-green-500' : 'bg-gray-600'}`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-200 truncate">{m.hostname}</p>
                        <p className="text-xs text-gray-500 font-mono truncate">{m.machineId}</p>
                      </div>
                    </Link>

                    {/* Tools */}
                    <div className="hidden sm:flex flex-wrap gap-1 max-w-[300px]">
                      {tools.slice(0, 4).map((tool, i) => (
                        <span key={i} className="text-xs bg-gray-800 text-gray-400 rounded px-1.5 py-0.5">
                          {tool}
                        </span>
                      ))}
                      {tools.length > 4 && (
                        <span className="text-xs text-gray-600">+{tools.length - 4}</span>
                      )}
                    </div>

                    {/* Last seen */}
                    <div className="text-right flex-shrink-0">
                      <span className={`text-xs ${online ? 'text-green-400' : 'text-gray-500'}`}>
                        {online ? 'Online' : timeAgo(m.lastSeenAt)}
                      </span>
                    </div>

                    {/* Delete */}
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        setDeleteTarget({ id: m.id, name: m.hostname });
                      }}
                      className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0 p-1"
                      title="Remove machine"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Agents */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Agents</h2>
          <Link to="/agents" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            Manage agents &rarr;
          </Link>
        </div>
        {agents.length === 0 ? (
          <div className="card text-center py-8">
            <p className="text-gray-400 mb-2">No agents configured</p>
            <p className="text-sm text-gray-500">
              Create an agent in the <Link to="/agents" className="text-indigo-400 hover:text-indigo-300">Agents</Link> page.
            </p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {agents.map((a) => (
              <Link
                key={a.id}
                to={`/agents/${a.id}`}
                className="card hover:border-gray-700 transition-colors block"
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-200">{a.name}</p>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                        a.status === 'ACTIVE' ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'
                      }`}>
                        {a.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 font-mono">{a.slug} &middot; {a.model}</p>
                  </div>
                  {a.sessions && a.sessions.length > 0 && (
                    <span className="text-xs text-gray-500">
                      {a.sessions.length} session{a.sessions.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Integrations */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Integrations</h2>
          <Link to="/settings" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            Settings &rarr;
          </Link>
        </div>
        <div className="card space-y-3">
          {(['github', 'gitlab', 'slack', 'llm', 'email'] as const).map((provider) => {
            const connected = integrations.some(i => i.provider === provider);
            const labels: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', slack: 'Slack', llm: 'LLM (Claude)', email: 'Email (Resend)' };
            return (
              <div key={provider} className="flex items-center gap-2">
                <span className="text-sm text-gray-300 w-32">{labels[provider] || provider}</span>
                {connected ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">Connected</span>
                ) : (
                  <Link to="/settings?tab=integrations" className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors">
                    Set up &rarr;
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove Machine"
        message={`Remove "${deleteTarget?.name}" from your organization?`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => deleteTarget && handleDeleteMachine(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
