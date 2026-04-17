// ── Heatmap component ───────────────────────────────────────────────────────

export function ActivityHeatmap({ data }: { data: Record<string, number> }) {
  const today = new Date();
  const cells: Array<{ date: string; count: number; dayOfWeek: number }> = [];

  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    cells.push({ date: key, count: data[key] || 0, dayOfWeek: d.getDay() });
  }

  const weeks: typeof cells[] = [];
  let currentWeek: typeof cells = [];
  for (const cell of cells) {
    if (cell.dayOfWeek === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push(cell);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  const maxCount = Math.max(1, ...Object.values(data));

  function cellColor(count: number) {
    if (count === 0) return 'bg-gray-800/50';
    const intensity = count / maxCount;
    if (intensity < 0.25) return 'bg-indigo-900/60';
    if (intensity < 0.5) return 'bg-indigo-700/70';
    if (intensity < 0.75) return 'bg-indigo-600/80';
    return 'bg-indigo-500';
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-[3px] min-w-fit">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {wi === 0 && week[0]?.dayOfWeek > 0 &&
              Array.from({ length: week[0].dayOfWeek }).map((_, i) => (
                <div key={`pad-${i}`} className="w-[11px] h-[11px]" />
              ))
            }
            {week.map((cell) => (
              <div
                key={cell.date}
                className={`w-[11px] h-[11px] rounded-[2px] ${cellColor(cell.count)}`}
                title={`${cell.date}: ${cell.count} session${cell.count !== 1 ? 's' : ''}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5 mt-2 text-[10px] text-gray-500">
        <span>Less</span>
        <div className="w-[11px] h-[11px] rounded-[2px] bg-gray-800/50" />
        <div className="w-[11px] h-[11px] rounded-[2px] bg-indigo-900/60" />
        <div className="w-[11px] h-[11px] rounded-[2px] bg-indigo-700/70" />
        <div className="w-[11px] h-[11px] rounded-[2px] bg-indigo-600/80" />
        <div className="w-[11px] h-[11px] rounded-[2px] bg-indigo-500" />
        <span>More</span>
      </div>
    </div>
  );
}
