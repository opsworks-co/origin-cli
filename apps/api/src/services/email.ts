import { Resend } from 'resend';
import { prisma } from '../db.js';
import { getDailySpend, getSpendByModel, getSpendByUser, getMonthlySpend } from './budget.js';
import { buildWeeklyReportHTML } from './email-templates.js';
import { buildWeeklyDigestHTML } from './email-templates.js';
import type { WeeklyDigestData } from './email-templates.js';

// ---------------------------------------------------------------------------
// Email Service — send emails via Resend
// ---------------------------------------------------------------------------

const FROM_EMAIL = process.env.FROM_EMAIL || 'Origin <reports@getorigin.io>';

function getResendClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

export async function sendEmail(
  to: string | string[],
  subject: string,
  html: string,
): Promise<{ success: boolean; error?: string }> {
  const resend = getResendClient();
  if (!resend) {
    return { success: false, error: 'RESEND_API_KEY not configured' };
  }

  try {
    const recipients = Array.isArray(to) ? to : [to];
    await resend.emails.send({
      from: FROM_EMAIL,
      to: recipients,
      subject,
      html,
    });
    return { success: true };
  } catch (err: any) {
    console.error('[email] Send failed:', err);
    return { success: false, error: err.message };
  }
}

export async function sendTestEmail(to: string): Promise<{ success: boolean; error?: string }> {
  return sendEmail(to, 'Origin — Test Email', `
    <div style="font-family: -apple-system, sans-serif; padding: 20px; background: #111; color: #eee; border-radius: 8px;">
      <h2 style="color: #818cf8;">✅ Origin Email Connected</h2>
      <p>Your email integration with Origin AI Governance is working. You'll receive weekly reports at this address.</p>
      <p style="color: #666; font-size: 12px;">— Origin</p>
    </div>
  `);
}

/**
 * Send weekly report to all admins/owners of an org.
 */
export async function sendWeeklyReport(orgId: string): Promise<void> {
  try {
    // Check if email is enabled for this org
    const emailConfig = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'email' },
    });

    let settings: { enabled: boolean; recipients: string[]; sendDay: string } = {
      enabled: false,
      recipients: [],
      sendDay: 'monday',
    };

    if (emailConfig) {
      try {
        settings = { ...settings, ...JSON.parse(emailConfig.settings) };
      } catch {}
    }

    if (!settings.enabled) return;

    // Get org info
    const org = await prisma.org.findUnique({ where: { id: orgId } });
    if (!org) return;

    // Determine recipients: custom list or all admins
    let recipients = settings.recipients.filter(Boolean);
    if (recipients.length === 0) {
      const admins = await prisma.user.findMany({
        where: { orgId, role: { in: ['ADMIN', 'OWNER'] } },
        select: { email: true },
      });
      recipients = admins.map(a => a.email);
    }

    if (recipients.length === 0) return;

    // Gather data for the report
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      weekSessions,
      monthlySpend,
      dailySpend,
      byModel,
      byUser,
      violations,
    ] = await Promise.all([
      prisma.codingSession.findMany({
        where: {
          createdAt: { gte: weekAgo },
          commit: { repo: { orgId } },
        },
        select: { costUsd: true, tokensUsed: true, linesAdded: true, linesRemoved: true, model: true, status: true },
      }),
      getMonthlySpend(orgId),
      getDailySpend(orgId, 7),
      getSpendByModel(orgId),
      getSpendByUser(orgId),
      prisma.auditLog.count({
        where: { orgId, action: 'POLICY_VIOLATION', createdAt: { gte: weekAgo } },
      }),
    ]);

    const weekCost = weekSessions.reduce((sum, s) => sum + s.costUsd, 0);
    const weekTokens = weekSessions.reduce((sum, s) => sum + s.tokensUsed, 0);
    const weekLines = weekSessions.reduce((sum, s) => sum + s.linesAdded, 0);

    const html = buildWeeklyReportHTML({
      orgName: org.name,
      weekStart: weekAgo.toISOString().split('T')[0],
      weekEnd: now.toISOString().split('T')[0],
      totalSessions: weekSessions.length,
      totalCost: weekCost,
      totalTokens: weekTokens,
      totalLines: weekLines,
      monthlySpend,
      dailySpend,
      byModel,
      byUser: byUser.slice(0, 5),
      violations,
    });

    const subject = `Origin Weekly Report — ${org.name} (${weekAgo.toISOString().split('T')[0]} → ${now.toISOString().split('T')[0]})`;
    const result = await sendEmail(recipients, subject, html);

    if (result.success) {
      console.log(`[email] Weekly report sent to ${recipients.length} recipient(s) for org ${org.name}`);
    } else {
      console.error(`[email] Failed to send weekly report for org ${org.name}:`, result.error);
    }
  } catch (err) {
    console.error('[email] sendWeeklyReport error:', err);
  }
}

