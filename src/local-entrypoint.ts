import fs from 'fs';
import { git, gitDetailed, gitOrNull } from './utils/exec.js';
import { loadConfig } from './config.js';
import { commitTreeMaybeSigned } from './signing.js';
import {
  getSessionBackend,
  readSessionFile,
  safeSessionId,
  shouldBuildSessionBranch,
  shouldPushSessionBranch,
  writeSessionRef,
  type SessionFile,
} from './session-store.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Session-level metrics → sessions/{sessionId}/metadata.json */
export interface SessionMetadata {
  version: 1;
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'running' | 'ended';
  tokens: { total: number; input: number; output: number };
  cost: { usd: number };
  toolCalls: number;
  lines: { added: number; removed: number };
  filesChanged: string[];
  git: {
    branch: string;
    headBefore: string;
    headAfter: string;
    commitShas: string[];
  };
  summary: string;
  originUrl: string;
}

/** A single prompt for building prompts.md */
export interface PromptEntry {
  index: number;          // 1-based
  text: string;
  filesChanged: string[];
}

/** Per-prompt change record → sessions/{sessionId}/changes.json
 *
 * v2 adds editsJson + uncommittedDiff + commitSha + treeSha so a different
 * Origin org importing the repo can drive AI Blame from the authoritative
 * apply_patch / Edit payload (LCS replay) instead of falling back to weaker
 * block-matching against pc.diff alone. v1 consumers (older importers) ignore
 * the new fields silently — schema is purely additive. */
export interface PromptChange {
  promptIndex: number;    // 1-based, matches ## Prompt N in prompts.md
  promptText: string;     // first 200 chars
  filesChanged: string[];
  diff: string;           // unified diff (committed + uncommitted, scoped)
  /** JSON-encoded PromptCapture (see packages/cli/src/prompt-capture/types.ts).
   *  Capped at EDITS_JSON_MAX_BYTES; truncated entries get a marker. Omit
   *  when missing rather than ship an empty string so v1 readers still parse. */
  editsJson?: string | null;
  /** Working-tree-side diff at session-end. Lets blame ByFile prefer the
   *  freshest snapshot when it exists. */
  uncommittedDiff?: string | null;
  /** HEAD at the prompt's stop. Travels so Org B's `committed` pill / commit
   *  attribution checks work without re-deriving from local git state. */
  commitSha?: string | null;
  /** Working-tree SHA at the prompt's stop. Powers soft restore on Org B. */
  treeSha?: string | null;
  // Following are populated by hooks.ts but not currently serialized to
  // changes.json (they're session-level signals, not per-prompt portability
  // data). Kept as optional so the interface still matches existing callers
  // without forcing them through a separate type.
  linesAdded?: number;
  linesRemoved?: number;
  aiPercentage?: number;
  checkpointType?: string;
}

/** Bump to 2 when shipping editsJson / commit refs; importers gate richer
 *  hydration on `version >= 2` so they don't try to read missing fields off
 *  legacy payloads. */
export interface SessionChanges {
  version: 2;
  sessionId: string;
  changes: PromptChange[];
}

/** Max bytes for editsJson per prompt before truncation. 16 KB covers ~99%
 *  of real prompts; bigger refactors get a TRUNCATED marker appended so the
 *  consumer can detect and degrade gracefully. Sized to keep the orphan
 *  branch push-friendly: 50 prompts × 16KB = 800KB worst case per session. */
const EDITS_JSON_MAX_BYTES = 16 * 1024;
const TRUNCATED_MARKER = '\n/* [origin: editsJson truncated for branch portability] */';

function capEditsJson(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (Buffer.byteLength(raw, 'utf-8') <= EDITS_JSON_MAX_BYTES) return raw;
  // Slice on character boundary; the marker isn't valid JSON itself but
  // consumers parse the JSON prefix first (failure = treat as missing).
  const slice = raw.slice(0, EDITS_JSON_MAX_BYTES - TRUNCATED_MARKER.length);
  return slice + TRUNCATED_MARKER;
}

function dropEmpty(s: string | null | undefined): string | undefined {
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}

