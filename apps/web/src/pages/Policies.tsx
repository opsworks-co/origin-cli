import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { Policy, Agent, Machine, Repo } from '../api';

const TYPE_BADGE: Record<string, string> = {
  FILE_RESTRICTION: 'badge-red',
  REQUIRE_REVIEW: 'badge-amber',
  MODEL_ALLOWLIST: 'badge-blue',
  COST_LIMIT: 'badge-purple',
};

const TYPE_DESCRIPTIONS: Record<string, string> = {
  FILE_RESTRICTION:
    'Block or flag access to specific file patterns (e.g. .env, secrets, prod configs). Enforced via MCP server check_file_access tool and at session end.',
  REQUIRE_REVIEW:
    'Auto-flag sessions for human review when conditions are met (cost, tokens, file count, duration, or file patterns).',
  MODEL_ALLOWLIST:
    'Restrict which AI models can be used. Sessions with non-allowed models are blocked at startup.',
  COST_LIMIT:
    'Set per-session cost or token limits. Violations are logged and sessions are flagged for review.',
};

const CONDITION_HELP: Record<string, { placeholder: string; examples: string[] }> = {
  FILE_RESTRICTION: {
    placeholder: '{"path": "**/.env"}',
    examples: [
      '{"path": "**/.env"} — Block all .env files',
      '{"path": "**/.env*"} — Block .env, .env.local, etc.',
      '{"path": "src/auth/**"} — Block all files in auth dir',
      '{"path": "**/*.key"} — Block all .key files',
      '{"path": "**/secrets/**"} — Block secrets directory',
    ],
  },
  REQUIRE_REVIEW: {
    placeholder: '{"cost_above": 1.0}',
    examples: [
      '{"cost_above": 1.0} — Flag if cost > $1.00',
      '{"tokens_above": 50000} — Flag if tokens > 50k',
      '{"files_above": 10} — Flag if > 10 files changed',
      '{"max_lines": 500} — Flag if > 500 lines added',
      '{"max_duration_minutes": 30} — Flag if > 30 min',
      '{"path": "**/*.sql"} — Flag if SQL files modified',
    ],
  },
  MODEL_ALLOWLIST: {
    placeholder: '{"models": ["claude-sonnet-4-20250514"]}',
    examples: [
      '{"models": ["claude-sonnet-4-20250514"]} — Only allow Sonnet',
      '{"models": ["claude-sonnet-4-20250514", "gpt-4o"]} — Allow Sonnet or GPT-4o',
    ],
  },
  COST_LIMIT: {
    placeholder: '{"max_cost": 5.0}',
    examples: [
      '{"max_cost": 5.0} — Limit $5 per session',
      '{"max_tokens": 100000} — Limit 100k tokens per session',
    ],
  },
};

const ACTION_DESCRIPTIONS: Record<string, string> = {
  block: 'Prevent the action entirely (returns error to agent)',
  warn: 'Allow but log a warning and flag for review',
  require_review: 'Allow but auto-flag session for human review',
  notify: 'Allow but send notification to org admins',
};

function parseCondition(conditionJson: string): string {
  try {
    const parsed = JSON.parse(conditionJson);
    if (typeof parsed === 'string') return parsed;
    // Pretty format for common conditions
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
  } catch {
    return conditionJson;
  }
}

function conditionIcon(conditionJson: string): string {
  try {
    const parsed = JSON.parse(conditionJson);
    if (parsed.path) return '📁';
    if (parsed.models) return '🤖';
    if (parsed.max_cost || parsed.cost_above) return '💰';
    if (parsed.max_tokens || parsed.tokens_above) return '🔢';
    if (parsed.files_above) return '📂';
    if (parsed.max_lines) return '📝';
    if (parsed.max_duration_minutes) return '⏱️';
    return '📋';
  } catch {
    return '📋';
  }
}

