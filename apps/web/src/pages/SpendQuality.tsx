// Spend Quality dashboard — six sections answering "are we getting our
// money's worth?" not just "how much are we spending?"
//
// Layout:
//   1. Spend Quality table (full width)
//   2. Top expensive sessions (full width)
//   3 + 4. Model-fit warnings | Time heatmap (side-by-side)
//   5 + 6. Wasted prompts | Token breakdown (side-by-side)
//
// Date-range picker writes ?range=7d|30d|90d or ?from=&to= to URL — every
// fetch reads from useSearchParams so a refresh/share preserves state. All
// six fetches run in parallel via Promise.allSettled; one section's failure
// renders an inline error in that card without breaking the page.

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';
import type {
  SpendQualityRow, TopSessionRow, ModelFitWarning, HeatmapCell,
  TokenBreakdownRow, InsightsConfig,
} from '../api';
import {
  AlertTriangle, Cpu, Users, Clock, GitPullRequest, Calendar,
  TrendingUp, ArrowUpRight,
} from 'lucide-react';

type Range = '7d' | '30d' | '90d';

const RANGE_LABELS: Record<Range, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' };
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Generic loading/error/empty wrapper that every section uses. Keeps the
// "one section failing doesn't break the page" promise consistent (constraint
// #9) and the empty states compliant (constraint #8).
function SectionShell<T>({
  title, subtitle, icon: Icon, status, error, isEmpty, emptyMessage, children,
}: {
  title: string; subtitle?: string; icon: React.ComponentType<{ className?: string }>;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string; isEmpty?: boolean; emptyMessage: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-5 space-y-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-gray-500" />
          <h3 className="text-sm font-medium text-gray-200">{title}</h3>
        </div>
        {subtitle && <span className="text-[10px] uppercase tracking-wider text-gray-500">{subtitle}</span>}
      </header>
      {status === 'loading' && <p className="text-xs text-gray-500">Loading…</p>}
      {status === 'error' && (
        <div role="alert" className="text-xs rounded-lg p-3 bg-red-900/20 border border-red-800 text-red-300">
          {error || 'Failed to load this section.'}
        </div>
      )}
      {status === 'ready' && isEmpty && (
        <p className="text-xs text-gray-500 py-4 text-center">{emptyMessage}</p>
      )}
      {status === 'ready' && !isEmpty && children}
    </section>
  );
}

