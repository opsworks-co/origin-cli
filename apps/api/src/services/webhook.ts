import crypto from 'crypto';
import { prisma } from '../db.js';

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function verifyGitHubSignature(payload: string | Buffer, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(typeof payload === 'string' ? payload : payload);
  const expected = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

interface GitHubCommit {
  id: string;
  message: string;
  author: { name: string; email: string };
  timestamp: string;
  added: string[];
  modified: string[];
  removed: string[];
}

interface GitHubPushPayload {
  ref: string;
  commits: GitHubCommit[];
  repository: { full_name: string };
}

export async function processGitHubPush(repoId: string, payload: GitHubPushPayload) {
  const results = { created: 0, skipped: 0 };

  for (const commit of payload.commits) {
    // Check for duplicate by SHA
    const existing = await prisma.commit.findFirst({
      where: { repoId, sha: commit.id },
    });

    if (existing) {
      results.skipped++;
      continue;
    }

    await prisma.commit.create({
      data: {
        repoId,
        sha: commit.id,
        message: commit.message,
        author: commit.author.name,
        committedAt: new Date(commit.timestamp),
      },
    });
    results.created++;
  }

  // Update repo syncedAt
  await prisma.repo.update({
    where: { id: repoId },
    data: { syncedAt: new Date() },
  });

  return results;
}
