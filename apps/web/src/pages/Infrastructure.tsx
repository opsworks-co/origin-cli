import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { Machine, Agent, IntegrationConfig } from '../api';
import { timeAgo } from '../utils';
import {
  Server, Bot, Plug, HeartPulse, Trash2,
  Github, Gitlab, Slack, Mail, Cpu,
} from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { agentColor } from './MyDashboard/utils';

// Provider catalog drives both the integrations strip and the bottom grid.
// Centralised so the order, color, and icon stay in sync between the two
// surfaces — accidental divergence (e.g. icon mismatch) was easy in the
// old version where each surface declared its own list.
const PROVIDER_CATALOG: Array<{
  key: 'github' | 'gitlab' | 'slack' | 'llm' | 'email';
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  color: string;
}> = [
  { key: 'github', label: 'GitHub', Icon: Github, color: '#a1a1aa' }, // neutral; GitHub's brand mark is monochrome
  { key: 'gitlab', label: 'GitLab', Icon: Gitlab, color: '#fc6d26' },
  { key: 'slack',  label: 'Slack',  Icon: Slack,  color: '#4a154b' },
  { key: 'llm',    label: 'LLM',    Icon: Cpu,    color: '#a78bfa' },
  { key: 'email',  label: 'Email',  Icon: Mail,   color: '#60a5fa' },
];

// Gradient stat card matching the Dashboard's StatCard treatment so the
// page chrome reads as one product, not three. Accepts a custom accent
// because the Status card flips between green (healthy) and gray (idle).
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

