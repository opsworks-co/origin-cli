// Optional commit signing for Origin's own commits.
//
// When `signSnapshots` is true in user config, we append `-S` to every
// `git commit-tree` Origin runs (auto-snapshots, origin-sessions branch
// commits, shadow-snapshot commits). The flag tells git to GPG/SSH-sign
// the commit using whatever the user already has configured:
//
//   - gpg.program + user.signingkey   → GPG signing
//   - gpg.format=ssh + user.signingkey → SSH signing (git ≥ 2.34)
//
// We deliberately don't write any git config ourselves — if signing isn't
// already set up, `commit-tree -S` fails with a clear error and our caller
// falls back to an unsigned commit so session bookkeeping still works.

import { loadConfig } from './config.js';
import { gitDetailed, type RunOptions } from './utils/exec.js';

// Memoize per-process. Auto-snapshots fire on every agent edit, so reading
// ~/.origin/config.json on every commit-tree call adds up. Exposed reset for
// tests; production code never needs to reset.
let cachedSign: boolean | null = null;

function resolveSign(): boolean {
  if (cachedSign !== null) return cachedSign;
  try {
    cachedSign = !!loadConfig()?.signSnapshots;
  } catch {
    cachedSign = false;
  }
  return cachedSign;
}

/** Test-only: reset the memoized signing flag. */
export function resetSigningCacheForTests(): void {
  cachedSign = null;
}

/**
 * Returns `['-S']` when commit signing is enabled in Origin config, else `[]`.
 * Append to a `commit-tree` argv array; safe to call unconditionally.
 */
export function getCommitSigningArgs(): string[] {
  return resolveSign() ? ['-S'] : [];
}

/**
 * True iff signSnapshots is enabled. Cheap predicate for callers that need to
 * branch on signing (e.g. retry-without-signing on failure).
 */
export function isCommitSigningEnabled(): boolean {
  return resolveSign();
}

/**
 * Run `git commit-tree` with optional signing, falling back to unsigned if
 * signing fails (no key, gpg-agent unreachable, etc.). Centralized so all
 * three call sites — local-entrypoint, auto-snapshot, permanent-snapshot —
 * use the same fallback pattern. Returns the commit SHA on success, or
 * null when even the unsigned attempt fails.
 *
 * `baseArgs` is the argv after the literal 'commit-tree' (tree, -p parents,
 * -m message, etc.) — we own the signing flag and won't double-add it.
 */
export function commitTreeMaybeSigned(baseArgs: string[], opts: RunOptions): string | null {
  const signArgs = getCommitSigningArgs();
  if (signArgs.length) {
    const signed = gitDetailed(['commit-tree', ...baseArgs, ...signArgs], opts);
    if (signed.status === 0) {
      const sha = signed.stdout.trim();
      if (sha) return sha;
    }
    // Signed attempt failed — fall through to unsigned so session
    // bookkeeping still completes. Origin's commit-tree calls are non-
    // blocking for the agent; we'd rather have an unsigned audit trail
    // than no audit trail.
  }
  const unsigned = gitDetailed(['commit-tree', ...baseArgs], opts);
  if (unsigned.status !== 0) return null;
  const sha = unsigned.stdout.trim();
  return sha || null;
}
