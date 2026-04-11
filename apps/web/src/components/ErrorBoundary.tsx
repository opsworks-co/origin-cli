import React from 'react';

interface ErrorBoundaryProps {
  /** Optional human-readable label shown in the fallback UI. */
  label?: string;
  /** Optional render override for total control over the fallback UI. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
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
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div className="min-h-[40vh] flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-xl border border-red-900/40 bg-red-950/20 p-6 text-center">
            <div className="text-red-400 text-2xl mb-2">!</div>
            <h2 className="text-lg font-semibold text-gray-100 mb-1">
              Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}
            </h2>
            <p className="text-sm text-gray-400 mb-4 break-words">
              {this.state.error.message || 'An unexpected error occurred.'}
            </p>
            <div className="flex gap-2 justify-center">
              <button
                type="button"
                onClick={this.reset}
                className="px-3 py-1.5 text-xs rounded-md bg-gray-800 hover:bg-gray-700 text-gray-100 border border-gray-700"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 text-xs rounded-md bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
