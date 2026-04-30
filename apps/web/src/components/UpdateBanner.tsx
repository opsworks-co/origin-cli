import React, { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';

// Polls /build-info.json and compares against the build constant baked into
// the running bundle. When the server reports a newer build, surfaces a
// non-blocking corner toast with a Reload button. Avoids the
// ErrorBoundary-takeover that fires on stale-chunk failures by giving users
// a chance to refresh *before* they hit a missing chunk.
//
// Polling cadence: every 60s while the tab is visible, plus an immediate
// check on tab refocus (so a user returning from a long lunch sees the
// notice without waiting a full minute). Quietly no-ops on dev (where
// Vite's HMR is the source of truth) and on fetch failures.

const POLL_MS = 60_000;
const CURRENT_BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

export function UpdateBanner() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (CURRENT_BUILD_ID === 'dev') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      try {
        // cache: 'no-store' so a CDN doesn't keep handing us the old hash
        // forever after a new deploy.
        const res = await fetch('/build-info.json', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string };
        if (cancelled) return;
        if (data.buildId && data.buildId !== CURRENT_BUILD_ID) {
          setUpdateAvailable(true);
        }
      } catch {
        // ignore — network blips shouldn't prompt a reload
      }
    };

    const schedule = () => {
      timer = setTimeout(async () => {
        await check();
        if (!cancelled) schedule();
      }, POLL_MS);
    };

    // First check after a short delay so it doesn't compete with the page's
    // initial network activity.
    timer = setTimeout(() => {
      check().finally(() => { if (!cancelled) schedule(); });
    }, 5_000);

    // Re-check whenever the tab regains focus — long-idle tabs are exactly
    // the case where we want a fast prompt instead of a chunk-load failure.
    const onVis = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  if (!updateAvailable || dismissed) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded-full border border-indigo-500/30 bg-gray-900/95 backdrop-blur-xl shadow-2xl shadow-indigo-500/10">
        <Sparkles className="w-4 h-4 text-indigo-400 flex-shrink-0" />
        <span className="text-sm text-gray-200">A new version of Origin is available.</span>
        <button
          onClick={() => window.location.reload()}
          className="text-xs font-medium px-2.5 py-1 rounded-full bg-indigo-500 hover:bg-indigo-400 text-white transition-colors"
        >
          Reload
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="text-gray-500 hover:text-gray-300 transition-colors"
          title="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
