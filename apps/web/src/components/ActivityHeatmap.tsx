import React, { useMemo, useState } from 'react';

interface ActivityHeatmapProps {
  data: { date: string; count: number }[];
  weeks?: number;
}

const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function ActivityHeatmap({ data, weeks = 52 }: ActivityHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; date: string; count: number } | null>(null);

  const { grid, months, maxCount } = useMemo(() => {
    const dataMap = new Map(data.map((d) => [d.date, d.count]));
    const today = new Date();
    const totalDays = weeks * 7;
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - totalDays + 1);
    // Align to start of week (Sunday)
    startDate.setDate(startDate.getDate() - startDate.getDay());

    const cells: Array<{ date: string; count: number; week: number; day: number }> = [];
    let max = 0;
    const monthSet = new Map<number, string>();

    const d = new Date(startDate);
    let weekIdx = 0;

    while (d <= today) {
      const day = d.getDay();
      const key = d.toISOString().split('T')[0];
      const count = dataMap.get(key) || 0;
      if (count > max) max = count;
      cells.push({ date: key, count, week: weekIdx, day });

      if (d.getDate() <= 7 && day === 0) {
        monthSet.set(weekIdx, MONTH_LABELS[d.getMonth()]);
      }

      d.setDate(d.getDate() + 1);
      if (d.getDay() === 0) weekIdx++;
    }

    return { grid: cells, months: monthSet, maxCount: max };
  }, [data, weeks]);

  const getColor = (count: number) => {
    if (count === 0) return 'bg-gray-800';
    const ratio = maxCount > 0 ? count / maxCount : 0;
    if (ratio > 0.75) return 'bg-green-400';
    if (ratio > 0.5) return 'bg-green-500/80';
    if (ratio > 0.25) return 'bg-green-600/60';
    return 'bg-green-700/40';
  };

  const totalWeeks = grid.length > 0 ? grid[grid.length - 1].week + 1 : 0;

  return (
    <div className="relative">
      {/* Month labels */}
      <div className="flex ml-8 mb-1 text-xs text-gray-600" style={{ gap: 0 }}>
        {Array.from({ length: totalWeeks }).map((_, w) => (
          <div key={w} className="flex-shrink-0" style={{ width: 11 }}>
            {months.has(w) ? <span>{months.get(w)}</span> : null}
          </div>
        ))}
      </div>

      <div className="flex gap-0">
        {/* Day labels */}
        <div className="flex flex-col mr-1" style={{ gap: 2 }}>
          {DAY_LABELS.map((label, i) => (
            <div key={i} className="text-xs text-gray-600 h-[9px] leading-[9px]">{label}</div>
          ))}
        </div>

        {/* Grid */}
        <div className="flex" style={{ gap: 2 }}>
          {Array.from({ length: totalWeeks }).map((_, w) => (
            <div key={w} className="flex flex-col" style={{ gap: 2 }}>
              {Array.from({ length: 7 }).map((_, d) => {
                const cell = grid.find((c) => c.week === w && c.day === d);
                if (!cell) return <div key={d} className="w-[9px] h-[9px]" />;
                return (
                  <div
                    key={d}
                    className={`w-[9px] h-[9px] rounded-sm ${getColor(cell.count)} cursor-pointer`}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setTooltip({ x: rect.left, y: rect.top - 30, date: cell.date, count: cell.count });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.count} session{tooltip.count !== 1 ? 's' : ''} on {tooltip.date}
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-1.5 mt-2 ml-8 text-xs text-gray-600">
        <span>Less</span>
        <div className="w-[9px] h-[9px] rounded-sm bg-gray-800" />
        <div className="w-[9px] h-[9px] rounded-sm bg-green-700/40" />
        <div className="w-[9px] h-[9px] rounded-sm bg-green-600/60" />
        <div className="w-[9px] h-[9px] rounded-sm bg-green-500/80" />
        <div className="w-[9px] h-[9px] rounded-sm bg-green-400" />
        <span>More</span>
      </div>
    </div>
  );
}
