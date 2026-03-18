import { prisma } from '../db.js';

// ── Types ──────────────────────────────────────────────────────────

export interface SlackNotificationPayload {
  orgId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, any>;
}

export interface SlackSettings {
  notifyViolations: boolean;
  notifyReviews: boolean;
  notifyBudget: boolean;
  notifySessionFlags: boolean;
  notifySessionComplete: boolean;
  notifyWeeklyDigest: boolean;
}

// Map notification types to settings keys
const EVENT_SETTINGS_MAP: Record<string, keyof SlackSettings> = {
  POLICY_VIOLATION: 'notifyViolations',
  AGENT_LIMIT_EXCEEDED: 'notifyViolations',
  SESSION_FLAGGED: 'notifySessionFlags',
  REVIEW_NEEDED: 'notifyReviews',
  REVIEW_COMPLETED: 'notifyReviews',
  SESSION_COMPLETED: 'notifySessionComplete',
  WEEKLY_DIGEST: 'notifyWeeklyDigest',
};

const ORIGIN_WEB_URL = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';

// ── Emoji map for notification types ───────────────────────────────

function getTypeEmoji(type: string): string {
  switch (type) {
    case 'POLICY_VIOLATION':
      return '🚨';
    case 'AGENT_LIMIT_EXCEEDED':
      return '⚠️';
    case 'SESSION_FLAGGED':
      return '🔍';
    case 'REVIEW_NEEDED':
      return '📋';
    case 'REVIEW_COMPLETED':
      return '✅';
    case 'SESSION_COMPLETED':
      return '🏁';
    case 'WEEKLY_DIGEST':
      return '📊';
    default:
      return '📌';
  }
}

function getTypeLabel(type: string): string {
  switch (type) {
    case 'POLICY_VIOLATION':
      return 'Policy Violation';
    case 'AGENT_LIMIT_EXCEEDED':
      return 'Agent Limit Exceeded';
    case 'SESSION_FLAGGED':
      return 'Session Flagged';
    case 'REVIEW_NEEDED':
      return 'Review Needed';
    case 'REVIEW_COMPLETED':
      return 'Review Completed';
    case 'SESSION_COMPLETED':
      return 'Session Completed';
    case 'WEEKLY_DIGEST':
      return 'Weekly Digest';
    default:
      return type;
  }
}

// ── Build Slack Block Kit message ──────────────────────────────────

function buildSlackBlocks(payload: SlackNotificationPayload): object[] {
  const emoji = getTypeEmoji(payload.type);
  const label = getTypeLabel(payload.type);

  const blocks: object[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${payload.title}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: payload.message,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*${label}* • Origin AI Governance`,
        },
      ],
    },
  ];

  if (payload.link) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View in Origin',
            emoji: true,
          },
          url: `${ORIGIN_WEB_URL}${payload.link}`,
          style: 'primary',
        },
      ],
    });
  }

  return blocks;
}

// ── Send Slack notification ────────────────────────────────────────

/**
 * Send a notification to the org's Slack channel via Incoming Webhook.
 * Fire-and-forget: returns true on success, false on failure. Never throws.
 */
export async function sendSlackNotification(payload: SlackNotificationPayload): Promise<boolean> {
  try {
    // Find Slack integration for this org
    const config = await prisma.integrationConfig.findFirst({
      where: { orgId: payload.orgId, provider: 'slack' },
    });

    if (!config || !config.token) {
      return false; // Slack not configured
    }

    // Parse settings and check if this event type is enabled
    let settings: SlackSettings;
    try {
      settings = JSON.parse(config.settings) as SlackSettings;
    } catch {
      settings = {
        notifyViolations: true,
        notifyReviews: true,
        notifyBudget: true,
        notifySessionFlags: true,
        notifySessionComplete: false,
        notifyWeeklyDigest: true,
      };
    }

    const settingsKey = EVENT_SETTINGS_MAP[payload.type];
    if (settingsKey && settings[settingsKey] === false) {
      return false; // Event type disabled
    }

    // Build and send the message
    const blocks = buildSlackBlocks(payload);
    const body = {
      text: `${getTypeEmoji(payload.type)} ${payload.title}: ${payload.message}`,
      blocks,
    };

    const res = await fetch(config.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[slack] Failed to send notification:', err);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[slack] Error sending notification:', err);
    return false;
  }
}

// ── Test Slack webhook ─────────────────────────────────────────────

/**
 * Send a test message to verify the webhook URL works.
 */
export async function testSlackWebhook(
  webhookUrl: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const body = {
      text: '✅ Origin AI Governance — Slack integration test successful!',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '✅ Origin Connected',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Your Slack integration with *Origin AI Governance* is working. You\'ll receive notifications for policy violations, session reviews, and budget alerts.',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `🔗 <${ORIGIN_WEB_URL}|Open Origin Dashboard>`,
            },
          ],
        },
      ],
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      return { success: false, error: `Slack API returned ${res.status}: ${err}` };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