export default function Infrastructure() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    Promise.all([
      api.getMachines(),
      api.getAgents().then((data: any) => data.agents || data || []),
      api.getIntegrations().catch(() => []),
    ])
      .then(([m, a, integ]) => {
        setMachines(m);
        setAgents(a);
        setIntegrations(integ);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  const isOnline = (lastSeen: string) =>
    (Date.now() - new Date(lastSeen).getTime()) < 1000 * 60 * 30;

  const onlineCount = machines.filter(m => isOnline(m.lastSeenAt)).length;
  const activeAgents = agents.filter((a) => a.status === 'ACTIVE').length;
  // Counts of integrations that come from the curated catalog. We avoid
  // counting "internal" providers like budget_user_limits / budget_agent_limits
  // that aren't user-facing integrations — those existed in the old summary
  // string and made the count read inflated (7 instead of 3 real providers).
  const catalogKeys = new Set(PROVIDER_CATALOG.map((p) => p.key));
  const visibleIntegrations = integrations.filter((i) => catalogKeys.has(i.provider as any));
  const connectedCount = visibleIntegrations.length;

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
      {/* Page header — matches Dashboard / Insights / Agents pattern */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Infrastructure</h1>
        <p className="text-sm text-gray-500 mt-1">
          Machines, integrations, and agents connected to your org
        </p>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      {/* Summary KPIs — gradient style. The Status card pulses green when
          machines are reporting; goes neutral gray when idle. */}
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
          label="Agents"
          Icon={Bot}
          value={agents.length}
          sub={`${activeAgents} active`}
        />
        <StatCard
          accent="cyan"
          label="Integrations"
          Icon={Plug}
          value={connectedCount}
          sub={connectedCount === 0
            ? 'None connected'
            : `${connectedCount} of ${PROVIDER_CATALOG.length} configured`}
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

      {/* Machines */}
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
          <div className="rounded-xl border border-dashed border-gray-800 px-6 py-10 text-center">
            <Server className="w-6 h-6 text-gray-600 mx-auto mb-2" />
            <p className="text-gray-400 mb-1">No machines registered</p>
            <p className="text-sm text-gray-500">
              Run <code className="text-indigo-400 bg-gray-800 px-1.5 py-0.5 rounded text-xs font-mono">origin init</code> on a developer machine to register it.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {machines.map((m) => {
              const online = isOnline(m.lastSeenAt);
              const tools: string[] = (() => {
                try { return JSON.parse(m.detectedTools); } catch { return []; }
              })();
              return (
                <div
                  key={m.id}
                  className="group/row relative rounded-xl border border-white/[0.06] bg-gray-900/40 hover:border-white/[0.12] transition-all"
                >
                  {/* Online status edge — thin colored bar on the left */}
                  <div
                    className="absolute inset-y-0 left-0 w-0.5 rounded-l-xl"
                    style={{ background: online ? '#10b981' : 'rgba(255,255,255,0.06)' }}
                  />
                  <div className="flex items-center gap-4 pl-5 pr-4 py-3.5">
                    {/* Machine icon */}
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

                    {/* Status + hostname */}
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

                    {/* Tools / detected agents */}
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

                    {/* Last seen */}
                    <div className="text-right flex-shrink-0">
                      <span className={`text-xs ${online ? 'text-emerald-400 font-medium' : 'text-gray-500'}`}>
                        {online ? 'Online' : timeAgo(m.lastSeenAt)}
                      </span>
                    </div>

                    {/* Delete — hover-only to keep the row clean */}
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
          </div>
        )}
      </section>

      {/* Agents — brand-colored cards matching /agents */}
      <section>
        <header className="flex items-baseline gap-3 mb-3 pb-2 border-b border-white/[0.05]">
          <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.12em]">Agents</h2>
          <span className="text-[11px] text-gray-600">
            {agents.length === 0 ? 'None configured' : `${activeAgents} of ${agents.length} active`}
          </span>
          <Link to="/agents" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors ml-auto">
            Manage agents →
          </Link>
        </header>
        {agents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-800 px-6 py-10 text-center">
            <Bot className="w-6 h-6 text-gray-600 mx-auto mb-2" />
            <p className="text-gray-400 mb-1">No agents configured</p>
            <p className="text-sm text-gray-500">
              Create an agent in the <Link to="/agents" className="text-indigo-400 hover:text-indigo-300">Agents</Link> page.
            </p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {agents.map((a) => {
              const isActive = a.status === 'ACTIVE';
              const color = agentColor(a.name);
              return (
                <Link
                  key={a.id}
                  to={`/agents/${a.id}`}
                  className={`group/agent relative rounded-xl border bg-gray-900/40 px-4 py-3.5 overflow-hidden transition-all ${
                    isActive
                      ? 'border-white/[0.06] hover:border-white/[0.14] hover:-translate-y-0.5'
                      : 'border-white/[0.04] opacity-60 hover:opacity-100'
                  }`}
                  onMouseEnter={(e) => {
                    if (isActive) (e.currentTarget as HTMLAnchorElement).style.boxShadow = `0 8px 24px -12px ${color}55`;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLAnchorElement).style.boxShadow = '';
                  }}
                >
                  <div
                    className="absolute inset-x-0 top-0 h-px"
                    style={{ background: isActive ? `linear-gradient(90deg, transparent, ${color}, transparent)` : 'transparent' }}
                  />
                  <div className="relative flex items-center gap-3">
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{
                        backgroundColor: isActive ? `${color}1a` : 'rgba(255,255,255,0.04)',
                        color: isActive ? color : '#6b7280',
                        boxShadow: isActive ? `inset 0 0 0 1px ${color}33` : undefined,
                      }}
                    >
                      <Bot className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-100 truncate">{a.name}</p>
                        <span
                          className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold ${
                            isActive
                              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                              : 'bg-gray-700/40 text-gray-500 border border-gray-700'
                          }`}
                        >
                          {a.status}
                        </span>
                      </div>
                      <p className="text-[11px] text-gray-500 mt-0.5 font-mono truncate">
                        {a.slug} · {a.model}
                      </p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Integrations — brand-colored tile per provider. Logo + connected
          state at a glance, no comma-separated wall of text anywhere. */}
      <section>
        <header className="flex items-baseline gap-3 mb-3 pb-2 border-b border-white/[0.05]">
          <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.12em]">Integrations</h2>
          <span className="text-[11px] text-gray-600">
            {connectedCount} of {PROVIDER_CATALOG.length} connected
          </span>
          <Link to="/settings?tab=integrations" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors ml-auto">
            Settings →
          </Link>
        </header>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {PROVIDER_CATALOG.map(({ key, label, Icon, color }) => {
            const connected = integrations.some(i => i.provider === key);
            return (
              <Link
                key={key}
                to="/settings?tab=integrations"
                className={`group/int relative rounded-xl border bg-gray-900/40 px-4 py-4 flex flex-col items-center text-center transition-all ${
                  connected
                    ? 'border-white/[0.06] hover:border-white/[0.14] hover:-translate-y-0.5'
                    : 'border-dashed border-gray-800 hover:border-gray-700'
                }`}
                onMouseEnter={(e) => {
                  if (connected) (e.currentTarget as HTMLAnchorElement).style.boxShadow = `0 8px 24px -12px ${color}55`;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.boxShadow = '';
                }}
              >
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center mb-2"
                  style={{
                    backgroundColor: connected ? `${color}1a` : 'rgba(255,255,255,0.04)',
                    color: connected ? color : '#6b7280',
                    boxShadow: connected ? `inset 0 0 0 1px ${color}33` : undefined,
                  }}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <span className="text-sm font-medium text-gray-100">{label}</span>
                {connected ? (
                  <span className="inline-flex items-center gap-1 mt-1.5 text-[10px] uppercase tracking-wider font-medium text-emerald-400">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                    </span>
                    Connected
                  </span>
                ) : (
                  <span className="mt-1.5 text-[10px] uppercase tracking-wider font-medium text-gray-500 group-hover/int:text-indigo-400 transition-colors">
                    Set up →
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </section>

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
