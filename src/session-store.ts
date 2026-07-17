// Where session files live in the repo, and how to read them back.
//
// Two backends:
//
//   'branch' (default) — everything on the shared `origin-sessions` orphan
//     branch, one commit per write, `sessions/<id>/{metadata.json,prompts.md,
//     changes.json}`. Portable and visible on GitHub, but every writer
//     read-modify-writes the same ref: writes are serialized through a CAS
//     retry loop (see local-entrypoint.ts), and each write re-reads and
//     re-writes the whole accumulated tree, so cost grows with history.
//
//   'refs' (opt-in) — one ref per session, `refs/origin/sessions/<id>`, whose
//     tree holds just that session's three files. Writers never touch a shared
//     ref, so there is no contention and no retry loop, and write cost is flat
//     regardless of how many sessions exist. Measured on this repo's harness:
//
//       existing sessions:      100      500     2000
//       shared branch:        191ms    224ms    321ms
//       per-session refs:     136ms    142ms    138ms
//
// Reads always check BOTH backends (refs first, then branch) so switching is
// non-destructive and existing branch history stays readable.
//
// The backend only governs LOCAL storage. `origin-sessions` remains the
// interop/portability format: the platform importer and `--snapshot-repo`
// push still speak the branch, so the refs backend is local-first for now.
import { git, gitDetailed, gitOrNull } from './utils/exec.js';
import { loadConfig } from './config.js';

export type SessionBackend = 'branch' | 'refs';

export const SESSION_BRANCH = 'origin-sessions';
/** Namespace for per-session refs. Mirrors the existing `refs/origin/shadow/`
 *  convention already used for shadow snapshots (git-capture.ts). */
export const SESSION_REF_PREFIX = 'refs/origin/sessions';

/** The three files that make up a stored session. */
export type SessionFile = 'metadata.json' | 'prompts.md' | 'changes.json';

/** Session ids come from agents, so they're sanitized before they ever reach a
 *  ref or path. Shared by both backends so the two agree on the key. */
export function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function sessionRef(sessionId: string): string {
  return `${SESSION_REF_PREFIX}/${safeSessionId(sessionId)}`;
}

/**
 * Should the `origin-sessions` branch be BUILT locally?
 *
 * Session context has to survive from user to user *through git*: someone may
 * run the CLI standalone and never touch the platform, and an agent that clones
 * the repo with no Origin tooling at all should still see what happened. So the
 * branch is built by default — including in connected mode, where it
 * historically wasn't pushed at all (the reasoning then was that the API already
 * had the data, which is no help to anyone who isn't on the platform).
 *
 * Deliberately separate from shouldPushSessionBranch: `pushStrategy: 'prompt'`
 * means the user pushes the branch themselves, which requires it to exist. Gating
 * the build on the push decision would leave them with nothing to push.
 *
 * Only 'false' (never push anywhere) skips the build — there, per-session refs
 * already serve every local read, so the branch would be pure cost.
 */
export function shouldBuildSessionBranch(config: ReturnType<typeof loadConfig>): boolean {
  return (config?.pushStrategy || 'auto') !== 'false';
}

/** Should the built branch be sent to the remote? */
export function shouldPushSessionBranch(config: ReturnType<typeof loadConfig>): boolean {
  const strategy = config?.pushStrategy || 'auto';
  if (strategy === 'false') return false;   // never push
  if (strategy === 'prompt') return false;  // user pushes manually / via pre-push hook
  return true;
}

/**
 * Which backend the HOT PATH writes. Defaults to 'refs': agents write their own
 * ref per prompt, so there's no shared ref to contend on and write cost stays
 * flat as history grows.
 *
 * This is deliberately independent of publishing. The branch is still produced —
 * publishSessionToBranch folds a session's ref onto it at publish time — so
 * portability doesn't force every prompt to pay the branch's whole-tree rewrite.
 *
 * `origin config set session-backend branch` writes the branch directly on the
 * hot path instead (CAS-protected). Reads check BOTH backends regardless, so
 * switching either way never hides existing history.
 */
export function getSessionBackend(): SessionBackend {
  return loadConfig()?.sessionBackend === 'branch' ? 'branch' : 'refs';
}

function execOpts(repoPath: string) {
  return { cwd: repoPath, timeoutMs: 10_000, maxBuffer: 5 * 1024 * 1024 };
}

