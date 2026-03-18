// ---------------------------------------------------------------------------
// Email HTML Templates — inline CSS for maximum email client compatibility
// ---------------------------------------------------------------------------

interface WeeklyReportData {
  orgName: string;
  weekStart: string;
  weekEnd: string;
  totalSessions: number;
  totalCost: number;
  totalTokens: number;
  totalLines: number;
  monthlySpend: number;
  dailySpend: Array<{ date: string; cost: number }>;
  byModel: Array<{ model: string; cost: number; sessions: number }>;
  byUser: Array<{ userId: string; name: string; cost: number; sessions: number }>;
  violations: number;
}

export function buildWeeklyReportHTML(data: WeeklyReportData): string {
  const modelRows = data.byModel
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)
    .map(m => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #333; color: #ddd;">${m.model}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #333; color: #ddd; text-align: right;">${m.sessions}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #333; color: #ddd; text-align: right;">$${m.cost.toFixed(2)}</td>
      </tr>
    `).join('');

  const userRows = data.byUser
    .sort((a, b) => b.sessions - a.sessions)
    .map(u => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #333; color: #ddd;">${u.name}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #333; color: #ddd; text-align: right;">${u.sessions}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #333; color: #ddd; text-align: right;">$${u.cost.toFixed(2)}</td>
      </tr>
    `).join('');

  // Daily cost bar chart (CSS-based)
  const maxDailyCost = Math.max(...data.dailySpend.map(d => d.cost), 0.01);
  const dailyBars = data.dailySpend.map(d => {
    const pct = Math.round((d.cost / maxDailyCost) * 100);
    const day = d.date.slice(5); // MM-DD
    return `
      <td style="vertical-align: bottom; padding: 2px; text-align: center;">
        <div style="background: #6366f1; width: 100%; height: ${pct}px; max-height: 60px; min-height: ${d.cost > 0 ? 2 : 0}px; border-radius: 2px 2px 0 0;"></div>
        <div style="font-size: 9px; color: #666; margin-top: 2px;">${day}</div>
      </td>
    `;
  }).join('');

  const ORIGIN_URL = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 16px;">

    <!-- Header -->
    <div style="text-align: center; margin-bottom: 24px;">
      <h1 style="color: #818cf8; font-size: 20px; margin: 0;">📊 Origin Weekly Report</h1>
      <p style="color: #666; font-size: 13px; margin: 8px 0 0;">${data.orgName} — ${data.weekStart} → ${data.weekEnd}</p>
    </div>

    <!-- KPI Cards -->
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
      <tr>
        <td style="width: 25%; padding: 4px;">
          <div style="background: #1a1a2e; border: 1px solid #333; border-radius: 8px; padding: 16px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #e0e0e0;">${data.totalSessions}</div>
            <div style="font-size: 11px; color: #888; margin-top: 4px;">Sessions</div>
          </div>
        </td>
        <td style="width: 25%; padding: 4px;">
          <div style="background: #1a1a2e; border: 1px solid #333; border-radius: 8px; padding: 16px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #e0e0e0;">$${data.totalCost.toFixed(2)}</div>
            <div style="font-size: 11px; color: #888; margin-top: 4px;">Week Cost</div>
          </div>
        </td>
        <td style="width: 25%; padding: 4px;">
          <div style="background: #1a1a2e; border: 1px solid #333; border-radius: 8px; padding: 16px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #e0e0e0;">${(data.totalLines / 1000).toFixed(1)}k</div>
            <div style="font-size: 11px; color: #888; margin-top: 4px;">Lines Added</div>
          </div>
        </td>
        <td style="width: 25%; padding: 4px;">
          <div style="background: ${data.violations > 0 ? '#2a1a1a' : '#1a1a2e'}; border: 1px solid ${data.violations > 0 ? '#4a2020' : '#333'}; border-radius: 8px; padding: 16px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: ${data.violations > 0 ? '#ef4444' : '#e0e0e0'};">${data.violations}</div>
            <div style="font-size: 11px; color: #888; margin-top: 4px;">Violations</div>
          </div>
        </td>
      </tr>
    </table>

    <!-- Monthly Spend -->
    <div style="background: #1a1a2e; border: 1px solid #333; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
      <div style="font-size: 12px; color: #888;">Monthly Spend (MTD)</div>
      <div style="font-size: 28px; font-weight: bold; color: #818cf8; margin-top: 4px;">$${data.monthlySpend.toFixed(2)}</div>
    </div>

    <!-- Daily Spend Chart -->
    ${data.dailySpend.length > 0 ? `
    <div style="background: #1a1a2e; border: 1px solid #333; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
      <div style="font-size: 12px; color: #888; margin-bottom: 8px;">Daily Spend</div>
      <table style="width: 100%; height: 80px; border-collapse: collapse;">
        <tr>${dailyBars}</tr>
      </table>
    </div>
    ` : ''}

    <!-- By Model -->
    ${modelRows ? `
    <div style="background: #1a1a2e; border: 1px solid #333; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
      <div style="font-size: 12px; color: #888; margin-bottom: 12px;">By Model</div>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <th style="padding: 6px 12px; text-align: left; font-size: 11px; color: #666; border-bottom: 1px solid #333;">Model</th>
          <th style="padding: 6px 12px; text-align: right; font-size: 11px; color: #666; border-bottom: 1px solid #333;">Sessions</th>
          <th style="padding: 6px 12px; text-align: right; font-size: 11px; color: #666; border-bottom: 1px solid #333;">Cost</th>
        </tr>
        ${modelRows}
      </table>
    </div>
    ` : ''}

    <!-- Top Contributors -->
    ${userRows ? `
    <div style="background: #1a1a2e; border: 1px solid #333; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
      <div style="font-size: 12px; color: #888; margin-bottom: 12px;">Top Contributors</div>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <th style="padding: 6px 12px; text-align: left; font-size: 11px; color: #666; border-bottom: 1px solid #333;">Name</th>
          <th style="padding: 6px 12px; text-align: right; font-size: 11px; color: #666; border-bottom: 1px solid #333;">Sessions</th>
          <th style="padding: 6px 12px; text-align: right; font-size: 11px; color: #666; border-bottom: 1px solid #333;">Cost</th>
        </tr>
        ${userRows}
      </table>
    </div>
    ` : ''}

    <!-- CTA -->
    <div style="text-align: center; margin-top: 24px;">
      <a href="${ORIGIN_URL}/dashboard" style="display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 12px 32px; border-radius: 8px; font-size: 14px; font-weight: 600;">View Full Dashboard</a>
    </div>

    <!-- Footer -->
    <div style="text-align: center; margin-top: 32px; padding-top: 16px; border-top: 1px solid #222;">
      <p style="color: #555; font-size: 11px; margin: 0;">Origin AI Governance — <a href="${ORIGIN_URL}" style="color: #818cf8;">getorigin.io</a></p>
    </div>
  </div>
</body>
</html>`;
}
