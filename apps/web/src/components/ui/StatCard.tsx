import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export type StatAccent = 'neutral' | 'emerald' | 'indigo' | 'purple' | 'amber' | 'red' | 'sky';

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;          // small text below value
  icon?: React.ReactNode;
  accent?: StatAccent;            // colors the icon + left accent bar
  trend?: {
    value: number;                // % change, signed
    label?: string;               // e.g. "vs last week"
  };
  onClick?: () => void;           // if provided, card is clickable
  className?: string;
}

const ACCENT_ICON: Record<StatAccent, string> = {
  neutral: 'text-gray-500',
  emerald: 'text-emerald-400',
  indigo:  'text-indigo-400',
  purple:  'text-purple-400',
  amber:   'text-amber-400',
  red:     'text-red-400',
  sky:     'text-sky-400',
};

/**
 * StatCard — dashboard grid cell.
 *
 * Replaces the mix of `KpiCard`, inline stat cards in Dashboard / MyDashboard
 * / Snapshots / Compliance / Infrastructure, and one-off gradient cards.
 *
 * @example
 *   <StatCard label="Total Sessions" value="1,234" />
 *   <StatCard
 *     label="AI Cost"
 *     value="$42.18"
 *     sub="all time"
 *     accent="emerald"
 *     trend={{ value: 12, label: 'vs last week' }}
 *   />
 */
export function StatCard({
  label,
  value,
  sub,
  icon,
  accent = 'neutral',
  trend,
  onClick,
  className = '',
}: StatCardProps) {
  const Wrapper = onClick ? 'button' : 'div';
  const interactive = onClick
    ? 'hover:border-gray-700 transition-colors cursor-pointer text-left'
    : '';

  return (
    <Wrapper
      onClick={onClick}
      className={`rounded-xl border border-gray-800/60 bg-gray-900/30 px-4 py-3.5 ${interactive} ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          {label}
        </span>
        {icon && <span className={`${ACCENT_ICON[accent]} flex-shrink-0`}>{icon}</span>}
      </div>
      <div className="mt-1.5 text-2xl font-semibold text-gray-100 tabular-nums">
        {value}
      </div>
      <div className="flex items-center gap-2 mt-1 min-h-[18px]">
        {trend && <Trend value={trend.value} label={trend.label} />}
        {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
      </div>
    </Wrapper>
  );
}

function Trend({ value, label }: { value: number; label?: string }) {
  const up = value > 0;
  const flat = value === 0;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const color = flat ? 'text-gray-500' : up ? 'text-emerald-400' : 'text-red-400';
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${color}`}>
      <Icon className="w-3 h-3" />
      {flat ? '—' : `${up ? '+' : ''}${value.toFixed(0)}%`}
      {label && <span className="text-gray-600 font-normal">{label}</span>}
    </span>
  );
}

export default StatCard;