export default function Policies() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Create policy form
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState('REQUIRE_REVIEW');
  const [formDesc, setFormDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Add rule form
  const [ruleForPolicy, setRuleForPolicy] = useState<string | null>(null);
  const [ruleCondition, setRuleCondition] = useState('');
  const [ruleAction, setRuleAction] = useState('block');
  const [ruleSeverity, setRuleSeverity] = useState('MEDIUM');
  const [ruleAgentId, setRuleAgentId] = useState('');
  const [ruleMachineId, setRuleMachineId] = useState('');
  const [ruleRepoId, setRuleRepoId] = useState('');

  // Scope options for dropdowns
  const [agents, setAgents] = useState<Agent[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);

  const fetchPolicies = () => {
    setLoading(true);
    api
      .getPolicies()
      .then(setPolicies)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchPolicies();
    // Load scope options for rule assignment
    api.getAgents().then((data: any) => setAgents(data.agents || data || [])).catch(() => {});
    api.getMachines().then((data: any) => setMachines(Array.isArray(data) ? data : [])).catch(() => {});
    api.getRepos().then((data: any) => setRepos(data.repos || data || [])).catch(() => {});
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createPolicy({
        name: formName,
        type: formType,
        description: formDesc || undefined,
      });
      setFormName('');
      setFormType('REQUIRE_REVIEW');
      setFormDesc('');
      setShowForm(false);
      fetchPolicies();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (policy: Policy) => {
    try {
      await api.updatePolicy(policy.id, { active: !policy.active });
      fetchPolicies();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeletePolicy = async (id: string) => {
    try {
      await api.deletePolicy(id);
      fetchPolicies();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteRule = async (policyId: string, ruleId: string) => {
    try {
      await api.deletePolicyRule(policyId, ruleId);
      fetchPolicies();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Get the policy type for the rule being added (for help text)
  const ruleForPolicyType = policies.find((p) => p.id === ruleForPolicy)?.type || '';

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleForPolicy) return;

    // Validate JSON
    try {
      JSON.parse(ruleCondition);
    } catch {
      setError('Condition must be valid JSON. See examples below.');
      return;
    }

    setSubmitting(true);
    try {
      await api.createPolicyRule(ruleForPolicy, {
        condition: ruleCondition,
        action: ruleAction,
        severity: ruleSeverity,
        ...(ruleAgentId && { agentId: ruleAgentId }),
        ...(ruleMachineId && { machineId: ruleMachineId }),
        ...(ruleRepoId && { repoId: ruleRepoId }),
      });
      setRuleForPolicy(null);
      setRuleCondition('');
      setRuleAction('block');
      setRuleSeverity('MEDIUM');
      setRuleAgentId('');
      setRuleMachineId('');
      setRuleRepoId('');
      fetchPolicies();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUseExample = (example: string) => {
    // Extract JSON from example string (before " — ")
    const json = example.split(' — ')[0].trim();
    setRuleCondition(json);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Policies</h1>
          <p className="text-sm text-gray-500 mt-1">
            Governance rules enforced on AI coding sessions
          </p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary text-sm">
          {showForm ? 'Cancel' : 'Add Policy'}
        </button>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-300 ml-2">
            &times;
          </button>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="card space-y-4">
          <h3 className="font-semibold">New Policy</h3>
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name</label>
              <input
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="input"
                placeholder="No sensitive files"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Type</label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value)}
                className="select w-full"
              >
                <option value="FILE_RESTRICTION">File Restriction</option>
                <option value="REQUIRE_REVIEW">Require Review</option>
                <option value="MODEL_ALLOWLIST">Model Allowlist</option>
                <option value="COST_LIMIT">Cost Limit</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Description</label>
              <input
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                className="input"
                placeholder="Optional description"
              />
            </div>
          </div>
          {TYPE_DESCRIPTIONS[formType] && (
            <p className="text-xs text-gray-500 bg-gray-800/50 rounded-lg px-3 py-2">
              {TYPE_DESCRIPTIONS[formType]}
            </p>
          )}
          <button type="submit" disabled={submitting} className="btn-primary text-sm">
            {submitting ? 'Creating...' : 'Create Policy'}
          </button>
        </form>
      )}

      {/* How enforcement works banner */}
      {policies.length === 0 && !showForm && (
        <div className="card space-y-4">
          <div className="text-center py-4">
            <p className="text-gray-400 mb-3">No policies configured yet.</p>
            <p className="text-sm text-gray-500 max-w-xl mx-auto">
              Policies let you enforce governance rules on AI coding sessions.
              They are checked server-side when sessions start and end, and
              client-side via the MCP server during sessions.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {Object.entries(TYPE_DESCRIPTIONS).map(([type, desc]) => (
              <div key={type} className="bg-gray-800/50 rounded-lg px-4 py-3">
                <span className={`text-xs font-medium ${TYPE_BADGE[type]?.replace('badge-', 'text-') || 'text-gray-400'}`}>
                  {type.replace(/_/g, ' ')}
                </span>
                <p className="text-xs text-gray-500 mt-1">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Policy list */}
      {policies.length > 0 && (
        <div className="space-y-3">
          {policies.map((policy) => {
            const expanded = expandedId === policy.id;
            return (
              <div key={policy.id} className="card p-0 overflow-hidden">
                {/* Policy header */}
                <div
                  className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-gray-800/30 transition-colors"
                  onClick={() => setExpandedId(expanded ? null : policy.id)}
                >
                  <span className="text-gray-500 text-xs select-none">
                    {expanded ? '\u25BC' : '\u25B6'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        to={`/policies/${policy.id}`}
                        className="font-semibold text-gray-100 hover:text-indigo-400 transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {policy.name}
                      </Link>
                      <span className={TYPE_BADGE[policy.type] ?? 'badge-gray'}>
                        {policy.type.replace(/_/g, ' ')}
                      </span>
                    </div>
                    {policy.description && (
                      <p className="text-xs text-gray-500 mt-0.5">{policy.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {policy.active ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
                        <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                        Active
                      </span>
                    ) : (
                      <span className="text-xs text-gray-600">Inactive</span>
                    )}
                    <span className="text-xs text-gray-500">
                      {policy.rules?.length ?? 0} rule
                      {(policy.rules?.length ?? 0) !== 1 ? 's' : ''}
                    </span>
                    {/* Toggle */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggle(policy);
                      }}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        policy.active ? 'bg-indigo-600' : 'bg-gray-700'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          policy.active ? 'translate-x-4' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Expanded rules */}
                {expanded && (
                  <div className="border-t border-gray-800 px-5 py-4 space-y-3">
                    {/* Enforcement info */}
                    <div className="text-xs text-gray-500 bg-gray-800/30 rounded-lg px-3 py-2">
                      {TYPE_DESCRIPTIONS[policy.type] || 'No description available.'}
                    </div>

                    {policy.rules && policy.rules.length > 0 ? (
                      <div className="space-y-2">
                        {policy.rules.map((rule) => (
                          <div
                            key={rule.id}
                            className="flex items-center gap-2 text-sm bg-gray-800/50 rounded-lg px-3 py-2.5 flex-wrap"
                          >
                            <span className="text-base">{conditionIcon(rule.condition)}</span>
                            <span className="text-gray-500 text-xs">IF</span>
                            <code className="text-indigo-400 text-xs">
                              {parseCondition(rule.condition)}
                            </code>
                            <span className="text-gray-500 text-xs">THEN</span>
                            <code
                              className={`text-xs font-medium ${
                                rule.action.toLowerCase() === 'block'
                                  ? 'text-red-400'
                                  : rule.action.toLowerCase() === 'require_review'
                                    ? 'text-amber-400'
                                    : rule.action.toLowerCase() === 'warn'
                                      ? 'text-yellow-400'
                                      : 'text-blue-400'
                              }`}
                            >
                              {rule.action}
                            </code>
                            <span
                              className={`text-xs px-1.5 py-0.5 rounded ${
                                rule.severity.toUpperCase() === 'HIGH'
                                  ? 'bg-red-900/30 text-red-400'
                                  : rule.severity.toUpperCase() === 'MEDIUM'
                                    ? 'bg-amber-900/30 text-amber-400'
                                    : 'bg-gray-800 text-gray-400'
                              }`}
                            >
                              {rule.severity}
                            </span>
                            {/* Scope badges */}
                            {rule.agent && (
                              <span className="text-xs bg-blue-900/30 text-blue-400 rounded px-1.5 py-0.5">
                                Agent: {rule.agent.name}
                              </span>
                            )}
                            {rule.machine && (
                              <span className="text-xs bg-purple-900/30 text-purple-400 rounded px-1.5 py-0.5">
                                Machine: {rule.machine.hostname}
                              </span>
                            )}
                            {rule.repo && (
                              <span className="text-xs bg-green-900/30 text-green-400 rounded px-1.5 py-0.5">
                                Repo: {rule.repo.name}
                              </span>
                            )}
                            {!rule.agent && !rule.machine && !rule.repo && (
                              <span className="text-xs text-gray-600">org-wide</span>
                            )}
                            <button
                              onClick={() => handleDeleteRule(policy.id, rule.id)}
                              className="ml-auto text-red-500 hover:text-red-400 hover:bg-red-900/30 rounded px-1.5 py-0.5 text-xs font-bold transition-colors"
                              title="Delete rule"
                            >
                              &times;
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500">
                        No rules defined yet. Add a rule to start enforcing this policy.
                      </p>
                    )}

                    {/* Add rule */}
                    {ruleForPolicy === policy.id ? (
                      <div className="space-y-3 mt-3 border-t border-gray-800 pt-3">
                        <h4 className="text-sm font-medium text-gray-300">Add Rule</h4>

                        <form onSubmit={handleAddRule} className="space-y-3">
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">
                              Condition (JSON)
                            </label>
                            <input
                              required
                              value={ruleCondition}
                              onChange={(e) => setRuleCondition(e.target.value)}
                              className="input text-sm font-mono"
                              placeholder={
                                CONDITION_HELP[policy.type]?.placeholder || '{"path": "**/.env"}'
                              }
                            />
                          </div>

                          {/* Example conditions */}
                          {CONDITION_HELP[policy.type] && (
                            <div className="space-y-1">
                              <p className="text-xs text-gray-500">Click an example to use it:</p>
                              <div className="flex flex-wrap gap-1.5">
                                {CONDITION_HELP[policy.type].examples.map((ex, i) => {
                                  const [json, desc] = ex.split(' — ');
                                  return (
                                    <button
                                      key={i}
                                      type="button"
                                      onClick={() => handleUseExample(ex)}
                                      className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded px-2 py-1 transition-colors text-left"
                                    >
                                      <code className="text-indigo-400">{json.trim()}</code>
                                      {desc && (
                                        <span className="text-gray-500 ml-1">{desc}</span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          <div className="flex flex-wrap gap-3">
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Action</label>
                              <select
                                value={ruleAction}
                                onChange={(e) => setRuleAction(e.target.value)}
                                className="select text-sm"
                              >
                                <option value="block">block</option>
                                <option value="warn">warn</option>
                                <option value="require_review">require_review</option>
                                <option value="notify">notify</option>
                              </select>
                              <p className="text-xs text-gray-600 mt-0.5 max-w-[250px]">
                                {ACTION_DESCRIPTIONS[ruleAction]}
                              </p>
                            </div>
                            <div>
                              <label className="block text-xs text-gray-400 mb-1">Severity</label>
                              <select
                                value={ruleSeverity}
                                onChange={(e) => setRuleSeverity(e.target.value)}
                                className="select text-sm"
                              >
                                <option value="LOW">Low</option>
                                <option value="MEDIUM">Medium</option>
                                <option value="HIGH">High</option>
                              </select>
                            </div>
                          </div>

                          {/* Scope assignment */}
                          <div>
                            <label className="block text-xs text-gray-400 mb-1.5">
                              Scope <span className="text-gray-600">(optional — leave empty for org-wide)</span>
                            </label>
                            <div className="flex flex-wrap gap-3">
                              <div>
                                <label className="block text-xs text-gray-500 mb-0.5">Agent</label>
                                <select
                                  value={ruleAgentId}
                                  onChange={(e) => setRuleAgentId(e.target.value)}
                                  className="select text-sm"
                                >
                                  <option value="">All agents</option>
                                  {agents.map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-0.5">Machine</label>
                                <select
                                  value={ruleMachineId}
                                  onChange={(e) => setRuleMachineId(e.target.value)}
                                  className="select text-sm"
                                >
                                  <option value="">All machines</option>
                                  {machines.map((m) => (
                                    <option key={m.id} value={m.id}>{m.hostname}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-0.5">Repo</label>
                                <select
                                  value={ruleRepoId}
                                  onChange={(e) => setRuleRepoId(e.target.value)}
                                  className="select text-sm"
                                >
                                  <option value="">All repos</option>
                                  {repos.map((r) => (
                                    <option key={r.id} value={r.id}>{r.name}</option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          </div>

                          <div className="flex gap-2">
                            <button
                              type="submit"
                              disabled={submitting}
                              className="btn-primary text-sm py-1.5"
                            >
                              {submitting ? 'Adding...' : 'Add Rule'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setRuleForPolicy(null)}
                              className="btn-secondary text-sm py-1.5"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      </div>
                    ) : (
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => {
                            setRuleForPolicy(policy.id);
                            // Pre-select sensible defaults based on policy type
                            if (policy.type === 'FILE_RESTRICTION') {
                              setRuleAction('block');
                              setRuleSeverity('HIGH');
                            } else if (policy.type === 'REQUIRE_REVIEW') {
                              setRuleAction('require_review');
                              setRuleSeverity('MEDIUM');
                            } else if (policy.type === 'MODEL_ALLOWLIST') {
                              setRuleAction('block');
                              setRuleSeverity('HIGH');
                            } else if (policy.type === 'COST_LIMIT') {
                              setRuleAction('warn');
                              setRuleSeverity('MEDIUM');
                            }
                          }}
                          className="btn-secondary text-xs py-1.5"
                        >
                          Add Rule
                        </button>
                        <button
                          onClick={() => handleDeletePolicy(policy.id)}
                          className="btn-danger text-xs py-1.5"
                        >
                          Delete Policy
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
