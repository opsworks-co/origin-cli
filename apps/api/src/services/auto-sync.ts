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

export function startAutoSync() {
  // Run first sync after a short delay (let the server finish starting)
  setTimeout(() => {
    console.log(`[auto-sync] Starting — interval: ${SYNC_INTERVAL_MS / 60000}min`);
    syncAllRepos();
  }, 5000);

  // Then repeat on interval
  setInterval(syncAllRepos, SYNC_INTERVAL_MS);
}
