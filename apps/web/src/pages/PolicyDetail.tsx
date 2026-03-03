import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../api';
import VersionHistory from '../components/VersionHistory';

type Tab = 'rules' | 'versions';

export default function PolicyDetail() {
  const { id } = useParams<{ id: string }>();
  const [policy, setPolicy] = useState<api.Policy | null>(null);
  const [versions, setVersions] = useState<api.PolicyVersion[]>([]);
  const [tab, setTab] = useState<Tab>('rules');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.getPolicies().then(ps => setPolicy(ps.find(p => p.id === id) || null)),
      api.getPolicyVersions(id).then(r => setVersions(r.versions)),
    ]).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!policy) return <div className="text-center py-12 text-gray-500">Policy not found</div>;

  const tabClasses = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      tab === t ? 'bg-indigo-600/20 text-indigo-400' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800/50'
    }`;

  return (
    <div className="max-w-4xl mx-auto">
      <Link to="/policies" className="text-sm text-gray-400 hover:text-gray-200 mb-4 inline-block">&larr; Back to Policies</Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{policy.name}</h1>
          {policy.description && <p className="text-gray-400 mt-1">{policy.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full ${policy.active ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'}`}>
            {policy.active ? 'Active' : 'Inactive'}
          </span>
          <span className="text-xs px-2 py-1 rounded-full bg-gray-700 text-gray-300">{policy.type}</span>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        <button onClick={() => setTab('rules')} className={tabClasses('rules')}>
          Rules ({policy.rules.length})
        </button>
        <button onClick={() => setTab('versions')} className={tabClasses('versions')}>
          Version History ({versions.length})
        </button>
      </div>

      {tab === 'rules' && (
        <div className="space-y-3">
          {policy.rules.length === 0 ? (
            <p className="text-gray-500 text-sm py-8 text-center">No rules configured</p>
          ) : (
            policy.rules.map(rule => (
              <div key={rule.id} className="card">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-200 font-mono">{rule.condition}</p>
                    <p className="text-xs text-gray-400 mt-1">Action: {rule.action}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {rule.agent && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">
                        {rule.agent.name}
                      </span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      rule.severity === 'HIGH' ? 'bg-red-500/20 text-red-400' :
                      rule.severity === 'MEDIUM' ? 'bg-amber-500/20 text-amber-400' :
                      'bg-gray-700 text-gray-400'
                    }`}>
                      {rule.severity}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'versions' && <VersionHistory versions={versions} />}
    </div>
  );
}
