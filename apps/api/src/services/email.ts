import { Resend } from 'resend';
import { prisma } from '../db.js';
import { getDailySpend, getSpendByModel, getSpendByUser, getMonthlySpend } from './budget.js';
import { buildWeeklyReportHTML } from './email-templates.js';

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
