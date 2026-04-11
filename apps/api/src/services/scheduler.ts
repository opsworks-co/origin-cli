import cron from 'node-cron';
import { prisma } from '../db.js';
import { sendWeeklyReport, sendWeeklyDigest } from './email.js';
import { sendSlackNotification } from './slack.js';
import { resetMonthlyAlerts, getMonthlySpend, getSpendByModel } from './budget.js';

// ---------------------------------------------------------------------------
// Scheduler — runs periodic background tasks
// ---------------------------------------------------------------------------

export function startScheduler(): void {
  console.log('⏰ Scheduler started');

  // Add per-instance jitter so multiple replicas don't all fire cron
  // callbacks at the same wall-clock second — avoids thundering-herd
  // spikes against Prisma, Resend, and Slack on schedule boundaries.
  const jitter = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
  const jitterMs = () => Math.floor(Math.random() * 60_000);

  // Weekly report: Monday at 9:00 AM
  cron.schedule('0 9 * * 1', async () => {
    await jitter(jitterMs());
    console.log('[scheduler] Running weekly reports...');
    try {
      // Cap at 10k orgs. The scheduler fans out weekly reports to every
      // tenant serially, so a monotonically growing org list would
      // eventually overrun the cron window. Above that cap we need a
      // sharded scheduler anyway.
      const orgs = await prisma.org.findMany({
        select: { id: true, name: true },
        take: 10_000,
      });
      for (const org of orgs) {
        // Send email report
        await sendWeeklyReport(org.id).catch(err =>
          console.error(`[scheduler] Email report failed for ${org.name}:`, err)
        );

        // Send manager digest email
        await sendWeeklyDigest(org.id).catch(err =>
          console.error(`[scheduler] Weekly digest failed for ${org.name}:`, err)
        );

        // Send Slack weekly digest
        await sendWeeklySlackDigest(org.id).catch(err =>
          console.error(`[scheduler] Slack digest failed for ${org.name}:`, err)
        );
      }
      console.log('[scheduler] Weekly reports complete');
    } catch (err) {
      console.error('[scheduler] Weekly report error:', err);
    }
  });

  // Monthly budget alert reset: 1st of month at midnight
  cron.schedule('0 0 1 * *', async () => {
    await jitter(jitterMs());
    console.log('[scheduler] Resetting monthly budget alerts...');
    try {
      await resetMonthlyAlerts();
      console.log('[scheduler] Monthly alerts reset');
    } catch (err) {
      console.error('[scheduler] Monthly reset error:', err);
    }
  });
}

/**
 * Send a weekly digest to Slack with session/cost summary.
 */
async function sendWeeklySlackDigest(orgId: string): Promise<void> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const sessions = await prisma.codingSession.findMany({
    where: {
      createdAt: { gte: weekAgo },
      commit: { repo: { orgId } },
    },
    select: { costUsd: true, linesAdded: true },
    take: 100_000,
    orderBy: { createdAt: 'desc' },
  });

  if (sessions.length === 0) return; // Nothing to report

  const totalCost = sessions.reduce((sum, s) => sum + s.costUsd, 0);
  const totalLines = sessions.reduce((sum, s) => sum + s.linesAdded, 0);
  const monthlySpend = await getMonthlySpend(orgId);
  const byModel = await getSpendByModel(orgId);
  const modelSummary = byModel.slice(0, 3).map(m => `${m.model}: $${m.cost.toFixed(2)}`).join(' • ');

  const message = [
    `*${sessions.length}* sessions this week — *$${totalCost.toFixed(2)}* spent`,
    `${(totalLines / 1000).toFixed(1)}k lines added`,
    `Monthly total: $${monthlySpend.toFixed(2)}`,
    modelSummary ? `Models: ${modelSummary}` : '',
  ].filter(Boolean).join('\n');

  await sendSlackNotification({
    orgId,
    type: 'WEEKLY_DIGEST',
    title: 'Weekly AI Activity Digest',
    message,
    link: '/dashboard',
  });
}
