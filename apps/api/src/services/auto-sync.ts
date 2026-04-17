import { prisma } from '../db.js';
import { syncSnapshots } from './snapshot.js';

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
    // Get all repos grouped by org (need orgId for GitHub token lookup).
    // Cap at 20k — the sync loop below runs serially per repo, so a
    // monotonically growing global repo list would eventually exceed
    // the tick interval. Above that cap we need to shard this job.
    const repos = await prisma.repo.findMany({
      select: { id: true, path: true, provider: true, orgId: true, syncedAt: true },
      take: 20_000,
      orderBy: { syncedAt: 'asc' },
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
        const result = await syncSnapshots({
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

// Backup stale session cleanup. Primary cleanup is in index.ts (30 min).
// This is a safety net with a longer threshold (45 min).
const STALE_SESSION_MS = 45 * 60 * 1000; // 45 min without any update

async function closeStaleSession() {
  try {
    const cutoff = new Date(Date.now() - STALE_SESSION_MS);

    // Batch cap: process 5k stale sessions per tick. The scheduler
    // re-runs every minute, so a backlog drains in 5k/min without
    // loading the full table at once.
    const staleSessions = await prisma.codingSession.findMany({
      where: {
        status: 'RUNNING',
        updatedAt: { lt: cutoff },
      },
      select: { id: true, startedAt: true },
      take: 5000,
      orderBy: { updatedAt: 'asc' },
    });

    if (staleSessions.length === 0) return;

    for (const session of staleSessions) {
      const durationMs = session.startedAt
        ? Date.now() - new Date(session.startedAt).getTime()
        : 0;
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
  // Run first sync after a short delay (let the server finish starting).
  // All timer handles are .unref()'d so they never keep the Node event loop
  // alive during graceful shutdown — without this, fly.io rolling deploys
  // hit terminationGracePeriodSeconds and have to SIGKILL the old machine.
  setTimeout(() => {
    console.log(`[auto-sync] Starting — interval: ${SYNC_INTERVAL_MS / 60000}min`);
    syncAllRepos();
    closeStaleSession();
  }, 5000).unref();

  // Then repeat on interval
  setInterval(syncAllRepos, SYNC_INTERVAL_MS).unref();
  // Check for stale sessions more frequently (every 5 minutes)
  setInterval(closeStaleSession, 5 * 60 * 1000).unref();
}