/** Unified input — callers assemble this, we derive all 3 files from it */
export interface SessionWriteData {
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'running' | 'ended';
  costUsd: number;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolCalls: number;
  linesAdded: number;
  linesRemoved: number;
  prompts: PromptEntry[];
  filesChanged: string[];
  git: {
    branch: string;
    headBefore: string;
    headAfter: string;
    commitShas: string[];
  };
  summary: string;
  originUrl: string;
  changes: PromptChange[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const BRANCH = 'origin-sessions';

// Written to the root of the origin-sessions branch on every publish (same
// bytes each time, so git dedupes it and the tree doesn't churn).
//
// This branch is the one artifact that reaches a plain `git clone` — clone
// fetches refs/heads/* and refs/tags/* and nothing else, so git notes and
// refs/origin/sessions/* never arrive on their own. Someone landing here has
// no Origin tooling by definition, so the branch has to explain itself: what it
// is, how to read it with nothing but git, and the one command that also brings
// per-commit attribution down. GitHub renders this when you switch branches.
const BRANCH_README = `# Origin session history

This branch is written automatically by [Origin](https://getorigin.io). It is
**not part of your codebase** — nothing here is built, imported, or deployed. It
records which AI agent wrote the code on the other branches, and the prompt
behind each change.

You don't need Origin installed to read any of it. Plain \`git\` is enough.

## Layout

    sessions/<session-id>/metadata.json   model, cost, tokens, duration, commits
    sessions/<session-id>/prompts.md      the prompts, in order
    sessions/<session-id>/changes.json    per-prompt diffs and files touched

## Reading it

List the sessions:

    git ls-tree --name-only origin/origin-sessions:sessions/

Read the prompts behind one:

    git show origin/origin-sessions:sessions/<session-id>/prompts.md

## Per-commit attribution (one extra step)

Origin also writes a git note per commit, so \`git log\` can show you which agent
wrote it and why. Notes live in \`refs/notes/origin\`, and **\`git clone\` does not
fetch them** — that's a git default, not an Origin choice. Bring them down once:

    git fetch origin refs/notes/origin:refs/notes/origin

Then, with plain git:

    git log --show-notes=origin

To keep them arriving on every ordinary \`git pull\`, add the refspec:

    git config --add remote.origin.fetch '+refs/notes/origin:refs/notes/origin-remote'

(That stages them into \`refs/notes/origin-remote\`. Origin merges the staging ref
into \`refs/notes/origin\` so your own local notes are never overwritten — mapping
the remote straight onto \`refs/notes/origin\` with a forced refspec would silently
destroy any note you hadn't pushed yet.)
`;

// Attempts for the CAS'd branch write. Only ONE writer can win each round —
// the rest lose the CAS and rebuild — so N contending agents need up to N
// rounds for the last one to land. Measured: 8 parallel agents at a cap of 5
// silently dropped 3 sessions. Keep this comfortably above realistic fleet
// size; the cap only exists so a pathological loop can't spin forever.
const MAX_WRITE_ATTEMPTS = 20;

// Without backoff the losers re-read the tip and collide again in lock-step.
// Jittered sleep spreads them out so the herd drains in far fewer rounds than
// the worst case. Sync (Atomics.wait) because the whole write path is sync.
const WRITE_RETRY_BASE_MS = 15;
const WRITE_RETRY_JITTER_MS = 60;

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable — skip the backoff rather than fail.
  }
}

// ─── File Builders ─────────────────────────────────────────────────────────

