import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { Machine, Agent, IntegrationConfig, Stats, AuditEntry } from '../api';
import { timeAgo, formatTokens, parseJsonSafe } from '../utils';
import {
  Server, Bot, Plug, HeartPulse, Trash2, Activity,
  Github, Gitlab, Slack, Mail, Cpu, Copy, Check, Clock,
  Key, Users, Shield, ShieldAlert, FileCode, Webhook, Boxes,
} from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import Sparkline from '../components/Sparkline';
import { useToast } from '../components/Toast';
import { agentColor } from './MyDashboard/utils';

// Provider catalog drives the compact "Connected systems" strip. Centralized
// so order/color/icon stay in sync if reused elsewhere.
const PROVIDER_CATALOG: Array<{
  key: 'github' | 'gitlab' | 'slack' | 'llm' | 'email';
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  color: string;
}> = [
  { key: 'github', label: 'GitHub', Icon: Github, color: '#a1a1aa' },
  { key: 'gitlab', label: 'GitLab', Icon: Gitlab, color: '#fc6d26' },
  { key: 'slack',  label: 'Slack',  Icon: Slack,  color: '#4a154b' },
  { key: 'llm',    label: 'LLM',    Icon: Cpu,    color: '#a78bfa' },
  { key: 'email',  label: 'Email',  Icon: Mail,   color: '#60a5fa' },
];

function StatCard({
  accent, label, Icon, value, sub,
}: {
  accent: 'indigo' | 'purple' | 'cyan' | 'amber' | 'green' | 'gray';
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  value: React.ReactNode;
  sub: React.ReactNode;
}) {
  const accentMap: Record<typeof accent, { grad: string; text: string }> = {
    indigo: { grad: 'from-indigo-500/20 to-indigo-500/0', text: 'text-indigo-300' },
    purple: { grad: 'from-purple-500/20 to-purple-500/0', text: 'text-purple-300' },
    cyan:   { grad: 'from-cyan-500/20 to-cyan-500/0',     text: 'text-cyan-300'   },
    amber:  { grad: 'from-amber-500/20 to-amber-500/0',   text: 'text-amber-300'  },
    green:  { grad: 'from-emerald-500/20 to-emerald-500/0', text: 'text-emerald-300' },
    gray:   { grad: 'from-gray-500/20 to-gray-500/0',     text: 'text-gray-400'   },
  };
  const a = accentMap[accent];
  return (
    <div className="relative rounded-xl border border-gray-800/80 bg-gray-900/40 p-4 overflow-hidden">
      <div className={`absolute inset-0 bg-gradient-to-br ${a.grad} opacity-60 pointer-events-none`} />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Icon className={`w-3 h-3 ${a.text}`} />
            {label}
          </span>
        </div>
        <div className="text-2xl font-semibold text-gray-50 tabular-nums">{value}</div>
        <div className="text-[11px] text-gray-500 mt-1 truncate">{sub}</div>
      </div>
    </div>
  );
}

// Audit log → human-readable event. Filters out high-frequency session/repo
// chatter (those belong on Sessions/Insights) and renders the remaining
// admin/infra-level events with parsed metadata so the row reads as a
// sentence ("Machine my-laptop registered") instead of a raw UUID.
type AuditDisplay = {
  Icon: React.ComponentType<{ className?: string }>;
  accent: string;        // tag bg/text color
  label: string;         // pill label
  detail: string;        // freeform description on the right
};

const INFRA_ACTIONS = new Set([
  'MACHINE_REGISTERED', 'MACHINE_DELETED',
  'INTEGRATION_CREATED', 'INTEGRATION_UPDATED', 'INTEGRATION_DELETED',
  'GITHUB_APP_INSTALLED', 'GITHUB_APP_LINKED',
  'GITLAB_OAUTH_APP_CONFIGURED', 'GITLAB_OAUTH_CONNECTED', 'GITLAB_OAUTH_DISCONNECTED',
  'AGENT_CREATED', 'AGENT_DELETED', 'AGENT_UPDATED', 'AGENT_RESTORED',
  'AGENT_ENABLED', 'AGENT_DISABLED', 'AGENT_ACCESS_GRANTED', 'AGENT_ACCESS_REVOKED',
  'API_KEY_CREATED', 'API_KEY_REVOKED',
  'MEMBER_ADDED', 'MEMBER_REMOVED', 'MEMBER_LEFT', 'MEMBER_ROLE_CHANGED',
  'MEMBER_KEY_REGENERATED', 'MEMBER_KEY_REVOKED',
  'INVITATION_CREATED', 'INVITATION_ACCEPTED',
  'POLICY_CREATED', 'POLICY_UPDATED', 'POLICY_DELETED', 'POLICY_VIOLATION',
  'WEBHOOK_CREATED', 'WEBHOOK_DELETED',
  'REPO_CREATED', 'REPO_DELETED', 'REPO_IMPORTED',
  'ORG_UPDATED', 'BUDGET_UPDATED', 'PRICING_UPDATED', 'CHAT_CONFIG_UPDATED',
]);

