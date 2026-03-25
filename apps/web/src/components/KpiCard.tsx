import React from 'react';
import { Link } from 'react-router-dom';
import { LucideIcon } from 'lucide-react';

interface KpiCardProps {
  label: string;
  value: string | number;
  color?: 'green' | 'amber' | 'red' | 'purple' | 'default';
  subtext?: string;
  to?: string;
  icon?: LucideIcon;
  sparkline?: React.ReactNode;
}

const colorMap = {
  green: 'text-emerald-400',
  amber: 'text-amber-400',
  red: 'text-red-400',
  purple: 'text-purple-400',
  default: 'text-gray-100',
};

const iconBgMap = {
  green: 'bg-emerald-500/10 text-emerald-400',
  amber: 'bg-amber-500/10 text-amber-400',
  red: 'bg-red-500/10 text-red-400',
  purple: 'bg-purple-500/10 text-purple-400',
  default: 'bg-white/[0.04] text-gray-400',
};

export default function KpiCard({ label, value, color = 'default', subtext, to, icon: Icon, sparkline }: KpiCardProps) {
  const content = (
    <div className="flex items-start justify-between">
      <div className="min-w-0 flex-1">
        <p className="section-title mb-2">{label}</p>
        <p className={`text-2xl font-semibold tracking-tight ${colorMap[color]}`}>{value}</p>
        {sparkline && <div className="mt-2">{sparkline}</div>}
        {subtext && <p className="text-xs text-gray-500 mt-1.5">{subtext}</p>}
      </div>
      {Icon && (
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBgMap[color]}`}>
          <Icon className="w-[18px] h-[18px]" />
        </div>
      )}
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="card hover:bg-white/[0.03] hover:border-white/[0.1] transition-all duration-150 cursor-pointer block">
        {content}
      </Link>
    );
  }

  return <div className="card">{content}</div>;
}
