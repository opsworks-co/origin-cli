import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../api';
import VersionHistory from '../components/VersionHistory';

type Tab = 'rules' | 'agents' | 'versions';

export default function PolicyDetail() {
  const { id } = useParams<{ id: string }>();
  const [policy, setPolicy] = useState<api.Policy | null>(null);
  const [versions, setVersions] = useState<api.PolicyVersion[]>([]);
  const [agents, setAgents] = useState<api.Agent[]>([]);
  const [tab, setTab] = useState<Tab>('rules');
  const [loading, setLoading] = useState(true);

  // Assignment state
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const loadData = () => {
    if (!id) return;
    Promise.all([
      api.getPolicies().then(ps => setPolicy(ps.find(p => p.id === id) || null)),
      api.getPolicyVersions(id).then(r => setVersions(r.versions)),
      api.getAgents().then(setAgents).catch(() => []),
    ]).finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, [id]);

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!policy) return <div className="text-center py-12 text-gray-500">Policy not found</div>;

  const assignedAgentIds = new Set((policy.assignments || []).map(a => a.agent.id));

  const handleToggleAgent = async (agentId: string) => {
    if (!id) return;
    setSaving(true);
    setError('');
    try {
      const newIds = assignedAgentIds.has(agentId)
        ? [...assignedAgentIds].filter(aid => aid !== agentId)
        : [...assignedAgentIds, agentId];
      await api.updatePolicyAssignments(id, newIds);
      setSuccess('Agent assignments updated');
      loadData();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleAssignAll = async () => {
    if (!id) return;
    setSaving(true);
    setError('');
    try {
      await api.updatePolicyAssignments(id, agents.map(a => a.id));
      setSuccess('All agents assigned');
      loadData();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleClearAll = async () => {
    if (!id) return;
    setSaving(true);
    setError('');
    try {
      await api.updatePolicyAssignments(id, []);
      setSuccess('All assignments removed — policy is now org-wide');
      loadData();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  };

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

      {/* Scope badge */}
      <div className="mb-4">
        {assignedAgentIds.size === 0 ? (
          <span className="text-xs px-2 py-1 rounded-full bg-gray-700 text-gray-400">
            Org-wide — applies to all agents
          </span>
        ) : (
          <span className="text-xs px-2 py-1 rounded-full bg-indigo-500/20 text-indigo-400">
            Assigned to {assignedAgentIds.size} agent{assignedAgentIds.size !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm mb-4">{error}</div>
      )}
      {success && (
        <div className="card bg-green-900/20 border-green-800 text-green-400 text-sm mb-4">{success}</div>
      )}

      <div className="flex gap-2 mb-6">
        <button onClick={() => setTab('rules')} className={tabClasses('rules')}>
          Rules ({policy.rules.length})
        </button>
        <button onClick={() => setTab('agents')} className={tabClasses('agents')}>
          Agents ({assignedAgentIds.size})
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

      {tab === 'agents' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-300">Assign Agents</h3>
                <p className="text-xs text-gray-500 mt-1">
                  Select which agents this policy applies to. If no agents are selected, the policy applies org-wide to all agents.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAssignAll}
                  disabled={saving || agents.length === 0}
                  className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors disabled:opacity-50"
                >
                  Assign All
                </button>
                <button
                  onClick={handleClearAll}
                  disabled={saving || assignedAgentIds.size === 0}
                  className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors disabled:opacity-50"
                >
                  Clear All
                </button>
              </div>
            </div>

            {agents.length === 0 ? (
              <p className="text-gray-500 text-sm py-4 text-center">No agents found. Create agents first.</p>
            ) : (
              <div className="space-y-1">
                {agents.map(agent => {
                  const isAssigned = assignedAgentIds.has(agent.id);
                  return (
                    <button
                      key={agent.id}
                      onClick={() => handleToggleAgent(agent.id)}
                      disabled={saving}
                      className={`w-full flex items-center gap-3 rounded-lg px-4 py-3 transition-colors text-left ${
                        isAssigned
                          ? 'bg-indigo-500/10 border border-indigo-500/30 hover:bg-indigo-500/20'
                          : 'bg-gray-800/30 border border-transparent hover:bg-gray-800/50 hover:border-gray-700'
                      } disabled:opacity-50`}
                    >
                      <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${
                        isAssigned ? 'bg-indigo-500 text-white' : 'bg-gray-700 text-transparent'
                      }`}>
                        {isAssigned && (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-200">{agent.name}</p>
                        <p className="text-xs text-gray-500 truncate">
                          <span className="font-mono">{agent.slug}</span>
                          {' '}&middot;{' '}{agent.model}
                          {agent.status !== 'ACTIVE' && (
                            <span className="text-amber-500 ml-1">({agent.status})</span>
                          )}
                        </p>
                      </div>
                      <span className={`text-xs flex-shrink-0 ${isAssigned ? 'text-indigo-400' : 'text-gray-600'}`}>
                        {isAssigned ? 'Assigned' : 'Not assigned'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Info box about machine propagation */}
          <div className="rounded-lg bg-blue-900/10 border border-blue-800/30 px-4 py-3">
            <p className="text-xs text-blue-400">
              Policies assigned to an agent automatically apply to all machines connected to that agent.
              Developers can see assigned policies by running <code className="bg-blue-900/30 px-1 rounded">origin policies</code>.
            </p>
          </div>
        </div>
      )}

      {tab === 'versions' && <VersionHistory versions={versions} />}
    </div>
  );
}