function formatAuditEntry(entry: AuditEntry): AuditDisplay {
  const meta = parseJsonSafe<Record<string, any>>(entry.metadata, {});
  const a = entry.action;

  // Group similar events visually so the strip reads as colored bands.
  if (a.startsWith('MACHINE_')) {
    return {
      Icon: Server,
      accent: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/20',
      label: a === 'MACHINE_REGISTERED' ? 'Machine registered' : 'Machine removed',
      detail: meta.hostname || 'unknown host',
    };
  }
  if (a.startsWith('INTEGRATION_') || a.startsWith('GITHUB_APP_') || a.startsWith('GITLAB_OAUTH_')) {
    const isGh = a.startsWith('GITHUB_APP_');
    const isGl = a.startsWith('GITLAB_OAUTH_');
    const verb = a.endsWith('_DELETED') || a.endsWith('_DISCONNECTED') ? 'disconnected'
      : a.endsWith('_UPDATED') ? 'updated'
      : 'connected';
    const provider = isGh ? 'GitHub' : isGl ? 'GitLab' : (meta.provider || 'integration');
    return {
      Icon: isGh ? Github : isGl ? Gitlab : Plug,
      accent: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/20',
      label: 'Integration',
      detail: `${provider} ${verb}`,
    };
  }
  if (a.startsWith('AGENT_')) {
    const verbMap: Record<string, string> = {
      AGENT_CREATED: 'created', AGENT_DELETED: 'deleted', AGENT_UPDATED: 'updated',
      AGENT_RESTORED: 'restored', AGENT_ENABLED: 'enabled', AGENT_DISABLED: 'disabled',
      AGENT_ACCESS_GRANTED: 'access granted', AGENT_ACCESS_REVOKED: 'access revoked',
    };
    return {
      Icon: Bot,
      accent: 'bg-purple-500/15 text-purple-300 border-purple-500/20',
      label: 'Agent',
      detail: `${meta.name || 'agent'} ${verbMap[a] || a.toLowerCase().replace(/_/g, ' ')}`,
    };
  }
  if (a.startsWith('API_KEY_')) {
    return {
      Icon: Key,
      accent: 'bg-amber-500/15 text-amber-300 border-amber-500/20',
      label: 'API key',
      detail: `${meta.name || 'key'} ${a === 'API_KEY_CREATED' ? 'created' : 'revoked'}`,
    };
  }
  if (a.startsWith('MEMBER_') || a.startsWith('INVITATION_')) {
    const verbMap: Record<string, string> = {
      MEMBER_ADDED: 'added', MEMBER_REMOVED: 'removed', MEMBER_LEFT: 'left',
      MEMBER_ROLE_CHANGED: 'role changed', MEMBER_KEY_REGENERATED: 'key regenerated',
      MEMBER_KEY_REVOKED: 'key revoked',
      INVITATION_CREATED: 'invited', INVITATION_ACCEPTED: 'invitation accepted',
    };
    return {
      Icon: Users,
      accent: 'bg-blue-500/15 text-blue-300 border-blue-500/20',
      label: 'Member',
      detail: `${meta.email || meta.name || 'user'} ${verbMap[a] || ''}`.trim(),
    };
  }
  if (a === 'POLICY_VIOLATION') {
    return {
      Icon: ShieldAlert,
      accent: 'bg-red-500/15 text-red-300 border-red-500/20',
      label: 'Violation',
      detail: meta.description || meta.filepath || 'policy violation',
    };
  }
  if (a.startsWith('POLICY_')) {
    return {
      Icon: Shield,
      accent: 'bg-amber-500/15 text-amber-300 border-amber-500/20',
      label: 'Policy',
      detail: `${meta.name || meta.policyName || 'policy'} ${a === 'POLICY_CREATED' ? 'created' : a === 'POLICY_DELETED' ? 'deleted' : 'updated'}`,
    };
  }
  if (a.startsWith('WEBHOOK_')) {
    return {
      Icon: Webhook,
      accent: 'bg-violet-500/15 text-violet-300 border-violet-500/20',
      label: 'Webhook',
      detail: a === 'WEBHOOK_CREATED' ? 'created' : 'removed',
    };
  }
  if (a.startsWith('REPO_')) {
    const verb = a === 'REPO_CREATED' ? 'created'
      : a === 'REPO_IMPORTED' ? 'imported'
      : 'deleted';
    return {
      Icon: FileCode,
      accent: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
      label: 'Repo',
      detail: `${meta.name || meta.repoName || 'repository'} ${verb}`,
    };
  }
  if (a === 'ORG_UPDATED' || a === 'BUDGET_UPDATED' || a === 'PRICING_UPDATED' || a === 'CHAT_CONFIG_UPDATED') {
    return {
      Icon: Boxes,
      accent: 'bg-gray-500/15 text-gray-300 border-gray-500/20',
      label: 'Settings',
      detail: a.replace(/_/g, ' ').toLowerCase(),
    };
  }
  // Fallback — shouldn't hit since we filter by INFRA_ACTIONS, but render
  // something reasonable rather than blanking the row.
  return {
    Icon: Activity,
    accent: 'bg-gray-500/15 text-gray-300 border-gray-500/20',
    label: a.replace(/_/g, ' ').toLowerCase(),
    detail: '',
  };
}

