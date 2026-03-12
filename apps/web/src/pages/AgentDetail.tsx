import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../api';
import VersionHistory from '../components/VersionHistory';

type Tab = 'config' | 'sessions' | 'policies' | 'versions' | 'members' | 'repos';

function safeParseJson(raw: string | null | undefined, fallback: any): any {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<api.Agent | null>(null);
  const [versions, setVersions] = useState<api.AgentVersion[]>([]);
  const [policies, setPolicies] = useState<api.Policy[]>([]);
  const [tab, setTab] = useState<Tab>('config');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Add rule to agent form state
  const [showAddRule, setShowAddRule] = useState(false);
  const [addRulePolicyId, setAddRulePolicyId] = useState('');
  const [addRuleCondition, setAddRuleCondition] = useState('');
  const [addRuleAction, setAddRuleAction] = useState('block');
  const [addRuleSeverity, setAddRuleSeverity] = useState('MEDIUM');
  const [addingRule, setAddingRule] = useState(false);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editSystemPrompt, setEditSystemPrompt] = useState('');
  const [editAllowedTools, setEditAllowedTools] = useState('');
  const [editMaxCost, setEditMaxCost] = useState('');
  const [editMaxTokens, setEditMaxTokens] = useState('');
  const [editPermissions, setEditPermissions] = useState('');

  // Members state
  const [members, setMembers] = useState<api.AgentMemberUser[]>([]);
  const [orgUsers, setOrgUsers] = useState<{ users: { id: string; name: string; email: string; role: string }[] }>({ users: [] });
  const [membersSaving, setMembersSaving] = useState(false);

  // Repos state
  const [agentRepos, setAgentRepos] = useState<api.AgentRepoAccess[]>([]);
  const [allRepos, setAllRepos] = useState<api.Repo[]>([]);
  const [reposSaving, setReposSaving] = useState(false);

  const loadData = () => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      api.getAgent(id).then(a => {
        setAgent(a);
        populateForm(a);
      }),
      api.getAgentVersions(id).then(r => setVersions(r.versions)),
      api.getPolicies().then(setPolicies).catch(() => {}),
      api.getAgentMembers(id).then(setMembers).catch(() => {}),
      api.getUsers().then(setOrgUsers).catch(() => {}),
      api.getAgentRepos(id).then(setAgentRepos).catch(() => {}),
      api.getRepos().then(setAllRepos).catch(() => {}),
    ])
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  const populateForm = (a: api.Agent) => {
    setEditName(a.name);
    setEditDescription(a.description || '');
    setEditModel(a.model);
    setEditSystemPrompt(a.systemPrompt || '');
    const tools = safeParseJson(a.allowedTools, []);
    setEditAllowedTools(tools.length > 0 ? tools.join('\n') : '');
    setEditMaxCost(a.maxCostPerSession != null ? String(a.maxCostPerSession) : '');
    setEditMaxTokens(a.maxTokensPerSession != null ? String(a.maxTokensPerSession) : '');
    const perms = safeParseJson(a.permissions, {});
    setEditPermissions(Object.keys(perms).length > 0 ? JSON.stringify(perms, null, 2) : '');
  };

  useEffect(() => { loadData(); }, [id]);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      // Validate permissions JSON if provided
      let permissionsObj: Record<string, any> | undefined;
      if (editPermissions.trim()) {
        try {
          permissionsObj = JSON.parse(editPermissions);
        } catch {
          setError('Permissions must be valid JSON');
          setSaving(false);
          return;
        }
      } else {
        permissionsObj = {};
      }

      const toolsList = editAllowedTools.trim()
        ? editAllowedTools.split('\n').map(t => t.trim()).filter(Boolean)
        : [];

      await api.updateAgent(id, {
        name: editName,
        description: editDescription || undefined,
        model: editModel,
        systemPrompt: editSystemPrompt || undefined,
        allowedTools: toolsList,
        maxCostPerSession: editMaxCost ? parseFloat(editMaxCost) : null,
        maxTokensPerSession: editMaxTokens ? parseInt(editMaxTokens) : null,
        permissions: permissionsObj,
      });

      setSuccess('Agent configuration saved. New version created.');
      // Reload data to get latest version
      loadData();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (versionId: string, version: number) => {
    if (!id) return;
    if (!confirm(`Restore agent to version ${version}? This will create a new version with the restored configuration.`)) return;
    setRestoring(true);
    setError('');
    try {
      await api.restoreAgentVersion(id, versionId);
      setSuccess(`Restored to v${version}. New version created.`);
      loadData();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRestoring(false);
    }
  };

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!agent) return <div className="text-center py-12 text-gray-500">Agent not found</div>;

  const latestVersion = versions.length > 0 ? versions[0].version : 0;

  // Compute policies assigned to this agent and policy rules scoped to this agent
  const assignedPolicies: api.Policy[] = [];
  const agentRules: Array<api.PolicyRule & { policyName: string; policyType: string; policyActive: boolean }> = [];
  const orgWideRules: Array<api.PolicyRule & { policyName: string; policyType: string; policyActive: boolean }> = [];
  const assignedPolicyIds = new Set<string>();
  for (const policy of policies) {
    // Check if this policy is assigned to this agent via PolicyAssignment
    const isAssigned = (policy.assignments || []).some(a => a.agent.id === id);
    if (isAssigned) {
      assignedPolicies.push(policy);
      assignedPolicyIds.add(policy.id);
    }
    for (const rule of (policy.rules || [])) {
      const enriched = { ...rule, policyName: policy.name, policyType: policy.type, policyActive: policy.active };
      if (rule.agentId === id) {
        agentRules.push(enriched);
      } else if (!rule.agentId && !isAssigned) {
        // Only show as org-wide if not already shown via assignment
        orgWideRules.push(enriched);
      }
    }
  }

  const CONDITION_HELP: Record<string, { placeholder: string; examples: string[] }> = {
    FILE_RESTRICTION: {
      placeholder: '{"path": "**/.env"}',
      examples: ['{"path": "**/.env"} — Block .env files', '{"path": "src/auth/**"} — Block auth dir'],
    },
    REQUIRE_REVIEW: {
      placeholder: '{"cost_above": 1.0}',
      examples: ['{"cost_above": 1.0} — Flag if cost > $1', '{"tokens_above": 50000} — Flag if tokens > 50k'],
    },
    MODEL_ALLOWLIST: {
      placeholder: '{"models": ["claude-sonnet-4-20250514"]}',
      examples: ['{"models": ["claude-sonnet-4-20250514"]} — Only Sonnet'],
    },
    COST_LIMIT: {
      placeholder: '{"max_cost": 5.0}',
      examples: ['{"max_cost": 5.0} — Limit $5 per session'],
    },
  };

  const TYPE_BADGE: Record<string, string> = {
    FILE_RESTRICTION: 'bg-red-900/30 text-red-400',
    REQUIRE_REVIEW: 'bg-amber-900/30 text-amber-400',
    MODEL_ALLOWLIST: 'bg-blue-900/30 text-blue-400',
    COST_LIMIT: 'bg-purple-900/30 text-purple-400',
  };

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

  const handleAddAgentRule = async (e: React.FormEvent) => {
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
        agentId: id,
      });
      setShowAddRule(false);
      setAddRuleCondition('');
      setAddRuleAction('block');
      setAddRuleSeverity('MEDIUM');
      setAddRulePolicyId('');
      setSuccess('Rule added to this agent');
      loadData();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) { setError(err.message); }
    finally { setAddingRule(false); }
  };

  const handleRemoveAgentRule = async (policyId: string, ruleId: string) => {
    if (!confirm('Remove this rule from this agent?')) return;
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

  return (
    <div className="max-w-4xl mx-auto">
      <Link to="/agents" className="text-sm text-gray-400 hover:text-gray-200 mb-4 inline-block">&larr; Back to Agents</Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{agent.name}</h1>
            <span className="text-xs font-mono text-gray-500 bg-gray-800 px-2 py-0.5 rounded">v{latestVersion}</span>
          </div>
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

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm mb-4">{error}</div>
      )}
      {success && (
        <div className="card bg-green-900/20 border-green-800 text-green-400 text-sm mb-4">{success}</div>
      )}

      <div className="flex gap-2 mb-6">
        <button onClick={() => setTab('config')} className={tabClasses('config')}>
          Configuration
        </button>
        <button onClick={() => setTab('policies')} className={tabClasses('policies')}>
          Policies ({assignedPolicies.length + agentRules.length})
        </button>
        <button onClick={() => setTab('sessions')} className={tabClasses('sessions')}>
          Sessions ({agent.sessions?.length ?? 0})
        </button>
        <button onClick={() => setTab('members')} className={tabClasses('members')}>
          Members ({members.length})
        </button>
        <button onClick={() => setTab('repos')} className={tabClasses('repos')}>
          Repos ({agentRepos.length})
        </button>
        <button onClick={() => setTab('versions')} className={tabClasses('versions')}>
          Versions ({versions.length})
        </button>
      </div>

      {/* Configuration Tab */}
      {tab === 'config' && (
        <div className="space-y-6">
          {/* Basic Info */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-4">Basic Info</h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Name</label>
                <input
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Model</label>
                <input
                  value={editModel}
                  onChange={e => setEditModel(e.target.value)}
                  className="input w-full"
                  placeholder="claude-sonnet-4-20250514"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-sm text-gray-400 mb-1">Description</label>
                <input
                  value={editDescription}
                  onChange={e => setEditDescription(e.target.value)}
                  className="input w-full"
                  placeholder="What does this agent do?"
                />
              </div>
            </div>
          </div>

          {/* System Prompt */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">System Prompt</h3>
            <p className="text-xs text-gray-500 mb-3">Custom instructions injected at the start of every session for this agent.</p>
            <textarea
              value={editSystemPrompt}
              onChange={e => setEditSystemPrompt(e.target.value)}
              className="input w-full font-mono text-sm"
              rows={6}
              placeholder="You are a senior developer. Always write tests for new code. Follow the project's existing patterns..."
            />
          </div>

          {/* Limits */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Session Limits</h3>
            <p className="text-xs text-gray-500 mb-3">Restrict costs and token usage per session for this agent.</p>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Max Cost per Session (USD)</label>
                <input
                  type="number"
                  step="0.01"
                  value={editMaxCost}
                  onChange={e => setEditMaxCost(e.target.value)}
                  className="input w-full"
                  placeholder="e.g. 5.00"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Max Tokens per Session</label>
                <input
                  type="number"
                  step="1000"
                  value={editMaxTokens}
                  onChange={e => setEditMaxTokens(e.target.value)}
                  className="input w-full"
                  placeholder="e.g. 100000"
                />
              </div>
            </div>
          </div>

          {/* Allowed Tools */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Allowed Tools</h3>
            <p className="text-xs text-gray-500 mb-3">One tool name per line. Leave empty to allow all tools.</p>
            <textarea
              value={editAllowedTools}
              onChange={e => setEditAllowedTools(e.target.value)}
              className="input w-full font-mono text-sm"
              rows={4}
              placeholder={"Read\nWrite\nEdit\nBash\nGlob\nGrep"}
            />
          </div>

          {/* Permissions */}
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Permissions (JSON)</h3>
            <p className="text-xs text-gray-500 mb-3">
              File access patterns and restrictions. Example: {`{"filePatterns": ["src/**/*.ts"], "blockedPaths": ["**/.env", "**/secrets/**"]}`}
            </p>
            <textarea
              value={editPermissions}
              onChange={e => setEditPermissions(e.target.value)}
              className="input w-full font-mono text-sm"
              rows={4}
              placeholder='{"filePatterns": ["**/*.ts", "**/*.tsx"], "blockedPaths": ["**/.env"]}'
            />
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-primary"
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      )}

      {/* Policies Tab */}
      {tab === 'policies' && (
        <div className="space-y-6">
          {/* Assigned Policies */}
          {assignedPolicies.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-3">
                Assigned Policies <span className="text-gray-500 font-normal">(all rules apply to this agent)</span>
              </h3>
              <div className="space-y-2">
                {assignedPolicies.map(policy => (
                  <Link
                    key={policy.id}
                    to={`/policies/${policy.id}`}
                    className="card py-3 flex items-center gap-3 hover:border-gray-700 transition-colors block"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-indigo-400">{policy.name}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${TYPE_BADGE[policy.type] || 'bg-gray-800 text-gray-400'}`}>
                          {policy.type.replace(/_/g, ' ')}
                        </span>
                        {!policy.active && (
                          <span className="text-xs text-gray-600 bg-gray-800 rounded px-1.5 py-0.5">inactive</span>
                        )}
                      </div>
                      {policy.description && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{policy.description}</p>
                      )}
                    </div>
                    <span className="text-xs text-gray-500 flex-shrink-0">
                      {policy.rules.length} rule{policy.rules.length !== 1 ? 's' : ''}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Agent-specific rules */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-300">Rules targeting this agent</h3>
              <button
                onClick={() => {
                  setShowAddRule(!showAddRule);
                  // Pre-select first policy if available
                  if (policies.length > 0 && !addRulePolicyId) setAddRulePolicyId(policies[0].id);
                }}
                className="btn-primary text-xs py-1.5"
              >
                {showAddRule ? 'Cancel' : 'Add Rule'}
              </button>
            </div>

            {/* Add rule form */}
            {showAddRule && (
              <form onSubmit={handleAddAgentRule} className="card space-y-3 mb-4">
                <h4 className="text-sm font-medium text-gray-300">New rule for {agent.name}</h4>
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
                      const [json, desc] = ex.split(' — ');
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

            {agentRules.length === 0 ? (
              <div className="card text-center py-6">
                <p className="text-gray-500 text-sm">No policy rules scoped to this agent yet.</p>
                <p className="text-gray-600 text-xs mt-1">Add a rule to enforce specific governance for {agent.name}.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {agentRules.map(rule => (
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
                      onClick={() => handleRemoveAgentRule(rule.policyId, rule.id)}
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
                Org-wide rules <span className="text-gray-500 font-normal">(also apply to this agent)</span>
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

      {/* Sessions Tab */}
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
                  <div className="text-right">
                    {s.costUsd > 0 && (
                      <p className="text-xs text-gray-400">${Number(s.costUsd).toFixed(2)}</p>
                    )}
                    <span className="text-xs text-gray-500">{new Date(s.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      )}

      {/* Versions Tab */}
      {/* Members Tab */}
      {tab === 'members' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-300">Assigned Members</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {members.length === 0
                  ? 'No members assigned — all org users can use this agent.'
                  : `${members.length} member${members.length !== 1 ? 's' : ''} assigned. Only these users will see this agent in the CLI.`}
              </p>
            </div>
          </div>

          {/* Current members */}
          {members.length > 0 && (
            <div className="space-y-2">
              {members.map((m) => (
                <div key={m.id} className="flex items-center justify-between px-4 py-2.5 bg-gray-800/50 border border-gray-700/50 rounded-lg">
                  <div>
                    <span className="text-sm text-gray-200">{m.name}</span>
                    <span className="text-xs text-gray-500 ml-2">{m.email}</span>
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">{m.role}</span>
                  </div>
                  <button
                    onClick={async () => {
                      setMembersSaving(true);
                      try {
                        const newIds = members.filter((x) => x.id !== m.id).map((x) => x.id);
                        await api.updateAgentMembers(id!, newIds);
                        setMembers(members.filter((x) => x.id !== m.id));
                        setSuccess(`Removed ${m.name} from agent`);
                      } catch (err: any) {
                        setError(err.message);
                      }
                      setMembersSaving(false);
                    }}
                    disabled={membersSaving}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add member */}
          {(() => {
            const memberIds = new Set(members.map((m) => m.id));
            const available = (orgUsers.users || []).filter((u) => !memberIds.has(u.id));
            if (available.length === 0) return null;
            return (
              <div className="card">
                <h4 className="text-xs font-semibold text-gray-400 mb-2">Add Member</h4>
                <div className="space-y-2">
                  {available.map((u) => (
                    <div key={u.id} className="flex items-center justify-between px-3 py-2 bg-gray-800/30 rounded-md">
                      <div>
                        <span className="text-sm text-gray-300">{u.name}</span>
                        <span className="text-xs text-gray-500 ml-2">{u.email}</span>
                      </div>
                      <button
                        onClick={async () => {
                          setMembersSaving(true);
                          try {
                            const newIds = [...members.map((x) => x.id), u.id];
                            await api.updateAgentMembers(id!, newIds);
                            setMembers([...members, { ...u, assignedAt: new Date().toISOString() }]);
                            setSuccess(`Added ${u.name} to agent`);
                          } catch (err: any) {
                            setError(err.message);
                          }
                          setMembersSaving(false);
                        }}
                        disabled={membersSaving}
                        className="text-xs px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                      >
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Repos Tab */}
      {tab === 'repos' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-300">Repo Access</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {agentRepos.length === 0
                  ? 'No repos assigned — this agent can access all repos.'
                  : `${agentRepos.length} repo${agentRepos.length !== 1 ? 's' : ''} assigned. This agent can only work in these repos.`}
              </p>
            </div>
          </div>

          {/* Current repos */}
          {agentRepos.length > 0 && (
            <div className="space-y-2">
              {agentRepos.map((r) => (
                <div key={r.id} className="flex items-center justify-between px-4 py-2.5 bg-gray-800/50 border border-gray-700/50 rounded-lg">
                  <div>
                    <span className="text-sm text-gray-200">{r.name}</span>
                    <span className="text-xs text-gray-500 ml-2 font-mono">{r.path}</span>
                  </div>
                  <button
                    onClick={async () => {
                      setReposSaving(true);
                      try {
                        const newIds = agentRepos.filter((x) => x.id !== r.id).map((x) => x.id);
                        await api.updateAgentRepos(id!, newIds);
                        setAgentRepos(agentRepos.filter((x) => x.id !== r.id));
                        setSuccess(`Removed ${r.name} from agent`);
                      } catch (err: any) {
                        setError(err.message);
                      }
                      setReposSaving(false);
                    }}
                    disabled={reposSaving}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add repo */}
          {(() => {
            const assignedIds = new Set(agentRepos.map((r) => r.id));
            const available = allRepos.filter((r) => !assignedIds.has(r.id));
            if (available.length === 0) return null;
            return (
              <div className="card">
                <h4 className="text-xs font-semibold text-gray-400 mb-2">Add Repo</h4>
                <div className="space-y-2">
                  {available.map((r) => (
                    <div key={r.id} className="flex items-center justify-between px-3 py-2 bg-gray-800/30 rounded-md">
                      <div>
                        <span className="text-sm text-gray-300">{r.name}</span>
                        <span className="text-xs text-gray-500 ml-2 font-mono">{r.path}</span>
                      </div>
                      <button
                        onClick={async () => {
                          setReposSaving(true);
                          try {
                            const newIds = [...agentRepos.map((x) => x.id), r.id];
                            await api.updateAgentRepos(id!, newIds);
                            setAgentRepos([...agentRepos, { id: r.id, name: r.name, path: r.path, provider: r.provider, assignedAt: new Date().toISOString() }]);
                            setSuccess(`Added ${r.name} to agent`);
                          } catch (err: any) {
                            setError(err.message);
                          }
                          setReposSaving(false);
                        }}
                        disabled={reposSaving}
                        className="text-xs px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                      >
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {tab === 'versions' && (
        <div>
          {restoring && (
            <div className="card bg-amber-900/20 border-amber-800 text-amber-400 text-sm mb-4">
              Restoring version...
            </div>
          )}
          <VersionHistory
            versions={versions}
            onRestore={handleRestore}
            currentVersion={latestVersion}
          />
        </div>
      )}
    </div>
  );
}
