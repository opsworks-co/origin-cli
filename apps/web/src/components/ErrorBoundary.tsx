import React from 'react';

// ─── Stale-chunk handling ──────────────────────────────────────────────
// Every React.lazy() chunk gets a new hashed filename on each deploy. A tab
// left open across a deploy tries to fetch the old name and gets a 404.
// Error messages from that vary by browser/bundler:
//   • Vite (prod):  "Failed to fetch dynamically imported module: https://..."
//   • webpack:      "Loading chunk N failed"
//   • CSS split:    "Loading CSS chunk N failed"

const STALE_CHUNK_PATTERNS = [
  'Failed to fetch dynamically imported module',
  'Loading chunk',
  'Loading CSS chunk',
  'Importing a module script failed',
] as const;

function isStaleChunkError(err: unknown): boolean {
  const msg = (err as Error)?.message || String(err || '');
  return STALE_CHUNK_PATTERNS.some((p) => msg.includes(p));
}

// Throttle: only auto-reload if we haven't reloaded in the last 10 seconds.
// The timestamp lives in sessionStorage so it survives the reload itself but
// not a closed tab.
const RELOAD_THROTTLE_MS = 10_000;
const RELOAD_TS_KEY = 'origin:last-chunk-reload';

function canAutoReload(): boolean {
  try {
    const prev = Number(sessionStorage.getItem(RELOAD_TS_KEY) || '0');
    return Date.now() - prev > RELOAD_THROTTLE_MS;
  } catch {
    return true;
  }
}

function markAutoReload(): void {
  try { sessionStorage.setItem(RELOAD_TS_KEY, String(Date.now())); } catch { /* private mode */ }
}

// Global catcher for stale-chunk errors that don't reach a React boundary
// (unhandled rejections from lazy() route transitions, dynamic import() calls
// outside render). Installed once per page load.
let globalHandlerInstalled = false;
function installGlobalStaleChunkHandler() {
  if (globalHandlerInstalled || typeof window === 'undefined') return;
  globalHandlerInstalled = true;
  window.addEventListener('unhandledrejection', (e) => {
    if (isStaleChunkError(e.reason) && canAutoReload()) {
      markAutoReload();
      window.location.reload();
    }
  });
  window.addEventListener('error', (e) => {
    if (isStaleChunkError(e.error || e.message) && canAutoReload()) {
      markAutoReload();
      window.location.reload();
    }
  });
}
installGlobalStaleChunkHandler();

interface ErrorBoundaryProps {
  /** Optional human-readable label shown in the fallback UI. */
  label?: string;
  /** Optional render override for total control over the fallback UI. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/**
 * Catches render/runtime errors in its subtree and shows a contained fallback
 * instead of blanking the whole app. Wrap per-page so one broken page never
 * crashes the shell navigation.
 *
 * Usage:
 *   <ErrorBoundary label="Dashboard"><Dashboard /></ErrorBoundary>
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info.componentStack);

    // Stash the component stack so the fallback UI can surface it. This is
    // what lets us pin down React minified errors like #310 — the message
    // itself is generic, but the component stack tells us exactly which
    // subtree was rendering when hooks went out of order.
    this.setState({ componentStack: info.componentStack ?? null });

    // Auto-reload on stale chunk errors (happens after deploys when the
    // browser has cached HTML referencing old JS filenames that no longer
    // exist). Time-based throttle — reload at most once every 10 seconds so
    // a repeat stale chunk after a first reload doesn't loop forever, but
    // we also don't get stuck showing the error for the rest of the session
    // like the old `sessionStorage.getItem('chunk_reload')` sentinel did.
    if (isStaleChunkError(error) && canAutoReload()) {
      markAutoReload();
      window.location.reload();
    }
  }

  reset = () => this.setState({ error: null, componentStack: null });

  copyDiagnostics = () => {
    if (!this.state.error) return;
    const payload = [
      `Label: ${this.props.label ?? '(unlabeled)'}`,
      `URL: ${typeof window !== 'undefined' ? window.location.href : ''}`,
      `Message: ${this.state.error.message}`,
      this.state.error.stack ? `\nStack:\n${this.state.error.stack}` : '',
      this.state.componentStack ? `\nComponent stack:${this.state.componentStack}` : '',
    ].join('\n');
    try {
      navigator.clipboard.writeText(payload);
    } catch {
      // older browsers — fall back to a textarea hack
      const ta = document.createElement('textarea');
      ta.value = payload;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      const isStale = isStaleChunkError(this.state.error);
      return (
        <div className="min-h-[40vh] flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-xl border border-red-900/40 bg-red-950/20 p-6 text-center">
            <div className="text-red-400 text-2xl mb-2">!</div>
            <h2 className="text-lg font-semibold text-gray-100 mb-1">
              {isStale
                ? 'Origin was updated — reload to continue'
                : `Something went wrong${this.props.label ? ` in ${this.props.label}` : ''}`}
            </h2>
            <p className="text-sm text-gray-400 mb-4 break-words">
              {isStale
                ? 'Your browser has an older version cached. Reloading will pick up the latest build.'
                : this.state.error.message || 'An unexpected error occurred.'}
            </p>
            <div className="flex gap-2 justify-center flex-wrap">
              {!isStale && (
                <button
                  type="button"
                  onClick={this.reset}
                  className="px-3 py-1.5 text-xs rounded-md bg-gray-800 hover:bg-gray-700 text-gray-100 border border-gray-700"
                >
                  Try again
                </button>
              )}
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 text-xs rounded-md bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                Reload
              </button>
              {!isStale && (
                <button
                  type="button"
                  onClick={this.copyDiagnostics}
                  className="px-3 py-1.5 text-xs rounded-md bg-gray-800 hover:bg-gray-700 text-gray-100 border border-gray-700"
                  title="Copy URL + error message + component stack to clipboard"
                >
                  Copy details
                </button>
              )}
            </div>
            {!isStale && this.state.componentStack && (
              <details className="mt-3 text-left">
                <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-400">
                  Component stack
                </summary>
                <pre className="mt-2 text-[10px] text-gray-500 whitespace-pre-wrap break-words bg-black/30 rounded p-2 max-h-48 overflow-auto">
                  {this.state.componentStack.trim()}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