/**
 * Every session id present in the repo, from BOTH backends, deduped.
 * Order is not meaningful — callers that care sort by metadata.
 */
export function listSessionIds(repoPath: string): string[] {
  const ids = new Set<string>();

  // refs backend: one ref per session
  const refsOut = gitOrNull(
    ['for-each-ref', '--format=%(refname)', `${SESSION_REF_PREFIX}/`],
    execOpts(repoPath),
  );
  if (refsOut) {
    for (const line of refsOut.split('\n')) {
      const id = line.trim().slice(`${SESSION_REF_PREFIX}/`.length);
      if (id) ids.add(id);
    }
  }

  // branch backend: sessions/<id>/ directories on the orphan branch
  const treeOut = gitOrNull(
    ['ls-tree', '--name-only', `refs/heads/${SESSION_BRANCH}`, 'sessions/'],
    execOpts(repoPath),
  );
  if (treeOut) {
    for (const line of treeOut.split('\n')) {
      // entries look like `sessions/<id>/`
      const id = line.trim().replace(/^sessions\//, '').replace(/\/$/, '');
      if (id) ids.add(id);
    }
  }

  return [...ids];
}

/**
 * Read one file of one session, or null if absent.
 * Checks the refs backend first — if a session exists in both (e.g. written on
 * the branch, then re-written after switching), the ref is the newer copy.
 */
export function readSessionFile(
  repoPath: string,
  sessionId: string,
  file: SessionFile,
): string | null {
  const id = safeSessionId(sessionId);
  const opts = execOpts(repoPath);

  const fromRef = gitDetailed(['show', `${sessionRef(id)}:${file}`], opts);
  if (fromRef.status === 0) return fromRef.stdout;

  const fromBranch = gitDetailed(
    ['show', `refs/heads/${SESSION_BRANCH}:sessions/${id}/${file}`],
    opts,
  );
  if (fromBranch.status === 0) return fromBranch.stdout;

  return null;
}

/** True when the repo has any session data at all, in either backend. */
export function hasAnySessions(repoPath: string): boolean {
  return listSessionIds(repoPath).length > 0;
}

/**
 * Write one session's files to its own ref. No shared tip, so no CAS and no
 * retry: concurrent agents write disjoint refs and cannot lose each other's
 * data. The tree holds the three files at its root (the session id is already
 * in the ref name, so re-nesting under `sessions/<id>/` would be redundant).
 *
 * `files` is [filename, content]. Never throws.
 */
export function writeSessionRef(
  repoPath: string,
  sessionId: string,
  files: Array<[SessionFile, string]>,
  commitMessage: string,
  commitTree: (args: string[], opts: ReturnType<typeof execOpts>) => string | null,
  tmpIndexPath: string,
): boolean {
  const opts = execOpts(repoPath);
  const indexOpts = { ...opts, env: { ...process.env, GIT_INDEX_FILE: tmpIndexPath } };

  try {
    // Start from an empty index — this session's ref is self-contained, and a
    // stale index from a previous write would leak other sessions' entries in.
    try {
      git(['read-tree', '--empty'], indexOpts);
    } catch { /* best effort */ }

    for (const [name, content] of files) {
      const blobRes = gitDetailed(['hash-object', '-w', '--stdin'], { ...opts, input: content });
      if (blobRes.status !== 0) continue;
      const blobHash = blobRes.stdout.trim();
      if (!/^[a-fA-F0-9]+$/.test(blobHash)) continue;
      git(['update-index', '--add', '--cacheinfo', `100644,${blobHash},${name}`], indexOpts);
    }

    const treeHash = git(['write-tree'], indexOpts).trim();
    if (!/^[a-fA-F0-9]+$/.test(treeHash)) return false;

    // Parent to the session's own previous ref (if any) so a session's writes
    // form a history: `running` → `ended` stays inspectable, and the ref is
    // fast-forward-safe when pushed.
    const prev = gitOrNull(['rev-parse', '--verify', '-q', sessionRef(sessionId)], opts);
    const commitArgs = [treeHash];
    if (prev && /^[a-fA-F0-9]+$/.test(prev)) commitArgs.push('-p', prev);
    commitArgs.push('-m', commitMessage);

    const commitHash = commitTree(commitArgs, opts);
    if (!commitHash || !/^[a-fA-F0-9]+$/.test(commitHash)) return false;

    git(['update-ref', sessionRef(sessionId), commitHash], opts);
    return true;
  } catch {
    return false;
  }
}
