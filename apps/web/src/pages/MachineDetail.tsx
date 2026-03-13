import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../api';
import { timeAgo } from '../utils';

type Tab = 'overview' | 'policies';

function parseCondition(conditionJson: string): string {
  try {
    const parsed = JSON.parse(conditionJson);
    if (parsed.path) return `path: ${parsed.path}`;
    if (parsed.models) return `models: ${parsed.models.join(', ')}`;
    if (parsed.max_cost) return `max cost: $${parsed.max_cost}`;
    if (parsed.max_tokens) return `max tokens: ${parsed.max_tokens.toLocaleString()}`;
    if (parsed.cost_above) return `cost > $${parsed.cost_above}`;
    if (parsed.tokens_above) return `tokens > ${parsed.tokens_above.toLocaleString()}`;
    if (parsed.files_above) return `files > ${parsed.files_above}`;
    if (parsed.max_lines) return `lines > ${parsed.max_lines}`;
    if (parsed.max_duration_minutes) return `duration > ${parsed.max_duration_minutes}m`;
    return JSON.stringify(parsed, null, 0);
  } catch { return conditionJson; }
}

const TYPE_BADGE: Record<string, string> = {
  FILE_RESTRICTION: 'bg-red-900/30 text-red-400',
  REQUIRE_REVIEW: 'bg-amber-900/30 text-amber-400',
  MODEL_ALLOWLIST: 'bg-blue-900/30 text-blue-400',
  COST_LIMIT: 'bg-purple-900/30 text-purple-400',
};

const CONDITION_HELP: Record<string, { placeholder: string; examples: string[] }> = {
  FILE_RESTRICTION: {
    placeholder: '{"path": "**/.env"}',
    examples: ['{"path": "**/.env"} \u2014 Block .env files', '{"path": "src/auth/**"} \u2014 Block auth dir'],
  },
  REQUIRE_REVIEW: {
    placeholder: '{"cost_above": 1.0}',
    examples: ['{"cost_above": 1.0} \u2014 Flag if cost > $1', '{"tokens_above": 50000} \u2014 Flag if tokens > 50k'],
  },
  MODEL_ALLOWLIST: {
    placeholder: '{"models": ["claude-sonnet-4-20250514"]}',
    examples: ['{"models": ["claude-sonnet-4-20250514"]} \u2014 Only Sonnet'],
  },
  COST_LIMIT: {
    placeholder: '{"max_cost": 5.0}',
    examples: ['{"max_cost": 5.0} \u2014 Limit $5 per session'],
  },
};

