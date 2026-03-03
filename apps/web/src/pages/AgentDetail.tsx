import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../api';
import VersionHistory from '../components/VersionHistory';

type Tab = 'sessions' | 'versions';

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<api.Agent | null>(null);
  const [versions, setVersions] = useState<api.AgentVersion[]>([]);
  const [tab, setTab] = useState<Tab>('sessions');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.getAgent(id).then(setAgent),
      api.getAgentVersions(id).then(r => setVersions(r.versions)),
    ]).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!agent) return <div className="text-center py-12 text-gray-500">Agent not found</div>;

  const tabClasses = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      tab === t ? 'bg-indigo-600/20 text-indigo-400' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800/50'
    }`;

  return (
    <div className="max-w-4xl mx-auto">
      <Link to="/agents" className="text-sm text-gray-400 hover:text-gray-200 mb-4 inline-block">&larr; Back to Agents</Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{agent.name}</h1>
          <p className="text-gray-400 text-sm mt-1">
            <span className="font-mono">{agent.slug}</span> &middot; {agent.model}
          </p>
          {agent.description && <p className="text-gray-400 mt-2">{agent.description}</p>}
        </div>
        <span className={`text-xs px-2 py-1 rounded-full ${
          agent.status === 'ACTIVE' ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'
        }`}>
          {agent.status}
        </span>
      </div>

      <div className="flex gap-2 mb-6">
        <button onClick={() => setTab('sessions')} className={tabClasses('sessions')}>
          Recent Sessions ({agent.sessions?.length ?? 0})
        </button>
        <button onClick={() => setTab('versions')} className={tabClasses('versions')}>
          Version History ({versions.length})
        </button>
      </div>

      {tab === 'sessions' && (
        <div className="space-y-3">
          {!agent.sessions?.length ? (
            <p className="text-gray-500 text-sm py-8 text-center">No sessions yet</p>
          ) : (
            agent.sessions.map((s: any) => (
              <Link key={s.id} to={`/sessions/${s.id}`} className="card hover:border-gray-700 transition-colors block">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-200">{s.model}</p>
                    <p className="text-xs text-gray-400 mt-1 truncate max-w-md">{s.prompt || 'No prompt'}</p>
                  </div>
                  <span className="text-xs text-gray-500">{new Date(s.createdAt).toLocaleDateString()}</span>
                </div>
              </Link>
            ))
          )}
        </div>
      )}

      {tab === 'versions' && <VersionHistory versions={versions} />}
    </div>
  );
}
