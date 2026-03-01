import React from 'react';

interface KpiCardProps {
  label: string;
  value: string | number;
  color?: 'green' | 'amber' | 'red' | 'default';
  subtext?: string;
}

const colorMap = {
  green: 'text-green-400',
  amber: 'text-amber-400',
  red: 'text-red-400',
  default: 'text-gray-100',
};

export default function KpiCard({ label, value, color = 'default', subtext }: KpiCardProps) {
  return (
    <div className="card">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${colorMap[color]}`}>{value}</p>
      {subtext && <p className="text-xs text-gray-500 mt-1">{subtext}</p>}
    </div>
  );
}
