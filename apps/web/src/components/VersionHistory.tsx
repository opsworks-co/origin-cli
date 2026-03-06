import React from 'react';

interface Version {
  id: string;
  version: number;
  snapshot: any;
  changedBy: string | null;
  changeType: string;
  createdAt: string;
}

interface Props {
  versions: Version[];
  onRestore?: (versionId: string, version: number) => void;
  currentVersion?: number;
}

function diffSnapshots(older: any, newer: any): string[] {
  const changes: string[] = [];
  if (!older || !newer) return changes;

  const LABELS: Record<string, string> = {
    name: 'Name',
    slug: 'Slug',
    description: 'Description',
    model: 'Model',
    status: 'Status',
    systemPrompt: 'System Prompt',
    allowedTools: 'Allowed Tools',
    maxCostPerSession: 'Max Cost/Session',
    maxTokensPerSession: 'Max Tokens/Session',
    permissions: 'Permissions',
    active: 'Active',
    type: 'Type',
  };

  for (const key of new Set([...Object.keys(older), ...Object.keys(newer)])) {
    if (key === 'rules') continue;
    const oldVal = JSON.stringify(older[key]);
    const newVal = JSON.stringify(newer[key]);
    if (oldVal !== newVal) {
      const label = LABELS[key] || key;
      const oldDisplay = formatValue(older[key]);
      const newDisplay = formatValue(newer[key]);
      changes.push(`${label}: ${oldDisplay} → ${newDisplay}`);
    }
  }

  // Diff rules arrays if present
  const oldRules = older.rules || [];
  const newRules = newer.rules || [];
  if (JSON.stringify(oldRules) !== JSON.stringify(newRules)) {
    const oldIds = new Set(oldRules.map((r: any) => r.id));
    const newIds = new Set(newRules.map((r: any) => r.id));
    const added = newRules.filter((r: any) => !oldIds.has(r.id));
    const removed = oldRules.filter((r: any) => !newIds.has(r.id));
    if (added.length) changes.push(`+${added.length} rule(s) added`);
    if (removed.length) changes.push(`-${removed.length} rule(s) removed`);
  }

  return changes;
}

function formatValue(val: any): string {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'string' && val.length > 60) return val.slice(0, 57) + '...';
  if (Array.isArray(val)) return val.length === 0 ? '(none)' : val.join(', ');
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

const CHANGE_BADGES: Record<string, string> = {
  CREATED: 'bg-green-500/20 text-green-400',
  UPDATED: 'bg-blue-500/20 text-blue-400',
  RULE_ADDED: 'bg-indigo-500/20 text-indigo-400',
  RULE_REMOVED: 'bg-amber-500/20 text-amber-400',
  STATUS_CHANGED: 'bg-purple-500/20 text-purple-400',
  MODEL_CHANGED: 'bg-cyan-500/20 text-cyan-400',
  PROMPT_CHANGED: 'bg-teal-500/20 text-teal-400',
  PERMISSIONS_CHANGED: 'bg-orange-500/20 text-orange-400',
  RESTORED: 'bg-yellow-500/20 text-yellow-400',
  ACTIVATED: 'bg-green-500/20 text-green-400',
  DEACTIVATED: 'bg-red-500/20 text-red-400',
};

export default function VersionHistory({ versions, onRestore, currentVersion }: Props) {
  if (!versions.length) {
    return <p className="text-gray-500 text-sm py-8 text-center">No version history yet.</p>;
  }

  return (
    <div className="space-y-4">
      {versions.map((v, i) => {
        const prev = i < versions.length - 1 ? versions[i + 1] : null;
        const changes = prev ? diffSnapshots(prev.snapshot, v.snapshot) : ['Initial version'];
        const isLatest = i === 0;
        const isCurrent = currentVersion !== undefined ? v.version === currentVersion : isLatest;

        return (
          <div key={v.id} className={`card ${isCurrent ? 'border-indigo-500/50' : ''}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-mono font-bold text-gray-200">v{v.version}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${CHANGE_BADGES[v.changeType] || 'bg-gray-700 text-gray-300'}`}>
                  {v.changeType.replace(/_/g, ' ')}
                </span>
                {isCurrent && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400">
                    CURRENT
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
                {onRestore && !isCurrent && (
                  <button
                    onClick={() => onRestore(v.id, v.version)}
                    className="text-xs text-amber-400 hover:text-amber-300 transition-colors px-2 py-1 rounded hover:bg-amber-500/10"
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>
            {changes.length > 0 && (
              <ul className="space-y-1">
                {changes.map((c, j) => (
                  <li key={j} className="text-sm text-gray-400 font-mono">
                    {c}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