// Inline copyable command — the empty state needs to make it clear that
// starting a Claude/Cursor/Codex session does NOT register a machine; only
// `origin enable` does. This is the most common confusion on first run.
function CopyableCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={onCopy}
      className="inline-flex items-center gap-2 rounded-md border border-gray-800 bg-gray-900/60 px-3 py-1.5 font-mono text-xs text-indigo-300 hover:border-indigo-500/40 hover:bg-gray-900 transition-colors"
      title="Copy to clipboard"
    >
      <span>{cmd}</span>
      {copied
        ? <Check className="w-3.5 h-3.5 text-emerald-400" />
        : <Copy className="w-3.5 h-3.5 text-gray-500" />}
    </button>
  );
}

export default function Infrastructure() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    Promise.all([
      api.getMachines(),
      api.getAgents().then((data: any) => data.agents || data || []),
      api.getIntegrations().catch(() => []),
      api.getStats().catch(() => null),
      // Fetch a larger window because we filter client-side to infra-only
      // events (machine/integration/agent/policy/etc) and skip session/repo
      // chatter that would otherwise dominate the list.
      api.getAuditLogs({ limit: 50 }).then(r => r.entries).catch(() => []),
    ])
      .then(([m, a, integ, s, audit]) => {
        setMachines(m);
        setAgents(a);
        setIntegrations(integ);
        setStats(s);
        setAuditEntries(audit);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const isOnline = (lastSeen: string) =>
    (Date.now() - new Date(lastSeen).getTime()) < 1000 * 60 * 30;

  const onlineCount = useMemo(
    () => machines.filter(m => isOnline(m.lastSeenAt)).length,
    [machines],
  );
  const activeAgents = agents.filter((a) => a.status === 'ACTIVE').length;
  const catalogKeys = new Set(PROVIDER_CATALOG.map((p) => p.key));
  const visibleIntegrations = integrations.filter((i) => catalogKeys.has(i.provider as any));
  const connectedCount = visibleIntegrations.length;

  // Pipeline metrics — derived entirely from getStats so we don't have to add
  // a backend endpoint. sessionsByDay is the last N days; we slice to 7.
  const sessionsByDay7d = (stats?.sessionsByDay || []).slice(-7);
  const sessions7d = sessionsByDay7d.reduce((s, d) => s + d.count, 0);
  const tokensByDay7d = (stats?.tokensByDay || []).slice(-7);
  const tokens7d = tokensByDay7d.reduce((s, d) => s + d.tokens, 0);
  const lastDayWithSessions = [...sessionsByDay7d].reverse().find(d => d.count > 0);
  const mostRecentMachineLastSeen = machines.length > 0
    ? machines.reduce((latest, m) =>
        new Date(m.lastSeenAt) > new Date(latest) ? m.lastSeenAt : latest,
        machines[0].lastSeenAt)
    : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  const handleDeleteMachine = async (id: string) => {
    setDeleteTarget(null);
    try {
      await api.deleteMachine(id);
      toast('success', 'Machine removed');
      setMachines(prev => prev.filter(x => x.id !== id));
    } catch (err: any) {
      toast('error', err.message || 'Failed to delete machine');
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Infrastructure</h1>
        <p className="text-sm text-gray-500 mt-1">
          Machines reporting to your org and the health of the session pipeline
        </p>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      {/* KPIs — focused on activity / health, not catalog counts. The Agents
          and Integrations counts moved to the compact strip below since they
          duplicate /agents and /settings?tab=integrations. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          accent="indigo"
          label="Machines"
          Icon={Server}
          value={machines.length}
          sub={machines.length === 0
            ? 'None registered'
            : <><span className={onlineCount > 0 ? 'text-emerald-400' : 'text-gray-500'}>{onlineCount} online</span> · {machines.length - onlineCount} idle</>}
        />
        <StatCard
          accent="purple"
          label="Sessions (7d)"
          Icon={Activity}
          value={sessions7d.toLocaleString()}
          sub={tokens7d > 0 ? `${formatTokens(tokens7d)} tokens` : 'No tokens captured'}
        />
        <StatCard
          accent="cyan"
          label="Last activity"
          Icon={Clock}
          value={mostRecentMachineLastSeen
            ? timeAgo(mostRecentMachineLastSeen)
            : <span className="text-gray-500 text-base">—</span>}
          sub={lastDayWithSessions
            ? `${lastDayWithSessions.count} session${lastDayWithSessions.count !== 1 ? 's' : ''} on ${lastDayWithSessions.date.slice(5)}`
            : 'No recent sessions'}
        />
        <StatCard
          accent={onlineCount > 0 ? 'green' : 'gray'}
          label="Status"
          Icon={HeartPulse}
          value={
            <span className="inline-flex items-center gap-2">
              {onlineCount > 0 && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
              )}
              {onlineCount > 0 ? 'Healthy' : 'Idle'}
            </span>
          }
          sub={onlineCount > 0
            ? `${onlineCount} machine${onlineCount !== 1 ? 's' : ''} reporting`
            : 'No recent activity'}
        />
      </div>

      {/* Machines — primary surface, only place machines are managed */}
      <section>
        <header className="flex items-baseline gap-3 mb-3 pb-2 border-b border-white/[0.05]">
          <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.12em]">Machines</h2>
          <span className="text-[11px] text-gray-600">
            {machines.length === 0
              ? 'None registered'
              : `${onlineCount} of ${machines.length} online`}
          </span>
        </header>
        {machines.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-800 px-6 py-10 text-center space-y-4">
            <Server className="w-6 h-6 text-gray-600 mx-auto" />
            <div>
              <p className="text-gray-300 mb-1">No machines registered</p>
              <p className="text-sm text-gray-500 max-w-md mx-auto">
                Starting a Claude/Cursor/Codex session does not register a machine.
                Run this on each developer machine to install hooks and connect it to your org:
              </p>
            </div>
            <CopyableCommand cmd="origin enable" />
            <p className="text-[11px] text-gray-600">
              Already ran it and no machine appears? Check that <code className="text-gray-400 bg-gray-900 px-1 rounded">origin login</code> succeeded and your API key has write access.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {machines.map((m) => {
              const online = isOnline(m.lastSeenAt);
              const tools = parseJsonSafe<string[]>(m.detectedTools, []);
              return (
                <div
                  key={m.id}
                  className="group/row relative rounded-xl border border-white/[0.06] bg-gray-900/40 hover:border-white/[0.12] transition-all"
                >
                  <div
                    className="absolute inset-y-0 left-0 w-0.5 rounded-l-xl"
                    style={{ background: online ? '#10b981' : 'rgba(255,255,255,0.06)' }}
                  />
                  <div className="flex items-center gap-4 pl-5 pr-4 py-3.5">
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{
                        backgroundColor: online ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.04)',
                        color: online ? '#34d399' : '#6b7280',
                        boxShadow: online ? 'inset 0 0 0 1px rgba(16,185,129,0.2)' : undefined,
                      }}
                    >
                      <Server className="w-4 h-4" />
                    </div>

                    <Link to={`/machines/${m.id}`} className="flex items-center gap-2 min-w-0 flex-1 group">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-100 group-hover:text-indigo-300 transition-colors truncate">
                            {m.hostname}
                          </p>
                          {online && (
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-gray-500 font-mono truncate">{m.machineId}</p>
                      </div>
                    </Link>

                    <div className="hidden sm:flex flex-wrap items-center gap-1 max-w-[300px]">
                      {tools.slice(0, 4).map((tool, i) => {
                        const c = agentColor(tool);
                        return (
                          <span
                            key={i}
                            className="text-[11px] px-1.5 py-0.5 rounded font-medium"
                            style={{
                              backgroundColor: `${c}1a`,
                              color: c,
                              border: `1px solid ${c}33`,
                            }}
                          >
                            {tool}
                          </span>
                        );
                      })}
                      {tools.length > 4 && (
                        <span className="text-[11px] text-gray-600 ml-1">+{tools.length - 4}</span>
                      )}
                    </div>

                    <div className="text-right flex-shrink-0">
                      <span className={`text-xs ${online ? 'text-emerald-400 font-medium' : 'text-gray-500'}`}>
                        {online ? 'Online' : timeAgo(m.lastSeenAt)}
                      </span>
                    </div>

                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        setDeleteTarget({ id: m.id, name: m.hostname });
                      }}
                      className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0 p-1 opacity-0 group-hover/row:opacity-100"
                      title="Remove machine"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
            {/* Add another machine — quiet helper at the bottom of the list
                so users know how to scale beyond their first registration. */}
            <div className="flex items-center gap-3 px-5 py-2.5 text-[11px] text-gray-500">
              <span className="text-gray-600">Add another machine:</span>
              <CopyableCommand cmd="origin enable" />
            </div>
          </div>
        )}
      </section>

      {/* Session pipeline — the unique value this page delivers. Answers
          "is data actually flowing?" with sparkline + 7d totals. */}
      <section>
        <header className="flex items-baseline gap-3 mb-3 pb-2 border-b border-white/[0.05]">
          <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.12em]">Session pipeline</h2>
          <span className="text-[11px] text-gray-600">Last 7 days</span>
          <Link to="/insights" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors ml-auto">
            View insights →
          </Link>
        </header>
        {sessions7d === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-800 px-6 py-8 text-center">
            <Activity className="w-6 h-6 text-gray-600 mx-auto mb-2" />
            <p className="text-gray-400 mb-1">No sessions captured this week</p>
            <p className="text-sm text-gray-500">
              Sessions appear once an agent completes a coding turn on a registered machine.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.06] bg-gray-900/40 p-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 items-end">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Sessions</div>
                <div className="text-xl font-semibold text-gray-100 tabular-nums">{sessions7d.toLocaleString()}</div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  {(sessions7d / 7).toFixed(1)}/day avg
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Tokens</div>
                <div className="text-xl font-semibold text-gray-100 tabular-nums">{formatTokens(tokens7d)}</div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  {sessions7d > 0 ? formatTokens(Math.round(tokens7d / sessions7d)) : 0}/session
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Last session</div>
                <div className="text-xl font-semibold text-gray-100">
                  {mostRecentMachineLastSeen ? timeAgo(mostRecentMachineLastSeen) : '—'}
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  {(stats?.policyViolations ?? 0) > 0
                    ? <span className="text-amber-400">{stats?.policyViolations} policy violations</span>
                    : 'No violations'}
                </div>
              </div>
              <div className="flex flex-col items-end">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 self-start">Trend</div>
                <Sparkline
                  data={sessionsByDay7d.map(d => d.count)}
                  color="#a78bfa"
                  width={140}
                  height={40}
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Connected systems — single compact strip replacing the old Agents
          and Integrations sections. Both are duplicates of full pages, so
          here we just summarize counts + offer wayfinding. */}
      <section>
        <header className="flex items-baseline gap-3 mb-3 pb-2 border-b border-white/[0.05]">
          <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.12em]">Connected systems</h2>
        </header>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Agents card */}
          <Link
            to="/agents"
            className="group/card rounded-xl border border-white/[0.06] bg-gray-900/40 p-4 hover:border-white/[0.14] transition-all"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-purple-300" />
                <span className="text-sm font-medium text-gray-200">Agents</span>
                <span className="text-[11px] text-gray-500">
                  {activeAgents} of {agents.length} active
                </span>
              </div>
              <span className="text-xs text-indigo-400 group-hover/card:text-indigo-300">Manage →</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agents.length === 0 ? (
                <span className="text-[11px] text-gray-600">No agents configured</span>
              ) : (
                agents.slice(0, 8).map(a => {
                  const c = agentColor(a.name);
                  const dim = a.status !== 'ACTIVE';
                  return (
                    <span
                      key={a.id}
                      className="text-[11px] px-2 py-0.5 rounded font-medium"
                      style={{
                        backgroundColor: dim ? 'rgba(255,255,255,0.04)' : `${c}1a`,
                        color: dim ? '#6b7280' : c,
                        border: `1px solid ${dim ? 'rgba(255,255,255,0.06)' : `${c}33`}`,
                      }}
                    >
                      {a.name}
                    </span>
                  );
                })
              )}
              {agents.length > 8 && (
                <span className="text-[11px] text-gray-600 self-center">+{agents.length - 8}</span>
              )}
            </div>
          </Link>

          {/* Integrations card */}
          <Link
            to="/settings?tab=integrations"
            className="group/card rounded-xl border border-white/[0.06] bg-gray-900/40 p-4 hover:border-white/[0.14] transition-all"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Plug className="w-4 h-4 text-cyan-300" />
                <span className="text-sm font-medium text-gray-200">Integrations</span>
                <span className="text-[11px] text-gray-500">
                  {connectedCount} of {PROVIDER_CATALOG.length} connected
                </span>
              </div>
              <span className="text-xs text-indigo-400 group-hover/card:text-indigo-300">Settings →</span>
            </div>
            <div className="flex items-center gap-2">
              {PROVIDER_CATALOG.map(({ key, label, Icon, color }) => {
                const connected = integrations.some(i => i.provider === key);
                return (
                  <span
                    key={key}
                    title={`${label}: ${connected ? 'Connected' : 'Not configured'}`}
                    className="w-8 h-8 rounded-lg flex items-center justify-center"
                    style={{
                      backgroundColor: connected ? `${color}1a` : 'rgba(255,255,255,0.03)',
                      color: connected ? color : '#4b5563',
                      boxShadow: connected ? `inset 0 0 0 1px ${color}33` : 'inset 0 0 0 1px rgba(255,255,255,0.04)',
                    }}
                  >
                    <Icon className="w-4 h-4" />
                  </span>
                );
              })}
            </div>
          </Link>
        </div>
      </section>

      {/* Recent activity — admin/infra-level audit events with parsed
          metadata. Session/repo-sync chatter is intentionally filtered out;
          those live on Sessions/Insights. */}
      {(() => {
        const infraEntries = auditEntries.filter(e => INFRA_ACTIONS.has(e.action)).slice(0, 8);
        if (infraEntries.length === 0) return null;
        return (
          <section>
            <header className="flex items-baseline gap-3 mb-3 pb-2 border-b border-white/[0.05]">
              <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.12em]">Recent activity</h2>
              <Link to="/settings?tab=audit" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors ml-auto">
                View all →
              </Link>
            </header>
            <div className="rounded-xl border border-white/[0.06] bg-gray-900/40 divide-y divide-white/[0.04]">
              {infraEntries.map((e) => {
                const d = formatAuditEntry(e);
                return (
                  <div key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border ${d.accent}`}>
                      <d.Icon className="w-3 h-3" />
                      {d.label}
                    </span>
                    <span className="text-xs text-gray-300 truncate flex-1">
                      {d.detail}
                    </span>
                    <span className="text-[11px] text-gray-600 flex-shrink-0">{timeAgo(e.createdAt)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })()}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove Machine"
        message={`Remove "${deleteTarget?.name}" from your organization?`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => deleteTarget && handleDeleteMachine(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
