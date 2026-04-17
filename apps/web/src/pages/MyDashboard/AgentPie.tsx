// ── Agent pie chart ─────────────────────────────────────────────────────────

const COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

export function AgentPie({ data }: { data: Array<{ agentName: string; sessions: number }> }) {
  const total = data.reduce((s, d) => s + d.sessions, 0);
  if (total === 0) return <div className="text-xs text-gray-600 text-center py-6">No sessions yet</div>;

  let cumAngle = 0;
  const slices = data.map((d, i) => {
    const angle = (d.sessions / total) * 360;
    const start = cumAngle;
    cumAngle += angle;
    return { ...d, start, angle, color: COLORS[i % COLORS.length] };
  });

  function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
  }

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 100 100" className="w-24 h-24 flex-shrink-0">
        {slices.length === 1 ? (
          <circle cx="50" cy="50" r="45" fill={slices[0].color} />
        ) : (
          slices.map((s, i) => (
            <path key={i} d={describeArc(50, 50, 45, s.start, s.start + s.angle)} fill={s.color} />
          ))
        )}
        <circle cx="50" cy="50" r="25" className="fill-gray-900" />
      </svg>
      <div className="space-y-1">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-gray-300">{s.agentName}</span>
            <span className="text-gray-600">{((s.sessions / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
