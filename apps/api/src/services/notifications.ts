import { prisma } from '../db.js';
import { sendSlackNotification } from './slack.js';

export async function createNotification(
  orgId: string,
  userId: string,
  type: string,
  title: string,
  message: string,
  link?: string,
  metadata?: Record<string, any>
) {
  return prisma.notification.create({
    data: {
      orgId,
      userId,
      type,
      title,
      message,
      link: link || null,
      metadata: metadata ? JSON.stringify(metadata) : '{}',
    },
  });
}

export async function notifyOrgMembers(
  orgId: string,
  type: string,
  title: string,
  message: string,
  link?: string,
  metadata?: Record<string, any>
) {
  // Cap fanout at 10k recipients. One triggering event on a large org
  // already causes a massive createMany write; above this we'd risk
  // throttling the Notification table and the Slack path below.
  const users = await prisma.user.findMany({
    where: { memberships: { some: { orgId, role: { in: ['MEMBER', 'ADMIN', 'OWNER'] } } } },
    select: { id: true },
    take: 10_000,
  });

  const notifications = users.map(u => ({
    orgId,
    userId: u.id,
    type,
    title,
    message,
    link: link || null,
    metadata: metadata ? JSON.stringify(metadata) : '{}',
  }));

  if (notifications.length > 0) {
    await prisma.notification.createMany({ data: notifications });
  }
}

export async function notifyOrgAdmins(
  orgId: string,
  type: string,
  title: string,
  message: string,
  link?: string,
  metadata?: Record<string, any>
) {
  const users = await prisma.user.findMany({
    where: { memberships: { some: { orgId, role: { in: ['ADMIN', 'OWNER'] } } } },
    select: { id: true },
    take: 2000,
  });

  const notifications = users.map(u => ({
    orgId,
    userId: u.id,
    type,
    title,
    message,
    link: link || null,
    metadata: metadata ? JSON.stringify(metadata) : '{}',
  }));

  if (notifications.length > 0) {
    await prisma.notification.createMany({ data: notifications });
  }

  // Also send to Slack (fire-and-forget — never blocks in-app flow).
  // Log failures so ops can see them in Fly logs; swallowing silently hid
  // a broken webhook URL for days in prod before.
  sendSlackNotification({ orgId, type, title, message, link }).catch((err) => {
    console.warn(
      `[notifications] Slack send failed for org ${orgId} type ${type}:`,
      (err as Error).message,
    );
  });
}
