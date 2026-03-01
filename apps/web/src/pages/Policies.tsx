import React, { useEffect, useState } from 'react';
import * as api from '../api';
import type { Policy } from '../api';

const TYPE_BADGE: Record<string, string> = {
  FILE_RESTRICTION: 'badge-red',
  REQUIRE_REVIEW: 'badge-amber',
  MODEL_ALLOWLIST: 'badge-blue',
  COST_LIMIT: 'badge-purple',
};

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
  const [ruleField, setRuleField] = useState('');
  const [ruleOp, setRuleOp] = useState('equals');
  const [ruleValue, setRuleValue] = useState('');

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

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleForPolicy) return;
    setSubmitting(true);
    try {
      await api.createPolicyRule(ruleForPolicy, {
        field: ruleField,
        operator: ruleOp,
        value: ruleValue,
      });
      setRuleForPolicy(null);
      setRuleField('');
      setRuleOp('equals');
      setRuleValue('');
      fetchPolicies();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
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
          <p className="text-sm text-gray-500 mt-1">Governance rules for AI agent behavior</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary text-sm">
          {showForm ? 'Cancel' : 'Add Policy'}
        </button>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
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
          <button type="submit" disabled={submitting} className="btn-primary text-sm">
            {submitting ? 'Creating...' : 'Create Policy'}
          </button>
        </form>
      )}

      {/* Policy list */}
      {policies.length === 0 ? (
        <div className="card text-center py-12 text-gray-500">
          No policies configured yet. Add one to enforce governance rules.
        </div>
      ) : (
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
                      <span className="font-semibold text-gray-100">{policy.name}</span>
                      <span className={TYPE_BADGE[policy.type] ?? 'badge-gray'}>
                        {policy.type.replace(/_/g, ' ')}
                      </span>
                    </div>
                    {policy.description && (
                      <p className="text-xs text-gray-500 mt-0.5">{policy.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs text-gray-500">
                      {policy.rules?.length ?? 0} rule{(policy.rules?.length ?? 0) !== 1 ? 's' : ''}
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
                    {policy.rules && policy.rules.length > 0 ? (
                      <div className="space-y-2">
                        {policy.rules.map((rule) => (
                          <div
                            key={rule.id}
                            className="flex items-center gap-2 text-sm bg-gray-800/50 rounded-lg px-3 py-2"
                          >
                            <code className="text-indigo-400">{rule.field}</code>
                            <span className="text-gray-500">{rule.operator}</span>
                            <code className="text-amber-400">{rule.value}</code>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500">No rules defined yet.</p>
                    )}

                    {/* Add rule */}
                    {ruleForPolicy === policy.id ? (
                      <form onSubmit={handleAddRule} className="flex flex-wrap gap-2 mt-2">
                        <input
                          required
                          value={ruleField}
                          onChange={(e) => setRuleField(e.target.value)}
                          className="input w-32 text-sm"
                          placeholder="Field"
                        />
                        <select
                          value={ruleOp}
                          onChange={(e) => setRuleOp(e.target.value)}
                          className="select text-sm"
                        >
                          <option value="equals">equals</option>
                          <option value="not_equals">not_equals</option>
                          <option value="contains">contains</option>
                          <option value="not_contains">not_contains</option>
                          <option value="greater_than">greater_than</option>
                          <option value="less_than">less_than</option>
                          <option value="matches">matches</option>
                        </select>
                        <input
                          required
                          value={ruleValue}
                          onChange={(e) => setRuleValue(e.target.value)}
                          className="input w-40 text-sm"
                          placeholder="Value"
                        />
                        <button type="submit" disabled={submitting} className="btn-primary text-sm py-1.5">
                          Add
                        </button>
                        <button
                          type="button"
                          onClick={() => setRuleForPolicy(null)}
                          className="btn-secondary text-sm py-1.5"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => setRuleForPolicy(policy.id)}
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