export default function MachineDetail() {
  const { id } = useParams<{ id: string }>();
  const [machine, setMachine] = useState<api.MachineDetail | null>(null);
  const [policies, setPolicies] = useState<api.Policy[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Add rule form state
  const [showAddRule, setShowAddRule] = useState(false);
  const [addRulePolicyId, setAddRulePolicyId] = useState('');
  const [addRuleCondition, setAddRuleCondition] = useState('');
  const [addRuleAction, setAddRuleAction] = useState('block');
  const [addRuleSeverity, setAddRuleSeverity] = useState('MEDIUM');
  const [addingRule, setAddingRule] = useState(false);

  const loadData = () => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      api.getMachine(id),
      api.getPolicies().catch(() => [] as api.Policy[]),
    ])
      .then(([m, pol]) => {
        setMachine(m);
        setPolicies(pol);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (!machine) {
    return <div className="text-center py-12 text-gray-500">Machine not found</div>;
  }

  const detectedTools: string[] = (() => {
    try { return JSON.parse(machine.detectedTools); } catch { return []; }
  })();

  // Machine-scoped rules from the machine detail endpoint
  const machineRules = (machine.policyRules || []).map((rule) => ({
    ...rule,
    policyName: rule.policy?.name ?? 'Unknown',
    policyType: rule.policy?.type ?? '',
    policyActive: rule.policy?.active ?? true,
  }));

  // Org-wide rules (no machine/agent/repo scope)
  const orgWideRules: Array<api.PolicyRule & { policyName: string; policyType: string; policyActive: boolean }> = [];
  for (const policy of policies) {
    for (const rule of (policy.rules || [])) {
      if (!rule.machineId && !rule.agentId && !rule.repoId) {
        orgWideRules.push({
          ...rule,
          policyName: policy.name,
          policyType: policy.type,
          policyActive: policy.active,
        });
      }
    }
  }

  const handleAddMachineRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addRulePolicyId) return;
    try { JSON.parse(addRuleCondition); } catch {
      setError('Condition must be valid JSON');
      return;
    }
    setAddingRule(true);
    try {
      await api.createPolicyRule(addRulePolicyId, {
        condition: addRuleCondition,
        action: addRuleAction,
        severity: addRuleSeverity,
        machineId: id,
      });
      setShowAddRule(false);
      setAddRuleCondition('');
      setAddRuleAction('block');
      setAddRuleSeverity('MEDIUM');
      setAddRulePolicyId('');
      setSuccess('Rule added to this machine');
      loadData();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) { setError(err.message); }
    finally { setAddingRule(false); }
  };

  const handleRemoveMachineRule = async (policyId: string, ruleId: string) => {
    if (!confirm('Remove this rule from this machine?')) return;
    try {
      await api.deletePolicyRule(policyId, ruleId);
      setSuccess('Rule removed');
      loadData();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) { setError(err.message); }
  };

  const tabClasses = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      tab === t ? 'bg-indigo-600/20 text-indigo-400' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800/50'
    }`;

  const isOnline = (Date.now() - new Date(machine.lastSeenAt).getTime()) < 1000 * 60 * 30; // 30 min

  return (
    <div className="max-w-4xl mx-auto">
      <Link to="/infrastructure" className="text-sm text-gray-400 hover:text-gray-200 mb-4 inline-block">&larr; Back to Infrastructure</Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{machine.hostname}</h1>
            <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${
              isOnline ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${isOnline ? 'bg-green-500' : 'bg-gray-500'}`} />
              {isOnline ? 'Online' : 'Offline'}
            </span>
          </div>
          <p className="text-gray-500 text-sm mt-1 font-mono">{machine.machineId}</p>
        </div>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm mb-4">{error}</div>
      )}
      {success && (
        <div className="card bg-green-900/20 border-green-800 text-green-400 text-sm mb-4">{success}</div>
      )}

      <div className="flex gap-2 mb-6">
        <button onClick={() => setTab('overview')} className={tabClasses('overview')}>
          Overview
        </button>
        <button onClick={() => setTab('policies')} className={tabClasses('policies')}>
          Policies ({machineRules.length})
        </button>
      </div>

      {/* Overview Tab */}
      {tab === 'overview' && (
        <div className="space-y-6">
          {/* Machine Info */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-4">Machine Info</h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500 mb-1">Hostname</p>
                <p className="text-sm text-gray-200">{machine.hostname}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Machine ID</p>
                <p className="text-sm text-gray-200 font-mono">{machine.machineId}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Last Seen</p>
                <p className="text-sm text-gray-200">{timeAgo(machine.lastSeenAt)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Registered</p>
                <p className="text-sm text-gray-200">{new Date(machine.createdAt).toLocaleDateString()}</p>
              </div>
            </div>
          </div>

          {/* Detected Tools */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Detected Tools</h3>
            <p className="text-xs text-gray-500 mb-3">AI coding tools found on this machine during registration.</p>
            {detectedTools.length === 0 ? (
              <p className="text-sm text-gray-500">No tools detected.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {detectedTools.map((tool, i) => (
                  <span key={i} className="inline-flex items-center text-xs bg-indigo-900/20 border border-indigo-800/50 text-indigo-300 rounded-full px-3 py-1">
                    {tool}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Policy Summary */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Policy Summary</h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500 mb-1">Machine-scoped rules</p>
                <p className="text-2xl font-bold text-gray-100">{machineRules.length}</p>
                <p className="text-xs text-gray-500 mt-0.5">rules targeting this machine specifically</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Org-wide rules</p>
                <p className="text-2xl font-bold text-gray-100">{orgWideRules.length}</p>
                <p className="text-xs text-gray-500 mt-0.5">rules that apply to all machines</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Policies Tab */}
      {tab === 'policies' && (
        <div className="space-y-6">
          {/* Machine-specific rules */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-300">Rules targeting this machine</h3>
              <button
                onClick={() => {
                  setShowAddRule(!showAddRule);
                  if (policies.length > 0 && !addRulePolicyId) setAddRulePolicyId(policies[0].id);
                }}
                className="btn-primary text-xs py-1.5"
              >
                {showAddRule ? 'Cancel' : 'Add Rule'}
              </button>
            </div>

            {/* Add rule form */}
            {showAddRule && (
              <form onSubmit={handleAddMachineRule} className="card space-y-3 mb-4">
                <h4 className="text-sm font-medium text-gray-300">New rule for {machine.hostname}</h4>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Policy</label>
                  <select
                    value={addRulePolicyId}
                    onChange={(e) => setAddRulePolicyId(e.target.value)}
                    className="select w-full text-sm"
                    required
                  >
                    <option value="">Select a policy...</option>
                    {policies.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.type.replace(/_/g, ' ')})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-gray-400 mb-1">Condition (JSON)</label>
                  <input
                    required
                    value={addRuleCondition}
                    onChange={(e) => setAddRuleCondition(e.target.value)}
                    className="input text-sm font-mono w-full"
                    placeholder={addRulePolicyId
                      ? CONDITION_HELP[policies.find(p => p.id === addRulePolicyId)?.type || '']?.placeholder || '{}'
                      : '{}'}
                  />
                </div>

                {/* Quick examples */}
                {addRulePolicyId && CONDITION_HELP[policies.find(p => p.id === addRulePolicyId)?.type || ''] && (
                  <div className="flex flex-wrap gap-1.5">
                    {CONDITION_HELP[policies.find(p => p.id === addRulePolicyId)?.type || '']?.examples.map((ex, i) => {
                      const [json, desc] = ex.split(' \u2014 ');
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setAddRuleCondition(json.trim())}
                          className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded px-2 py-1 transition-colors"
                        >
                          <code className="text-indigo-400">{json.trim()}</code>
                          {desc && <span className="text-gray-500 ml-1">{desc}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Action</label>
                    <select value={addRuleAction} onChange={e => setAddRuleAction(e.target.value)} className="select text-sm">
                      <option value="block">block</option>
                      <option value="warn">warn</option>
                      <option value="require_review">require_review</option>
                      <option value="notify">notify</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Severity</label>
                    <select value={addRuleSeverity} onChange={e => setAddRuleSeverity(e.target.value)} className="select text-sm">
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                    </select>
                  </div>
                </div>

                <button type="submit" disabled={addingRule} className="btn-primary text-sm py-1.5">
                  {addingRule ? 'Adding...' : 'Add Rule'}
                </button>
              </form>
            )}

            {machineRules.length === 0 ? (
              <div className="card text-center py-6">
                <p className="text-gray-500 text-sm">No policy rules scoped to this machine yet.</p>
                <p className="text-gray-600 text-xs mt-1">Add a rule to enforce specific governance for {machine.hostname}.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {machineRules.map(rule => (
                  <div key={rule.id} className="card py-3 flex items-center gap-2 flex-wrap">
                    <Link
                      to={`/policies/${rule.policyId}`}
                      className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      {rule.policyName}
                    </Link>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${TYPE_BADGE[rule.policyType] || 'bg-gray-800 text-gray-400'}`}>
                      {rule.policyType.replace(/_/g, ' ')}
                    </span>
                    <span className="text-gray-600 text-xs">IF</span>
                    <code className="text-indigo-400 text-xs">{parseCondition(rule.condition)}</code>
                    <span className="text-gray-600 text-xs">THEN</span>
                    <code className={`text-xs font-medium ${
                      rule.action === 'block' ? 'text-red-400'
                        : rule.action === 'require_review' ? 'text-amber-400'
                          : rule.action === 'warn' ? 'text-yellow-400' : 'text-blue-400'
                    }`}>{rule.action}</code>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      rule.severity === 'HIGH' ? 'bg-red-900/30 text-red-400'
                        : rule.severity === 'MEDIUM' ? 'bg-amber-900/30 text-amber-400' : 'bg-gray-800 text-gray-400'
                    }`}>{rule.severity}</span>
                    {!rule.policyActive && (
                      <span className="text-xs text-gray-600 bg-gray-800 rounded px-1.5 py-0.5">policy inactive</span>
                    )}
                    <button
                      onClick={() => handleRemoveMachineRule(rule.policyId, rule.id)}
                      className="ml-auto text-red-500 hover:text-red-400 hover:bg-red-900/30 rounded px-1.5 py-0.5 text-xs font-bold transition-colors"
                      title="Remove rule"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Org-wide rules that also apply */}
          {orgWideRules.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-3">
                Org-wide rules <span className="text-gray-500 font-normal">(also apply to this machine)</span>
              </h3>
              <div className="space-y-2">
                {orgWideRules.map(rule => (
                  <div key={rule.id} className="card py-3 flex items-center gap-2 flex-wrap opacity-70">
                    <Link
                      to={`/policies/${rule.policyId}`}
                      className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      {rule.policyName}
                    </Link>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${TYPE_BADGE[rule.policyType] || 'bg-gray-800 text-gray-400'}`}>
                      {rule.policyType.replace(/_/g, ' ')}
                    </span>
                    <span className="text-gray-600 text-xs">IF</span>
                    <code className="text-indigo-400 text-xs">{parseCondition(rule.condition)}</code>
                    <span className="text-gray-600 text-xs">THEN</span>
                    <code className={`text-xs font-medium ${
                      rule.action === 'block' ? 'text-red-400'
                        : rule.action === 'require_review' ? 'text-amber-400'
                          : rule.action === 'warn' ? 'text-yellow-400' : 'text-blue-400'
                    }`}>{rule.action}</code>
                    <span className="text-xs text-gray-600 ml-auto">org-wide</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
