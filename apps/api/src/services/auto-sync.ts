import { prisma } from '../db.js';
import { syncCheckpoints } from './checkpoint.js';

// Auto-sync interval: 15 minutes
const SYNC_INTERVAL_MS = 15 * 60 * 1000;

// Minimum time between syncs for the same repo (avoid hammering GitHub API)
const MIN_SYNC_GAP_MS = 10 * 60 * 1000;

let running = false;

async function syncAllRepos() {
  if (running) {
    console.log('[auto-sync] Skipping — previous run still in progress');
    return;
  }

  running = true;
  const startTime = Date.now();

  try {
    // Get all repos grouped by org (need orgId for GitHub token lookup)
    const repos = await prisma.repo.findMany({
      select: { id: true, path: true, provider: true, orgId: true, syncedAt: true },
    });

    if (repos.length === 0) return;

    const now = Date.now();
    let synced = 0;
    let skipped = 0;

    for (const repo of repos) {
      // Skip repos synced recently
      if (repo.syncedAt && now - new Date(repo.syncedAt).getTime() < MIN_SYNC_GAP_MS) {
        skipped++;
        continue;
      }

      try {
        const result = await syncCheckpoints({
          id: repo.id,
          path: repo.path,
          provider: repo.provider,
          orgId: repo.orgId,
        });

        await prisma.repo.update({
          where: { id: repo.id },
          data: { syncedAt: new Date() },
        });

        if (result.synced > 0) {
          console.log(`[auto-sync] ${repo.path}: +${result.synced} commits`);
        }
        synced++;
      } catch (err) {
        console.error(`[auto-sync] Failed for ${repo.path}:`, (err as Error).message);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[auto-sync] Done: ${synced} repos synced, ${skipped} skipped (${elapsed}s)`);
  } catch (err) {
    console.error('[auto-sync] Error:', err);
  } finally {
    running = false;
  }
}

// ─── Stale Session Cleanup ─────────────────────────────────────────────────

// Backup stale session cleanup. CLI pings every 30s — 5 min no update = dead.
// Primary cleanup is in index.ts (2 min). This is a safety net.
const STALE_SESSION_MS = 5 * 60 * 1000; // 5 min without any update

async function closeStaleSession() {
  try {
    const cutoff = new Date(Date.now() - STALE_SESSION_MS);

    const staleSessions = await prisma.codingSession.findMany({
      where: {
        status: 'RUNNING',
        updatedAt: { lt: cutoff },
      },
      select: { id: true, startedAt: true },
    });

    if (staleSessions.length === 0) return;

    for (const session of staleSessions) {
      const durationMs = Date.now() - new Date(session.startedAt!).getTime();
      await prisma.codingSession.update({
        where: { id: session.id },
        data: {
          status: 'COMPLETED',
          endedAt: new Date(),
          durationMs,
        },
      });
    }

    console.log(`[stale-cleanup] Auto-closed ${staleSessions.length} stale session(s)`);
  } catch (err) {
    console.error('[stale-cleanup] Error:', err);
  }
}

export function startAutoSync() {
  // Run first sync after a short delay (let the server finish starting)
  setTimeout(() => {
    console.log(`[auto-sync] Starting — interval: ${SYNC_INTERVAL_MS / 60000}min`);
    syncAllRepos();
    closeStaleSession();
  }, 5000);

  // Then repeat on interval
  setInterval(syncAllRepos, SYNC_INTERVAL_MS);
  // Check for stale sessions more frequently (every 5 minutes)
  setInterval(closeStaleSession, 5 * 60 * 1000);
}
