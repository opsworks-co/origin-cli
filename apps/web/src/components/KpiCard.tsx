import React from 'react';
import { Link } from 'react-router-dom';

interface KpiCardProps {
  label: string;
  value: string | number;
  color?: 'green' | 'amber' | 'red' | 'purple' | 'default';
  subtext?: string;
  to?: string;
}

const colorMap = {
  green: 'text-green-400',
  amber: 'text-amber-400',
  red: 'text-red-400',
  purple: 'text-purple-400',
  default: 'text-gray-100',
};

export default function KpiCard({ label, value, color = 'default', subtext, to }: KpiCardProps) {
  const content = (
    <>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${colorMap[color]}`}>{value}</p>
      {subtext && <p className="text-xs text-gray-500 mt-1">{subtext}</p>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className="card hover:border-gray-600 transition-colors cursor-pointer">
        {content}
      </Link>
    );
  }

  return <div className="card">{content}</div>;
}
