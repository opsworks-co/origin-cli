import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { Machine, Agent, IntegrationConfig } from '../api';
import { timeAgo } from '../utils';

export default function Infrastructure() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
        <div className="card">
          <p className="text-xs text-gray-500 mb-1">Machines</p>
          <p className="text-2xl font-bold text-gray-100">{machines.length}</p>
          <p className="text-xs text-gray-500 mt-0.5">{onlineCount} online</p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-500 mb-1">Agents</p>
          <p className="text-2xl font-bold text-gray-100">{agents.length}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {agents.filter(a => a.status === 'ACTIVE').length} active
          </p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-500 mb-1">Integrations</p>
          <p className="text-2xl font-bold text-gray-100">{integrations.length}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {integrations.some(i => i.provider === 'github') ? 'GitHub connected' : 'None connected'}
          </p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-500 mb-1">Status</p>
          <p className="text-2xl font-bold text-green-400">
            {onlineCount > 0 ? 'Healthy' : 'Idle'}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {onlineCount > 0 ? `${onlineCount} machine${onlineCount !== 1 ? 's' : ''} reporting` : 'No recent activity'}
          </p>
        </div>
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
                      onClick={async (e) => {
                        e.preventDefault();
                        if (!confirm(`Remove machine "${m.hostname}"?`)) return;
                        try {
                          await api.deleteMachine(m.id);
                          setMachines(prev => prev.filter(x => x.id !== m.id));
                        } catch (err: any) {
                          setError(err.message || 'Failed to delete machine');
                        }
                      }}
                      className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0 p-1"
                      title="Remove machine"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
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
        <div className="card">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-300">GitHub</span>
              {integrations.some(i => i.provider === 'github') ? (
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">Connected</span>
              ) : (
                <Link to="/settings" className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors">
                  Set up &rarr;
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