function buildMetadataJson(data: SessionWriteData): string {
  const metadata: SessionMetadata = {
    version: 1,
    sessionId: data.sessionId,
    model: data.model,
    startedAt: data.startedAt,
    endedAt: data.endedAt,
    durationMs: data.durationMs,
    status: data.status,
    tokens: {
      total: data.tokensUsed,
      input: data.inputTokens,
      output: data.outputTokens,
    },
    cost: { usd: data.costUsd },
    toolCalls: data.toolCalls,
    lines: { added: data.linesAdded, removed: data.linesRemoved },
    filesChanged: data.filesChanged,
    git: data.git,
    summary: data.summary,
    originUrl: data.originUrl,
  };
  return JSON.stringify(metadata, null, 2) + '\n';
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function buildPromptsMd(data: SessionWriteData): string {
  const lines: string[] = [];
  lines.push(`# Session ${data.sessionId.slice(0, 8)}`);
  lines.push('');
  lines.push(`**Model:** ${data.model}  `);
  lines.push(`**Started:** ${data.startedAt}  `);
  lines.push(`**Duration:** ${formatDuration(data.durationMs)}  `);
  lines.push(`**Cost:** $${data.costUsd.toFixed(4)}  `);
  lines.push(`**Tokens:** ${data.tokensUsed.toLocaleString()}  `);
  lines.push(`**Status:** ${data.status}  `);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (data.prompts.length === 0) {
    lines.push('_No prompts recorded._');
    lines.push('');
  }

  for (const prompt of data.prompts) {
    lines.push(`## Prompt ${prompt.index}`);
    lines.push('');
    lines.push(prompt.text);
    lines.push('');
    if (prompt.filesChanged.length > 0) {
      lines.push('**Files changed:**');
      for (const f of prompt.filesChanged) {
        lines.push(`- \`${f}\``);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildChangesJson(data: SessionWriteData): string {
  // Apply caps + drop empties at serialization time so callers don't have
  // to know about EDITS_JSON_MAX_BYTES. Empty optional fields stay
  // `undefined` (not "" or null) so JSON.stringify omits them entirely —
  // keeps the payload compact AND keeps v1 importers from tripping on
  // unexpected empties.
  const capped: PromptChange[] = data.changes.map((c) => {
    const out: PromptChange = {
      promptIndex: c.promptIndex,
      promptText: c.promptText,
      filesChanged: c.filesChanged,
      diff: c.diff,
    };
    const editsJson = capEditsJson(c.editsJson);
    if (editsJson) out.editsJson = editsJson;
    const uncommitted = dropEmpty(c.uncommittedDiff);
    if (uncommitted) out.uncommittedDiff = uncommitted;
    const commitSha = dropEmpty(c.commitSha);
    if (commitSha) out.commitSha = commitSha;
    const treeSha = dropEmpty(c.treeSha);
    if (treeSha) out.treeSha = treeSha;
    return out;
  });
  const changes: SessionChanges = {
    version: 2,
    sessionId: data.sessionId,
    changes: capped,
  };
  return JSON.stringify(changes, null, 2) + '\n';
}

// ─── Git Plumbing ──────────────────────────────────────────────────────────

/** The three files that make up a stored session, ready to write. */
type SessionFileSet = Array<[SessionFile, string]>;

function buildSessionFileSet(data: SessionWriteData): SessionFileSet {
  return [
    ['metadata.json', buildMetadataJson(data)],
    ['prompts.md', buildPromptsMd(data)],
    ['changes.json', buildChangesJson(data)],
  ];
}

function sessionCommitMessage(safeId: string, model: string, firstPromptText: string): string {
  const firstPrompt = (firstPromptText || 'AI coding session').slice(0, 80);
  return `session ${safeId.slice(0, 8)}: ${model} — ${firstPrompt}`;
}

/**
 * "Don't downgrade": is `incoming` worse than what's already stored?
 *
 * Guards against the *same* session being written twice out of order — a stale
 * post-commit hook with 0 prompts landing after the Stop hook's full capture.
 * Unrelated to cross-agent contention; applies to every backend.
 */
function isDowngrade(
  incoming: { status: 'running' | 'ended'; costUsd: number; promptCount: number },
  existing: SessionMetadata,
): boolean {
  // Always let 'ended' overwrite 'running' — session-end has the final data.
  if (incoming.status === 'running' && existing.status === 'ended') return true;
  // For same status, skip if the existing data is richer.
  if (incoming.status === existing.status && existing.cost.usd > incoming.costUsd && incoming.promptCount === 0) {
    return true;
  }
  return false;
}

function resolveGitDir(repoPath: string, execOpts: { cwd: string }): string {
  // For a worktree-session repoPath, `.git` is a FILE and the naive
  // `${repoPath}/.git/…` path makes every index op exit 128 ("Not a
  // directory"), silently dropping the whole write.
  const out = (gitOrNull(['rev-parse', '--git-common-dir'], execOpts) || '').trim();
  if (!out) return `${repoPath}/.git`;
  return out.startsWith('/') ? out : `${repoPath}/${out}`;
}

/**
 * Write session files to storage.
 *
 * Hot path. Under the 'refs' backend this writes ONLY the session's own ref —
 * fast, and no shared ref to contend on. The shared `origin-sessions` branch is
 * built later, at publish time (see publishSessionToBranch), so that agents
 * don't pay the branch's whole-tree rewrite on every prompt.
 *
 * Under the 'branch' backend it folds straight into the branch, CAS'd.
 * Never throws.
 */
export function writeSessionFiles(repoPath: string, data: SessionWriteData): void {
  try {
    const safeId = safeSessionId(data.sessionId);
    const files = buildSessionFileSet(data);
    const msg = sessionCommitMessage(safeId, data.model, data.prompts[0]?.text || '');
    const incoming = {
      status: data.status,
      costUsd: data.costUsd,
      promptCount: data.prompts.length,
    };

    if (getSessionBackend() === 'refs') {
      writeSessionToOwnRef(repoPath, data.sessionId, files, msg, incoming);
      return;
    }
    foldSessionIntoBranch(repoPath, safeId, files, msg, incoming);
  } catch {
    // Never fail — best-effort local write
  }
}

/** 'refs' backend write: this session's three files onto its own ref. */
function writeSessionToOwnRef(
  repoPath: string,
  sessionId: string,
  files: SessionFileSet,
  commitMsg: string,
  incoming: { status: 'running' | 'ended'; costUsd: number; promptCount: number },
): void {
  const execOpts = { cwd: repoPath, timeoutMs: 10_000, maxBuffer: 5 * 1024 * 1024 };

  const existingRaw = readSessionFile(repoPath, sessionId, 'metadata.json');
  if (existingRaw) {
    try {
      if (isDowngrade(incoming, JSON.parse(existingRaw) as SessionMetadata)) return;
    } catch { /* unparseable — treat as absent and overwrite */ }
  }

  const tmpIndex = `${resolveGitDir(repoPath, execOpts)}/origin-tmp-index-${process.pid}`;
  try {
    writeSessionRef(repoPath, sessionId, files, commitMsg, commitTreeMaybeSigned, tmpIndex);
  } finally {
    try {
      fs.unlinkSync(tmpIndex);
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Fold one session's files into the shared `origin-sessions` branch under
 * sessions/<id>/, retried under a compare-and-swap on the branch ref.
 *
 * The CAS is what makes this safe: a PID-scoped temp index keeps concurrent
 * writers off each other's index FILE, but the tree is seeded from the branch
 * tip, so two agents that both seed from tip T and then update-ref
 * unconditionally would leave the loser's session orphaned. Measured at 1-of-16
 * sessions surviving with 16 parallel agents before the CAS.
 *
 * Shared by the branch backend's hot-path write and by publishSessionToBranch.
 */
function foldSessionIntoBranch(
  repoPath: string,
  safeId: string,
  files: SessionFileSet,
  commitMsg: string,
  incoming: { status: 'running' | 'ended'; costUsd: number; promptCount: number } | null,
): boolean {
  // Re-seed and rebuild on each attempt: a CAS failure means the tip moved, so
  // the tree we just built is stale and must be rebuilt on the new tip.
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const outcome = foldSessionIntoBranchOnce(repoPath, safeId, files, commitMsg, incoming);
    if (outcome !== 'retry') return outcome === 'done';
    // Lost the CAS — back off with jitter before rebuilding so contending
    // agents don't retry in lock-step and collide again.
    sleepSync(WRITE_RETRY_BASE_MS + Math.floor(Math.random() * WRITE_RETRY_JITTER_MS));
  }
  // Exhausted retries under sustained contention — drop the write rather than
  // risk clobbering a concurrent agent's session.
  return false;
}

/**
 * One attempt at the branch read-modify-write. Returns:
 *   'done'  — committed, or intentionally skipped (don't-downgrade guard)
 *   'retry' — the branch tip moved under us; caller should rebuild
 */
function foldSessionIntoBranchOnce(
  repoPath: string,
  safeId: string,
  files: SessionFileSet,
  commitMsg: string,
  incoming: { status: 'running' | 'ended'; costUsd: number; promptCount: number } | null,
): 'done' | 'retry' {
  const execOpts = {
    cwd: repoPath,
    timeoutMs: 10_000,
    maxBuffer: 5 * 1024 * 1024,
  };

  const dir = `sessions/${safeId}`;

  // Read the tip ONCE per attempt. Everything below (the downgrade guard, the
  // seeded tree, the commit parent) is relative to this exact value, and the
  // CAS at the end refuses the write if the ref has moved off it since.
  const parentHash = gitOrNull(['rev-parse', `refs/heads/${BRANCH}`], execOpts);
  const validParent = parentHash && /^[a-fA-F0-9]+$/.test(parentHash) ? parentHash : null;

  // `incoming: null` means the caller is publishing from the session's own ref,
  // which is authoritative and at least as fresh as the branch — nothing to
  // guard against there.
  if (validParent && incoming) {
    try {
      const existingMeta = git(['show', `${validParent}:${dir}/metadata.json`], execOpts).trim();
      if (isDowngrade(incoming, JSON.parse(existingMeta) as SessionMetadata)) return 'done';
    } catch {
      // No existing data for this session — proceed with write
    }
  }

  const tmpIndex = `${resolveGitDir(repoPath, execOpts)}/origin-tmp-index-${process.pid}`;
  const indexOpts = { ...execOpts, env: { ...process.env, GIT_INDEX_FILE: tmpIndex } };

  try {
    // 1. Seed temp index from the tip's tree. Always reset first — on a retry
    //    the index still holds the previous attempt's entries, and if the new
    //    tip has no tree we'd otherwise commit that stale set.
    try {
      git(['read-tree', '--empty'], indexOpts);
    } catch { /* best effort */ }
    if (validParent) {
      try {
        git(['read-tree', `${validParent}^{tree}`], indexOpts);
      } catch { /* best effort */ }
    }

    // 2. Write each file as a blob and add to temp index. The README goes at
    //    the branch root — whoever clones this has no Origin tooling, so the
    //    branch has to say what it is and how to read it.
    const entries: Array<[string, string]> = [
      ...files.map(([name, content]) => [`${dir}/${name}`, content] as [string, string]),
      ['README.md', BRANCH_README],
    ];
    for (const [entryPath, content] of entries) {
      const blobRes = gitDetailed(['hash-object', '-w', '--stdin'], { ...execOpts, input: content });
      if (blobRes.status !== 0) continue;
      const blobHash = blobRes.stdout.trim();
      if (!/^[a-fA-F0-9]+$/.test(blobHash)) continue;

      git(
        ['update-index', '--add', '--cacheinfo', `100644,${blobHash},${entryPath}`],
        indexOpts,
      );
    }

    // 3. Write the tree
    const treeHash = git(['write-tree'], indexOpts).trim();
    if (!/^[a-fA-F0-9]+$/.test(treeHash)) return 'done';

    // 4. Create the commit
    const commitArgs = [treeHash];
    if (validParent) {
      commitArgs.push('-p', validParent);
    }
    commitArgs.push('-m', commitMsg);
    // Signing is opt-in (`origin config set sign-snapshots true`) and falls
    // back to unsigned if signing fails so session bookkeeping never blocks.
    const commitHash = commitTreeMaybeSigned(commitArgs, execOpts);
    if (!commitHash || !/^[a-fA-F0-9]+$/.test(commitHash)) return 'done';

    // 5. Compare-and-swap the branch ref. Passing the expected old value makes
    //    git reject the update if another agent moved the tip since we read it;
    //    '' asserts the ref must not exist yet (first write wins the create).
    //    Without this, the loser's session files are silently orphaned.
    const casRes = gitDetailed(
      ['update-ref', `refs/heads/${BRANCH}`, commitHash, validParent ?? ''],
      execOpts,
    );
    if (casRes.status !== 0) return 'retry'; // tip moved — rebuild on the new tip

    return 'done';
  } finally {
    // 6. Clean up temp index
    try {
      fs.unlinkSync(tmpIndex);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Publish a session onto the shared `origin-sessions` branch.
 *
 * This is what makes session context portable. A plain `git clone` only fetches
 * refs/heads/* and refs/tags/* — NOT refs/notes/* and NOT refs/origin/sessions/*.
 * So neither git notes nor the per-session refs reach a fresh clone on their
 * own; the branch is the only vehicle that arrives with zero extra tooling, and
 * it's what a user running the CLI standalone (or an agent with no Origin at
 * all) reads. Verified by cloning a repo with all three pushed: only the branch
 * was readable.
 *
 * Under the 'branch' backend the hot-path write already landed on the branch,
 * so this is a no-op. Under 'refs' it copies the session's ref content onto the
 * branch — the whole-tree rewrite happens here, at publish time, instead of on
 * every prompt.
 *
 * Returns true if the branch now holds this session. Never throws.
 */
export function publishSessionToBranch(repoPath: string, sessionId: string): boolean {
  try {
    if (getSessionBackend() !== 'refs') return true; // already on the branch

    const safeId = safeSessionId(sessionId);
    const files: SessionFileSet = [];
    for (const name of ['metadata.json', 'prompts.md', 'changes.json'] as const) {
      const content = readSessionFile(repoPath, sessionId, name);
      if (content !== null) files.push([name, content]);
    }
    if (files.length === 0) return false; // nothing stored for this session

    // Derive the commit message from the stored metadata so the branch history
    // reads the same as it does under the branch backend.
    let model = 'unknown';
    try {
      const metaRaw = files.find(([n]) => n === 'metadata.json')?.[1];
      if (metaRaw) model = (JSON.parse(metaRaw) as SessionMetadata).model || model;
    } catch { /* keep the fallback */ }

    return foldSessionIntoBranch(
      repoPath,
      safeId,
      files,
      sessionCommitMessage(safeId, model, 'published session'),
      null, // the ref is authoritative — no downgrade guard needed
    );
  } catch {
    return false;
  }
}

/**
 * Publish a session and push the `origin-sessions` branch to the remote, so the
 * context survives to whoever clones next.
 *
 * Always pushes the BRANCH, never the per-session refs: a plain `git clone`
 * fetches refs/heads/* and refs/tags/* and nothing else, so refs/origin/sessions/*
 * would sit on the remote unread by anyone without Origin tooling. The refs are
 * the local hot-path store; the branch is the portable artifact.
 *
 * Call this at publish moments (a commit, session end) rather than on every
 * prompt — folding into the branch rewrites its whole tree, which is the cost
 * the refs backend exists to keep off the hot path.
 *
 * Never blocks or throws. 15s timeout.
 *
 * Respects config.pushStrategy:
 *   - 'auto' (default): publish + push automatically
 *   - 'prompt': skip (user will push manually or via pre-push hook)
 *   - 'false': never push
 */
export function pushSessionBranch(repoPath: string, sessionId?: string): void {
  try {
    const config = loadConfig();
    if (!shouldBuildSessionBranch(config)) return;

    // Fold this session's ref onto the branch first — under the refs backend
    // the branch has nothing for it yet. No-op under the branch backend.
    if (sessionId) publishSessionToBranch(repoPath, sessionId);

    // Built, but this user pushes it themselves (pre-push hook / by hand). The
    // branch must exist for that to be possible, which is why the build above
    // is NOT gated on the push decision.
    if (!shouldPushSessionBranch(config)) return;

    const execOpts = {
      cwd: repoPath,
      timeoutMs: 15_000,
    };

    const snapshotRepo = config?.snapshotRepo;

    if (snapshotRepo) {
      // Push to external snapshot repo. Validate the repo value — it may
      // be a remote name, path, or URL configured by the user, so allow a
      // restricted set of characters to block injection via shell metachars.
      // Reject anything that starts with '-' to block git option injection
      // (e.g. --upload-pack=/tmp/evil would otherwise be parsed as a flag).
      if (snapshotRepo.startsWith('-')) return;
      if (!/^[a-zA-Z0-9_./:@+%~=-]+$/.test(snapshotRepo)) return;
      // Use '--' as end-of-options marker for defense in depth.
      git(['push', '--no-verify', '--quiet', '--', snapshotRepo, BRANCH], execOpts);
    } else {
      // Push to same repo's origin remote
      const remote = gitDetailed(['remote', 'get-url', 'origin'], execOpts);
      if (remote.status !== 0) return; // no remote — nothing to push
      git(['push', 'origin', BRANCH, '--no-verify', '--quiet'], execOpts);
    }
  } catch {
    // Never fail — push is best-effort
  }
}