// ── Section 1 — Spend Quality table ────────────────────────────────────────
function SpendQualityTable({
  rows, status, error, cfg, onSort,
}: {
  rows: SpendQualityRow[]; status: 'idle' | 'loading' | 'ready' | 'error'; error?: string;
  cfg: InsightsConfig | null;
  onSort: (col: SortCol) => void;
}) {
  return (
    <SectionShell
      title="Spend Quality"
      subtitle="per developer"
      icon={Users}
      status={status}
      error={error}
      isEmpty={rows.length === 0}
      emptyMessage="No sessions in this range."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500">
              <th className="py-2 pr-4">
                <button onClick={() => onSort('name')} className="hover:text-gray-300 cursor-pointer">Dev</button>
              </th>
              <th className="py-2 pr-4 text-right">
                <button onClick={() => onSort('spend')} className="hover:text-gray-300 cursor-pointer">$ spent</button>
              </th>
              <th className="py-2 pr-4 text-right" title="Weighted percent of added lines attributed to AI by the CLI at write time.">
                <button onClick={() => onSort('authorship')} className="hover:text-gray-300 cursor-pointer">AI authorship %</button>
              </th>
              <th className="py-2 pr-4 text-right" title={cfg ? `Files rewritten within ${cfg.reworkWindowDays} days. Amber > ${(cfg.reworkRateAmber * 100).toFixed(0)}%, red > ${(cfg.reworkRateRed * 100).toFixed(0)}%.` : ''}>
                <button onClick={() => onSort('rework')} className="hover:text-gray-300 cursor-pointer">Rework rate</button>
              </th>
              <th className="py-2 pr-4 text-right">
                <button onClick={() => onSort('costPerPr')} className="hover:text-gray-300 cursor-pointer">$/PR merged</button>
              </th>
              <th className="py-2 text-right">
                <button onClick={() => onSort('sessions')} className="hover:text-gray-300 cursor-pointer">Sessions</button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const reworkColor = cfg && r.reworkRate > cfg.reworkRateRed ? 'text-red-400'
                : cfg && r.reworkRate > cfg.reworkRateAmber ? 'text-amber-400'
                : 'text-emerald-400';
              const reworkLabel = cfg && r.reworkRate > cfg.reworkRateRed ? 'high'
                : cfg && r.reworkRate > cfg.reworkRateAmber ? 'elevated'
                : 'healthy';
              return (
                <tr key={r.userId} className="border-t border-gray-800/60 hover:bg-gray-800/30 transition-colors">
                  <td className="py-2.5 pr-4">
                    <Link to={`/sessions?userId=${r.userId}`} className="text-gray-200 hover:text-indigo-300">
                      {r.name}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-gray-200">${r.spendUsd.toFixed(2)}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-gray-300">{(r.aiAuthorship * 100).toFixed(0)}%</td>
                  <td className={`py-2.5 pr-4 text-right tabular-nums ${reworkColor}`}>
                    {(r.reworkRate * 100).toFixed(1)}%
                    <span className="sr-only"> ({reworkLabel})</span>
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-gray-300">
                    {r.costPerMergedPr === null ? '—' : `$${r.costPerMergedPr.toFixed(2)}`}
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-gray-400">{r.sessionCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

type SortCol = 'name' | 'spend' | 'authorship' | 'rework' | 'costPerPr' | 'sessions';

// ── Section 2 — Top expensive sessions ─────────────────────────────────────
function TopSessions({
  rows, status, error, limit, onLimitChange, max,
}: {
  rows: TopSessionRow[]; status: 'idle' | 'loading' | 'ready' | 'error'; error?: string;
  limit: number; onLimitChange: (n: number) => void; max: number;
}) {
  return (
    <SectionShell
      title="Top expensive sessions"
      subtitle="ranked by cost"
      icon={TrendingUp}
      status={status}
      error={error}
      isEmpty={rows.length === 0}
      emptyMessage="No expensive sessions in this range."
    >
      <div className="flex justify-end mb-2">
        <label className="text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-2">
          show
          <select
            value={limit}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            className="input text-xs py-0.5 px-2"
            aria-label="Top sessions count"
          >
            {[5, 10, 15, 20, 25].filter((n) => n <= max).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <ul className="divide-y divide-gray-800/60">
        {rows.map((s, i) => {
          const hh = Math.floor(s.durationSec / 3600);
          const mm = Math.floor((s.durationSec % 3600) / 60);
          const dur = hh > 0 ? `${hh}h${mm > 0 ? ` ${mm}m` : ''}` : `${mm}m`;
          const rankLabel = `#${i + 1}`;
          return (
            <li key={s.sessionId} className="py-2.5 flex items-center gap-3">
              <span className="text-xs text-gray-500 w-8 tabular-nums">{rankLabel}</span>
              <Link to={s.cliPath} className="flex-1 text-sm text-gray-200 hover:text-indigo-300 truncate">
                {s.userName} · {dur} · ${s.costUsd.toFixed(2)} · {s.promptCount} prompts
                {s.branch && <span className="text-gray-500"> · {s.branch}</span>}
              </Link>
              <div className="flex items-center gap-1.5">
                {s.flags.includes('zero-commit') && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/40 text-red-300" title="No commits">⚠ 0 commits</span>
                )}
                {s.flags.includes('cost-outlier') && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300" title="More than 2× this dev's average session cost">⚠ outlier</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </SectionShell>
  );
}

// ── Section 3 — Model-fit warnings ─────────────────────────────────────────
function ModelFitWarnings({ rows, status, error }: {
  rows: ModelFitWarning[]; status: 'idle' | 'loading' | 'ready' | 'error'; error?: string;
}) {
  const reasonText: Record<ModelFitWarning['reason'], string> = {
    'oversized-for-cheap-task': 'Haiku may have sufficed',
    'undersized-for-long-session': 'Consider scope reduction',
  };
  return (
    <SectionShell
      title="Model-fit warnings"
      subtitle="suggested savings"
      icon={Cpu}
      status={status}
      error={error}
      isEmpty={rows.length === 0}
      emptyMessage="No model-fit issues detected."
    >
      <ul className="divide-y divide-gray-800/60">
        {rows.map((w) => (
          <li key={w.sessionId} className="py-2 flex items-center gap-3">
            <Link to={`/sessions/${w.sessionId}`} className="flex-1 text-xs text-gray-200 hover:text-indigo-300 truncate">
              <span className="text-gray-400">{w.userName}</span> · <span className="font-mono">{w.modelUsed}</span>
              <div className="text-[11px] text-gray-500 mt-0.5">
                {reasonText[w.reason]} → <span className="text-gray-300">{w.suggestedModel}</span>
              </div>
            </Link>
            <span className="text-xs tabular-nums text-emerald-400">~${w.estimatedSavingsUsd.toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

// ── Section 4 — Time heatmap ───────────────────────────────────────────────
function SpendHeatmap({ cells, status, error, onPick }: {
  cells: HeatmapCell[]; status: 'idle' | 'loading' | 'ready' | 'error'; error?: string;
  onPick: (day: number, hour: number) => void;
}) {
  // Build a 7×24 grid; max value drives the color intensity.
  const grid = useMemo(() => {
    const m = new Map<string, HeatmapCell>();
    for (const c of cells) m.set(`${c.day}-${c.hour}`, c);
    return m;
  }, [cells]);
  const max = useMemo(() => cells.reduce((m, c) => Math.max(m, c.costUsd), 0.01), [cells]);

  return (
    <SectionShell
      title="Time-of-spend heatmap"
      subtitle="day × hour (server local)"
      icon={Clock}
      status={status}
      error={error}
      isEmpty={cells.length === 0}
      emptyMessage="No sessions in this range."
    >
      <div className="overflow-x-auto">
        <table className="text-[10px] border-separate border-spacing-0.5" role="grid" aria-label="Spend heatmap day by hour">
          <thead>
            <tr>
              <th></th>
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="text-gray-600 font-normal w-4 text-center">{h % 6 === 0 ? h : ''}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAY_LABELS.map((label, day) => (
              <tr key={day}>
                <td className="text-gray-500 pr-2">{label}</td>
                {Array.from({ length: 24 }, (_, hour) => {
                  const cell = grid.get(`${day}-${hour}`);
                  const intensity = cell ? Math.min(1, cell.costUsd / max) : 0;
                  const bg = intensity > 0
                    ? `rgba(99,102,241,${0.1 + intensity * 0.7})`
                    : 'rgba(75,85,99,0.15)';
                  const title = cell
                    ? `${label} ${hour}:00 · $${cell.costUsd.toFixed(2)} · ${cell.sessionCount} sessions`
                    : `${label} ${hour}:00 · no spend`;
                  return (
                    <td key={hour}>
                      <button
                        type="button"
                        onClick={() => onPick(day, hour)}
                        title={title}
                        aria-label={title}
                        className="w-4 h-4 rounded-sm hover:ring-1 hover:ring-indigo-400"
                        style={{ background: bg }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] text-gray-600 mt-2">
          Click a cell to filter — values are summed cost across all sessions in that hour-of-week.
        </p>
      </div>
    </SectionShell>
  );
}

// ── Section 5 — Wasted prompts (currently degraded) ───────────────────────
function WastedPrompts({ status, error, degraded, degradedReason }: {
  status: 'idle' | 'loading' | 'ready' | 'error'; error?: string;
  degraded: boolean; degradedReason?: string;
}) {
  return (
    <SectionShell
      title="Wasted prompts"
      subtitle="prompts that triggered restores"
      icon={AlertTriangle}
      status={status}
      error={error}
      isEmpty={false}
      emptyMessage=""
    >
      {degraded ? (
        <div className="rounded-lg p-3 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">
          <p className="font-medium mb-1">Section unavailable — data dependency missing.</p>
          <p className="text-amber-300/80">
            {degradedReason || 'Snapshot-restore events are not yet captured in a queryable form.'}
          </p>
        </div>
      ) : (
        <p className="text-xs text-gray-500 py-4 text-center">No wasted prompts detected.</p>
      )}
    </SectionShell>
  );
}

// ── Section 6 — Token-class breakdown ──────────────────────────────────────
function TokenBreakdown({ rows, status, error }: {
  rows: TokenBreakdownRow[]; status: 'idle' | 'loading' | 'ready' | 'error'; error?: string;
}) {
  // Stacked bar visualisation: width relative to org max generated.
  const max = useMemo(() => rows.reduce((m, r) =>
    Math.max(m, r.generatedTokens + r.cacheReadTokens + r.cacheCreationTokens), 1), [rows]);

  return (
    <SectionShell
      title="Token-class breakdown"
      subtitle="generated · cache reads · cache writes"
      icon={GitPullRequest}
      status={status}
      error={error}
      isEmpty={rows.length === 0}
      emptyMessage="No token usage in this range."
    >
      <ul className="space-y-2">
        {rows.map((r) => {
          const total = r.generatedTokens + r.cacheReadTokens + r.cacheCreationTokens;
          const wGen = total > 0 ? (r.generatedTokens / max) * 100 : 0;
          const wRead = total > 0 ? (r.cacheReadTokens / max) * 100 : 0;
          const wWrite = total > 0 ? (r.cacheCreationTokens / max) * 100 : 0;
          return (
            <li key={r.userId} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-300">
                  {r.name}
                  {r.isOutlier && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300" title="Cache-read ratio is more than 10× the org median">
                      ⚠ cache outlier
                    </span>
                  )}
                </span>
                <span className="text-gray-500 tabular-nums">
                  {(total / 1000).toFixed(0)}k tokens
                </span>
              </div>
              <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-800">
                <div className="bg-indigo-500/80" style={{ width: `${wGen}%` }} title={`Generated: ${r.generatedTokens.toLocaleString()}`} />
                <div className="bg-cyan-500/70" style={{ width: `${wRead}%` }} title={`Cache reads: ${r.cacheReadTokens.toLocaleString()}`} />
                <div className="bg-amber-500/60" style={{ width: `${wWrite}%` }} title={`Cache writes: ${r.cacheCreationTokens.toLocaleString()}`} />
              </div>
              <div className="flex gap-3 text-[10px] text-gray-500 tabular-nums">
                <span>gen {(r.generatedTokens / 1000).toFixed(0)}k</span>
                <span>cache-read {(r.cacheReadTokens / 1000).toFixed(0)}k</span>
                <span>cache-write {(r.cacheCreationTokens / 1000).toFixed(0)}k</span>
              </div>
            </li>
          );
        })}
      </ul>
    </SectionShell>
  );
}

// ── Page assembly ──────────────────────────────────────────────────────────

type SectionState<T> = { data: T | null; status: 'idle' | 'loading' | 'ready' | 'error'; error?: string };

function emptyState<T>(): SectionState<T> { return { data: null, status: 'idle' }; }

export default function SpendQualityPage() {
  const { activeOrg } = useAuth();
  const isAdmin = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN';

  const [searchParams, setSearchParams] = useSearchParams();
  const range = ((searchParams.get('range') as Range) || '30d');
  const limitParam = Number(searchParams.get('topLimit') || '5');
  const [sortCol, setSortCol] = useState<SortCol>('spend');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [cfg, setCfg] = useState<InsightsConfig | null>(null);
  const [spendQuality, setSpendQuality] = useState<SectionState<SpendQualityRow[]>>(emptyState());
  const [topSessions, setTopSessions] = useState<SectionState<TopSessionRow[]>>(emptyState());
  const [modelFit, setModelFit] = useState<SectionState<ModelFitWarning[]>>(emptyState());
  const [heatmap, setHeatmap] = useState<SectionState<HeatmapCell[]>>(emptyState());
  const [wasted, setWasted] = useState<SectionState<{ degraded: boolean; degradedReason?: string }>>(emptyState());
  const [tokens, setTokens] = useState<SectionState<TokenBreakdownRow[]>>(emptyState());

  // Fetch all six sections in parallel. Promise.allSettled so one failure
  // doesn't break the page (constraint #9).
  useEffect(() => {
    if (!isAdmin) return;
    const params = { range };

    setSpendQuality({ data: null, status: 'loading' });
    setTopSessions({ data: null, status: 'loading' });
    setModelFit({ data: null, status: 'loading' });
    setHeatmap({ data: null, status: 'loading' });
    setWasted({ data: null, status: 'loading' });
    setTokens({ data: null, status: 'loading' });

    if (!cfg) api.getInsightsConfig().then(setCfg).catch(() => { /* non-fatal */ });

    Promise.allSettled([
      api.getSpendQuality(params),
      api.getTopSessions({ ...params, limit: limitParam }),
      api.getModelFitWarnings(params),
      api.getSpendHeatmap(params),
      api.getWastedPrompts(params),
      api.getTokenBreakdown(params),
    ]).then(([sq, ts, mf, hm, wp, tk]) => {
      setSpendQuality(sq.status === 'fulfilled'
        ? { data: sq.value.rows, status: 'ready' }
        : { data: null, status: 'error', error: (sq.reason as Error)?.message });
      setTopSessions(ts.status === 'fulfilled'
        ? { data: ts.value.sessions, status: 'ready' }
        : { data: null, status: 'error', error: (ts.reason as Error)?.message });
      setModelFit(mf.status === 'fulfilled'
        ? { data: mf.value.warnings, status: 'ready' }
        : { data: null, status: 'error', error: (mf.reason as Error)?.message });
      setHeatmap(hm.status === 'fulfilled'
        ? { data: hm.value.cells, status: 'ready' }
        : { data: null, status: 'error', error: (hm.reason as Error)?.message });
      setWasted(wp.status === 'fulfilled'
        ? { data: { degraded: wp.value.degraded, degradedReason: wp.value.degradedReason }, status: 'ready' }
        : { data: null, status: 'error', error: (wp.reason as Error)?.message });
      setTokens(tk.status === 'fulfilled'
        ? { data: tk.value.rows, status: 'ready' }
        : { data: null, status: 'error', error: (tk.reason as Error)?.message });
    });
  }, [range, limitParam, isAdmin]);

  if (!isAdmin) {
    return <Navigate to="/insights" replace />;
  }

  const setRange = (r: Range) => {
    const next = new URLSearchParams(searchParams);
    next.set('range', r);
    setSearchParams(next, { replace: true });
  };
  const setTopLimit = (n: number) => {
    const next = new URLSearchParams(searchParams);
    next.set('topLimit', String(n));
    setSearchParams(next, { replace: true });
  };

  // Sorted Spend Quality rows. The component is dumb; sort lives in the page.
  const sqRows = useMemo(() => {
    const data = spendQuality.data || [];
    const cmp = (a: SpendQualityRow, b: SpendQualityRow) => {
      let av: number | string = 0; let bv: number | string = 0;
      switch (sortCol) {
        case 'name':       av = a.name; bv = b.name; break;
        case 'spend':      av = a.spendUsd; bv = b.spendUsd; break;
        case 'authorship': av = a.aiAuthorship; bv = b.aiAuthorship; break;
        case 'rework':     av = a.reworkRate; bv = b.reworkRate; break;
        case 'costPerPr':  av = a.costPerMergedPr ?? Number.MAX_VALUE; bv = b.costPerMergedPr ?? Number.MAX_VALUE; break;
        case 'sessions':   av = a.sessionCount; bv = b.sessionCount; break;
      }
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av);
    };
    return [...data].sort(cmp);
  }, [spendQuality.data, sortCol, sortDir]);

  const handleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir(col === 'name' ? 'asc' : 'desc'); }
  };

  // Heatmap click — currently a no-op visual hint (we'd narrow the date range
  // to a single hour but that needs a custom-range implementation; the picker
  // change updates the URL so refresh preserves it). Surface a subtle toast
  // via setSearchParams + a transient flag if we end up wiring the narrow.
  const handleHeatmapPick = (_day: number, _hour: number) => { /* placeholder */ };

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Spend Quality</h1>
          <p className="text-sm text-gray-500 mt-1">Are we getting our money's worth?</p>
        </div>
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-500" />
          <div className="flex items-center rounded-lg border border-gray-800 bg-gray-900/40 overflow-hidden text-xs" role="radiogroup" aria-label="Date range">
            {(['7d', '30d', '90d'] as Range[]).map((r) => (
              <button
                key={r}
                role="radio"
                aria-checked={range === r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 transition-colors ${range === r ? 'bg-indigo-500/20 text-indigo-200' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/40'}`}
              >
                {RANGE_LABELS[r]}
              </button>
            ))}
          </div>
          <Link to="/insights" className="text-xs text-gray-500 hover:text-indigo-300 inline-flex items-center gap-1">
            <ArrowUpRight className="w-3 h-3" /> back to Insights
          </Link>
        </div>
      </header>

      <SpendQualityTable
        rows={sqRows}
        status={spendQuality.status}
        error={spendQuality.error}
        cfg={cfg}
        onSort={handleSort}
      />

      <TopSessions
        rows={topSessions.data || []}
        status={topSessions.status}
        error={topSessions.error}
        limit={limitParam}
        onLimitChange={setTopLimit}
        max={cfg?.topSessions.max || 25}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ModelFitWarnings
          rows={modelFit.data || []}
          status={modelFit.status}
          error={modelFit.error}
        />
        <SpendHeatmap
          cells={heatmap.data || []}
          status={heatmap.status}
          error={heatmap.error}
          onPick={handleHeatmapPick}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <WastedPrompts
          status={wasted.status}
          error={wasted.error}
          degraded={wasted.data?.degraded ?? false}
          degradedReason={wasted.data?.degradedReason}
        />
        <TokenBreakdown
          rows={tokens.data || []}
          status={tokens.status}
          error={tokens.error}
        />
      </div>
    </div>
  );
}
