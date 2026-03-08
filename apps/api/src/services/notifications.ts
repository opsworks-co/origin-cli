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
  const users = await prisma.user.findMany({
    where: { orgId, role: { in: ['MEMBER', 'ADMIN', 'OWNER'] } },
    select: { id: true },
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
    where: { orgId, role: { in: ['ADMIN', 'OWNER'] } },
    select: { id: true },
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

  // Also send to Slack (fire-and-forget — never blocks in-app flow)
  sendSlackNotification({ orgId, type, title, message, link }).catch(() => {});
}
