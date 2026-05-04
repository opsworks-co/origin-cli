import React, { useEffect, useState } from 'react';
import { getBudget } from '../api';
import type { BudgetData } from '../api';

// Compact spend indicator that lives next to the "Budgets" nav item.
// At-a-glance signal — green if well under, amber when ≥80%, red when ≥100% —
// so admins notice runaway spend even when they're not on the Budget page.
// Polls every 60s; quietly hides if no budget is configured.
export default function BudgetPill({ className = '' }: { className?: string }) {
  const [data, setData] = useState<BudgetData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await getBudget();
        if (!cancelled) setData(res);
      } catch {
        // 401/403/network — pill just stays hidden, no UI noise.
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!data) return null;
  const limit = data.config.monthlyLimit;
  const spent = data.currentSpend.monthly;
  const period = data.config.period || 'monthly';
  const periodSuffix = period === 'daily' ? '/d' : period === 'weekly' ? '/w' : '/mo';

  // Show a soft "$x" chip even with no limit configured so admins still
  // see live spend. Once a limit is set, switch to the threshold-coloured
  // ratio chip.
  if (!limit || limit <= 0) {
    if (spent <= 0) return null;
    return (
      <span
        className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded-md bg-gray-500/10 text-gray-400 ${className}`}
        title={`No budget limit set — current ${period} spend $${spent.toFixed(2)}`}
      >
        ${spent.toFixed(spent < 10 ? 2 : 0)}
      </span>
    );
  }

  const pct = (spent / limit) * 100;
  const tier = pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'green';
  const tone =
    tier === 'red'
      ? 'bg-red-500/15 text-red-300 border border-red-500/30'
      : tier === 'amber'
      ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
      : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';

  return (
    <span
      className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded-md ${tone} ${className}`}
      title={`${pct.toFixed(0)}% of ${period} budget — $${spent.toFixed(2)} of $${limit.toFixed(0)}`}
    >
      {pct < 1 ? '<1' : pct.toFixed(0)}%{periodSuffix}
    </span>
  );
}
