import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export function Trend({ current, previous }: { current: number; previous: number }) {
  const diff = previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;
  const up = diff > 0;
  const flat = diff === 0;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {flat ? (
        <Minus className="w-3 h-3 text-gray-500" />
      ) : up ? (
        <TrendingUp className="w-3 h-3 text-green-400" />
      ) : (
        <TrendingDown className="w-3 h-3 text-red-400" />
      )}
      <span className={flat ? 'text-gray-500' : up ? 'text-green-400' : 'text-red-400'}>
        {flat ? '—' : `${up ? '+' : ''}${diff.toFixed(0)}%`}
      </span>
      <span className="text-gray-600">vs last week</span>
    </div>
  );
}