// ---------------------------------------------------------------------------
// Weekly Manager Digest — executive summary with cost trends
// ---------------------------------------------------------------------------

/**
 * Gather all data needed for the weekly digest email.
 * Exported so the preview endpoint can reuse it.
 */
export async function generateWeeklyDigestData(orgId: string): Promise<WeeklyDigestData | null> {
  const org = await prisma.org.findUnique({ where: { id: orgId } });
  if (!org) return null;

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [weekSessions, prevWeekSessions, byModel, byUser, violations, totalCommits, aiCommits] = await Promise.all([
    prisma.codingSession.findMany({
      where: { createdAt: { gte: weekAgo }, commit: { repo: { orgId } } },
      select: { costUsd: true, tokensUsed: true, model: true },
    }),
    prisma.codingSession.findMany({
      where: { createdAt: { gte: twoWeeksAgo, lt: weekAgo }, commit: { repo: { orgId } } },
      select: { costUsd: true },
    }),
    getSpendByModel(orgId),
    getSpendByUser(orgId),
    prisma.auditLog.count({
      where: { orgId, action: 'POLICY_VIOLATION', createdAt: { gte: weekAgo } },
    }),
    prisma.commit.count({
      where: { repo: { orgId }, createdAt: { gte: weekAgo } },
    }),
    prisma.commit.count({
      where: { repo: { orgId }, createdAt: { gte: weekAgo }, session: { isNot: null } },
    }),
  ]);

  const weekCost = weekSessions.reduce((sum, s) => sum + s.costUsd, 0);
  const weekTokens = weekSessions.reduce((sum, s) => sum + s.tokensUsed, 0);
  const prevWeekCost = prevWeekSessions.reduce((sum, s) => sum + s.costUsd, 0);

  let costTrend: 'up' | 'down' | 'flat' = 'flat';
  let costTrendPct = 0;
  if (prevWeekCost > 0) {
    costTrendPct = ((weekCost - prevWeekCost) / prevWeekCost) * 100;
    if (costTrendPct > 5) costTrend = 'up';
    else if (costTrendPct < -5) costTrend = 'down';
  }

  const topModel = byModel.length > 0
    ? byModel.sort((a, b) => b.sessions - a.sessions)[0]
    : null;
  const topUser = byUser.length > 0
    ? byUser.sort((a, b) => b.sessions - a.sessions)[0]
    : null;

  const aiCommitPct = totalCommits > 0 ? (aiCommits / totalCommits) * 100 : 0;

  return {
    orgName: org.name,
    weekStart: weekAgo.toISOString().split('T')[0],
    weekEnd: now.toISOString().split('T')[0],
    totalSessions: weekSessions.length,
    totalCost: weekCost,
    totalTokens: weekTokens,
    topModel,
    topUser,
    violations,
    costTrend,
    costTrendPct,
    previousWeekCost: prevWeekCost,
    aiCommitPct,
  };
}

/**
 * Send weekly digest to all ADMIN/OWNER users in the org.
 */
export async function sendWeeklyDigest(orgId: string): Promise<{ success: boolean; html: string; error?: string }> {
  const data = await generateWeeklyDigestData(orgId);
  if (!data) return { success: false, html: '', error: 'Org not found' };

  const html = buildWeeklyDigestHTML(data);
  const subject = `Origin Weekly Digest — ${data.orgName} — Week of ${data.weekStart}`;

  // Get admin/owner emails
  const admins = await prisma.user.findMany({
    where: { orgId, role: { in: ['ADMIN', 'OWNER'] } },
    select: { email: true },
  });
  const recipients = admins.map(a => a.email).filter(Boolean);

  if (recipients.length === 0) {
    console.log(`[email] No admin/owner recipients for digest in org ${data.orgName}`);
    return { success: true, html, error: 'No admin/owner recipients found' };
  }

  const result = await sendEmail(recipients, subject, html);

  if (result.success) {
    console.log(`[email] Weekly digest sent to ${recipients.length} recipient(s) for org ${data.orgName}`);
  } else {
    console.error(`[email] Failed to send weekly digest for org ${data.orgName}:`, result.error);
  }

  return { success: result.success, html, error: result.error };
}
