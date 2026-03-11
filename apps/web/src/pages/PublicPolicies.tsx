import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';

interface PolicyRule {
  summary: string;
  fixHint: string;
  action: string;
  actionLabel: string;
  severity: string;
}

interface PublicPolicy {
  name: string;
  description: string | null;
  type: string;
  typeLabel: string;
  rules: PolicyRule[];
}

interface PublicPoliciesData {
  orgName: string;
  orgSlug: string;
  policies: PublicPolicy[];
}

const ACTION_STYLES: Record<string, string> = {
  BLOCK: 'bg-red-500/20 text-red-400 border-red-500/30',
  REQUIRE_REVIEW: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  WARN: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  NOTIFY: 'bg-gray-700/50 text-gray-400 border-gray-600/30',
};

const SEVERITY_STYLES: Record<string, string> = {
  HIGH: 'bg-red-500/10 text-red-400',
  MEDIUM: 'bg-amber-500/10 text-amber-400',
  LOW: 'bg-gray-700/50 text-gray-500',
};

const TYPE_ICONS: Record<string, string> = {
  MODEL_ALLOWLIST: '\u26A1',
  COST_LIMIT: '\uD83D\uDCB0',
  FILE_RESTRICTION: '\uD83D\uDEAB',
  REQUIRE_REVIEW: '\uD83D\uDD0D',
};

export default function PublicPolicies() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [data, setData] = useState<PublicPoliciesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgSlug) return;
    fetch(`/api/policies/public/${orgSlug}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Organization not found' : 'Failed to load policies');
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [orgSlug]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-20 text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mx-auto" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h1 className="text-2xl font-bold mb-4">Policy Summary</h1>
        <p className="text-gray-400">{error || 'Failed to load policies'}</p>
        <Link to="/" className="text-indigo-400 hover:text-indigo-300 text-sm mt-4 inline-block">
          Back to Home
        </Link>
      </div>
    );
  }

  // Group policies by type
  const groups = new Map<string, PublicPolicy[]>();
  for (const policy of data.policies) {
    const type = policy.type;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(policy);
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold">{data.orgName}</h1>
        <p className="text-gray-400 mt-2">
          Active governance policies for AI coding sessions. These policies are automatically enforced
          when developers use AI coding agents within this organization.
        </p>
      </div>

      {data.policies.length === 0 ? (
        <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-gray-400">No active policies configured for this organization.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {Array.from(groups).map(([type, policies]) => (
            <div key={type}>
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                <span>{TYPE_ICONS[type] || '\uD83D\uDCCB'}</span>
                {policies[0]?.typeLabel || type}
              </h2>
              <div className="space-y-3">
                {policies.map((policy) => (
                  <div key={policy.name} className="bg-gray-900/50 border border-gray-800 rounded-xl p-5">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-lg font-semibold text-gray-100">{policy.name}</h3>
                    </div>
                    {policy.description && (
                      <p className="text-sm text-gray-400 mb-4">{policy.description}</p>
                    )}
                    {policy.rules.length > 0 && (
                      <div className="space-y-2">
                        {policy.rules.map((rule, i) => (
                          <div key={i} className="flex items-start gap-3 bg-gray-800/30 rounded-lg px-4 py-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-gray-200">{rule.summary}</p>
                              <p className="text-xs text-gray-500 mt-1">{rule.fixHint}</p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className={`text-xs px-2 py-0.5 rounded-full border ${ACTION_STYLES[rule.action.toUpperCase()] || ACTION_STYLES.NOTIFY}`}>
                                {rule.actionLabel}
                              </span>
                              <span className={`text-xs px-2 py-0.5 rounded-full ${SEVERITY_STYLES[rule.severity?.toUpperCase()] || SEVERITY_STYLES.MEDIUM}`}>
                                {rule.severity}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer info */}
      <div className="mt-12 pt-6 border-t border-gray-800 text-center">
        <p className="text-xs text-gray-600">
          Policies are enforced by Origin. Learn more at the{' '}
          <Link to="/docs" className="text-indigo-400 hover:text-indigo-300 transition-colors">
            documentation
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
