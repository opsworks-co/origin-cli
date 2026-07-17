import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import type { PromptEdit } from './prompt-capture/types.js';
import { ensureOwnerStamp } from './session-owner.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * One entry per pre-tool-use / post-tool-use pair. The historical name was
 * `SubagentRecord` but this tracks ALL tool calls (Bash, Read, Edit, Task,
 * etc.) — not just Task-spawned sub-agents. Renamed in the R2 audit cleanup.
 *
 * Real sub-agent spawns (Claude Code Task tool) need their own record type
 * with model/subagent_type fields — see docs/notes/SUBAGENT_AUDIT.md (R3).
 */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  endedAt?: string;
  prompt?: string;
  result?: string;
}

export interface TabCompletionStats {
  count: number;
  acceptedCount: number;
  totalCharsGenerated: number;
  avgAcceptanceRate: number;
}

export interface SessionState {
  sessionId: string;          // Origin API session ID
  // Set by `origin sessions sync` once it has successfully replayed
  // session/start for a queued local-* session: the REAL server session id,
  // persisted BEFORE session/end is attempted. If session/end then fails (or
  // the process dies), the next retry resumes at session/end with this id
  // instead of calling session/start again — which would create a second,
  // orphaned server row. Cleared implicitly when the file is removed on a
  // fully-successful upload.
  syncedSessionId?: string;
  // The agent's own session identifier, locked at session-start. Different
  // agents call it different things — Claude Code: session_id; Cursor:
  // session_id / conversation_id (matches the agent-transcripts/<id>/ dir);
  // Codex: thread_id (matches threads.id in ~/.codex/state_*.sqlite and the
  // rollout-<id>.jsonl filename); Gemini: session_id from stdin.
  //
  // Anchors EVERY downstream lookup: transcript discovery, rollout pickup,
  // and hook routing. We never fall back to "newest by mtime" or
  // "basename LIKE %x%" anymore — if the ID can't be matched, the hook
  // captures nothing and logs the miss instead of guessing.
  agentSessionId?: string;
  // Backward-compat field name — older state files predate `agentSessionId`
  // and key off this one. New code prefers `agentSessionId`; old readers
  // (findSessionByClaudeId, etc.) continue to work because session-start
  // mirrors the agent's session ID into both fields.
  claudeSessionId: string;
  transcriptPath: string;     // Path to JSONL transcript file
  model: string;
  startedAt: string;          // ISO timestamp
  prompts: string[];          // Accumulated user prompts
  // Per-prompt assistant responses, captured opportunistically when the
  // agent ships the reply on stdin (Gemini's `prompt_response`). Indexed
  // by prompt index so we can interleave them with `prompts` in the
  // synthesized transcript when no real JSONL is available.
  promptResponses?: string[];
  repoPath: string;           // Git repo root path OR working directory
  // Last cwd seen on a lifecycle hook (session-start, pre/post-tool-use).
  // Differs from repoPath when the harness moves the session into a linked
  // git worktree AFTER session-start: the state file stays registered under
  // the main repo's .git, but the session actually works in the worktree.
  // Bare git hooks (prepare-commit-msg, post-commit) get no stdin metadata,
  // so this is their only signal for matching a worktree commit to the
  // session that made it when several sessions share one repo.
  lastCwd?: string;
  headShaAtStart: string | null; // HEAD commit SHA when session started (null if no git)
  // Shadow commit (created by createShadowCommit at session start) that
  // snapshots the FULL working tree — tracked mods + untracked — as it was
  // when the session began. Unlike headShaAtStart (a clean commit), this
  // captures pre-existing uncommitted dirt, so the heartbeat can diff against
  // it to tell genuine session edits apart from dirt that was already there.
  // Null when the tree was clean at start (no shadow needed).
  sessionStartShadowSha?: string | null;
  headShaAtLastStop: string | null; // HEAD SHA after last prompt stop (for per-prompt diffs)
  prePromptSha: string | null;  // HEAD SHA before current prompt (for per-prompt git diffs)
  // Per-prompt shadow commits captured by the heartbeat daemon when it
  // detects a new user_message in the rollout (Codex etc. that don't fire
  // user-prompt-submit reliably). `promptShadows[i]` is the SHA of a
  // shadow commit reflecting the working tree state at the START of
  // prompt i. Per-prompt diff for prompt N = `git diff
  // promptShadows[N] → promptShadows[N+1]` (or → working tree for the
  // latest prompt). Lets us isolate per-turn work even when no hook fires
  // at prompt boundaries.
  promptShadows?: Array<{
    promptIndex: number;
    shadowSha: string;
    capturedAt: string; // ISO timestamp
  }>;
  completedPromptMappings?: Array<{  // Accumulated per-prompt file change mappings
    promptIndex: number;
    promptText: string;
    filesChanged: string[];
    diff: string;
    uncommittedDiff?: string;
    commitSha?: string | null;
    treeSha?: string | null;
    // True when Stop decided this prompt didn't touch code (no commits, no
    // transcript edits). Prevents the next user-prompt-submit retroactive
    // capture from sweeping in pre-existing dirty changes.
    chatOnly?: boolean;
  }>;
  // Live per-edit ledger appended by the post-tool-use hook as each
  // Edit / Write / MultiEdit fires, stamped with the prompt index active at
  // capture time. Authoritative: the exact tool inputs, caught in real time,
  // so they dodge the transcript's editsJson truncation, format drift, and
  // not-yet-flushed-at-Stop races. Merged with the transcript capture at
  // Stop/session-end (mergeLedgerWithTranscript) so shell/commit edits the
  // live hook never sees are still covered. Bounded by LIVE_EDIT_MAX_ENTRIES
  // and per-content clamping in hooks.ts. Disable with ORIGIN_LIVE_CAPTURE=0.
  liveEdits?: Array<{
    promptIndex: number;
    toolName: string;
    capturedAt: string;
    edits: PromptEdit[];
  }>;
  branch: string | null;      // Git branch at session start
  sessionTag?: string;        // Tag for concurrent session support
  // Ring buffer of tool-call pre/post records. Field kept as `subagents` for
  // backward compat with serialized session-state files. See R2 in
  // docs/notes/SUBAGENT_AUDIT.md.
  subagents?: ToolCallRecord[];
  tabCompletions?: TabCompletionStats;
  agentSystemPrompt?: string; // Cached agent system prompt for session resume
  activePolicies?: string[];  // Cached active policies for session resume
  verboseCapture?: boolean;   // Opt-in flag from the repo: capture full tool inputs + tool_result bodies
  prePromptDirtyFiles?: string[]; // Files that were already dirty (uncommitted) before current prompt
  // Files that were uncommitted at session-start. Captured BEFORE the start-
  // shadow trick zeros out prePromptDirtyFiles. Persists for the life of the
  // session so the session-end snapshot can still filter out pre-existing
  // pollution (e.g. an earlier agent's leftover uncommitted edits) even
  // though prePromptDirtyFiles has since been rotated to per-prompt state.
  sessionStartDirtyFiles?: string[];
  // Commits made BY this session, as recorded by the post-commit hook. Used
  // to scope `committedDiff` to commits this session actually authored —
  // crucial when multiple agents run concurrently on the same repo: without
  // this, a `git diff prePromptSha...HEAD` heartbeat picks up commits made
  // by the OTHER session (HEAD has moved) and credits them to the wrong
  // agent in AI Blame.
  sessionCommitShas?: string[];
  // policyId/ruleId/policyName ride along (sent by session/start since the
  // audit-reporting change) so hook-level blocks can report WHICH policy
  // fired; older state files lack them and degrade to type-only reports.
  enforcementRules?: Array<{
    type: string; condition: string; action: string; severity: string;
    policyId?: string; ruleId?: string; policyName?: string;
  }>;
  // When enforcementRules was last refreshed from the server (epoch ms).
  // The heartbeat rewrites the rules from each ping; pre-tool-use does a
  // TTL-bounded refetch when this is stale (or absent) so a policy created
  // mid-session is enforced without waiting for the next session start.
  // Absent on older state files → treated as "stale", triggers a refresh.
  enforcementRulesFetchedAt?: number;
  // Hard budget cap lockout. Set when the server reports a blocking cap
  // breached (session PATCH response or heartbeat ping), cleared when it
  // reports clear. user-prompt-submit and pre-tool-use consult this to
  // block new AI work; ORIGIN_BUDGET_OVERRIDE=1 bypasses.
  budgetBlocked?: boolean;
  budgetBlockReason?: string;
  // Why session/start failed and this session stayed local. Read by `origin
  // status` to report the REAL reason (repo-not-registered, agent-disabled, …)
  // instead of a canned "agent was disabled" string.
  syncBlock?: import('./sync-block.js').SyncBlock;
  // Scoped SOFT-cap warning (warn-only — nothing is locked). Persisted by
  // the heartbeat from ping payloads; user-prompt-submit surfaces it once
  // per distinct reason in the conversation and records it in
  // budgetWarnShownFor so the banner doesn't repeat on every prompt.
  budgetWarnReason?: string;
  budgetWarnShownFor?: string;
  // One audit report per lockout episode — set after the first blocked
  // prompt/tool reports to /violations, cleared when the lockout lifts.
  budgetBlockReported?: boolean;
  trailId?: string;           // Trail ID if session is linked to an active trail
  agentSlug?: string;         // Agent slug (claude-code, cursor, codex, gemini, etc.)
  // Files the agent loaded into context (deduped, capped). Populated lazily
  // in pre-tool-use whenever a Read-style tool fires. Persisted into git
  // notes at session-end as `filesRead` so the next agent can see what the
  // prior agent looked at — not just what it changed.
  filesRead?: string[];
  // Pointer to the previous session in this repo (captured at session-start
  // from refs/notes/origin-memory). Persisted into git notes so readers can
  // walk a chain of sessions across commits.
  previousSessionId?: string;
  // ISO timestamp the previous session started — used to scope the
  // acceptance backfill scan to only commits that session could have authored.
  previousSessionStartedAt?: string;
  status?: string;            // RUNNING | ENDED | COMPLETED
  endedAt?: string;           // ISO timestamp when session ended
  // Owning Origin account, stamped once at first save (see session-owner.ts).
  // ownerOrgId = the orgId that captured this session; ownerKeyHash = sha256
  // fingerprint (first 16 hex) of that account's API key — never the raw key.
  // Immutable after the first write so an account switch can't relabel a
  // previous account's session. Absent on legacy/standalone sessions.
  ownerOrgId?: string;
  ownerKeyHash?: string;
  // Canonical (main) repo path when repoPath is a linked worktree — the
  // identity sent to the server (repo naming, session/commit ingest) so a
  // worktree session attributes to the real project, while repoPath stays
  // the WORKING root all git capture runs against. Equal to repoPath (or
  // absent, on pre-worktree-fix states) for normal checkouts.
  canonicalRepoPath?: string;
  // Multi-repo support: when cwd contains multiple git repos
  repoPaths?: string[];       // All git repo roots discovered under cwd
  perRepoState?: Record<string, {
    headShaAtStart: string | null;
    headShaAtLastStop: string | null;
    prePromptSha: string | null;
    prePromptDirtyFiles: string[];
    branch: string | null;
  }>;
}

// ─── Git Directory ─────────────────────────────────────────────────────────

export function getGitDir(cwd?: string): string | null {
  try {
    return execSync('git rev-parse --git-dir', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

export function getGitRoot(cwd?: string): string | null {
  try {
    const top = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!top) return null;
    // Linked git worktrees report their own --show-toplevel — e.g.
    // <repo>/.claude/worktrees/quirky-albattani-c9f7c3. The basename then
    // becomes the "repo name" on the dashboard, which is wrong: the
    // worktree is just a working copy of the SAME repo. Detect via
    // --git-common-dir (points at the MAIN repo's .git for linked
    // worktrees, equals "<top>/.git" otherwise) and walk back to the
    // actual repo so Origin attributes sessions to the canonical project.
    //
    // NOTE: this is the CANONICAL/identity root — the right thing to send
    // to the server (repo naming, session/commit ingest) and to locate
    // repo-level resources shared across worktrees (.git/hooks). It is the
    // WRONG cwd for capturing a worktree session's work: diffs/HEAD/staged
    // files must be read from the worktree itself (its files only show up
    // here as untracked `.claude/worktrees/<id>/…` dirt, and its commits
    // never move this HEAD). Use getWorkingGitRoot for git operations.
    return getCanonicalRepoPath(top);
  } catch {
    return null;
  }
}

// The WORKING git root: the top of the working tree that actually contains
// cwd — for a linked worktree, the worktree itself (NOT the main repo).
// This is the correct cwd for every git operation that captures a session's
// work: diff/HEAD/staged-file reads, shadow commits, restore. Verified on
// production session 5606d120 (Claude Code worktree): capturing from the
// collapsed main root recorded the session's edits as untracked
// `.claude/worktrees/<id>/…` files, never saw its commits (main HEAD does
// not move), and broke staged-file commit attribution.
export function getWorkingGitRoot(cwd?: string): string | null {
  try {
    const top = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return top || null;
  } catch {
    return null;
  }
}

// Collapse a working-tree top to the canonical (main) repo path when it is a
// linked worktree; returns the input path unchanged otherwise. Split out of
// getGitRoot so callers holding a working root can derive the identity root
// without re-running discovery.
export function getCanonicalRepoPath(workRoot: string): string {
  try {
    const commonDirRaw = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf-8', cwd: workRoot, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (commonDirRaw) {
      const absCommonDir = path.isAbsolute(commonDirRaw)
        ? commonDirRaw
        : path.resolve(workRoot, commonDirRaw);
      const mainRepo = path.dirname(absCommonDir);
      // Sanity: only collapse when the main repo path is a different,
      // non-empty directory that actually exists. Anything weird → keep
      // the working root so we don't accidentally hide the worktree session.
      if (mainRepo && mainRepo !== workRoot && fs.existsSync(mainRepo)) {
        return mainRepo;
      }
    }
  } catch { /* fall through */ }
  return workRoot;
}

// Path of a file inside the git dir that governs `repoPath` — worktree-aware:
// a linked worktree's `.git` is a FILE pointing at the per-worktree git dir
// (<main>/.git/worktrees/<name>), so `path.join(repoPath, '.git', name)` is
// wrong there. Resolves via `git rev-parse --git-dir`; falls back to the
// plain join when git can't run (deleted repo — callers stat/read and treat
// a miss as "no signal"). Use for files git itself keeps PER worktree
// (COMMIT_EDITMSG); session state lives in the COMMON dir — see below.
export function gitDirFilePath(repoPath: string, filename: string): string {
  const gitDir = getGitDir(repoPath);
  if (gitDir) {
    const resolved = path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);
    return path.join(resolved, filename);
  }
  return path.join(repoPath, '.git', filename);
}

export function getGitCommonDir(cwd?: string): string | null {
  try {
    const out = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(cwd || process.cwd(), out);
  } catch {
    return null;
  }
}

// Session state files live in the COMMON git dir — one place per repo,
// shared by the main checkout and every linked worktree. Worktree sessions
// (repoPath = the worktree top) must still be visible to repo-scoped
// lookups (zombie sweeps, `origin sessions`, pre-commit policy/violation
// session resolution, concurrent-session isolation), all of which resolve
// from the main checkout or via the collapsing getGitRoot. Cross-worktree
// ATTRIBUTION safety comes from lastCwd narrowing in listSessionsForGitHook,
// not from hiding the files in per-worktree dirs.
export function gitCommonDirFilePath(repoPath: string, filename: string): string {
  const common = getGitCommonDir(repoPath);
  if (common) return path.join(common, filename);
  return path.join(repoPath, '.git', filename);
}

/**
 * Try harder to find a git repo when the cwd itself isn't one.
 * Checks immediate subdirectories and common workspace patterns.
 * Useful when Claude Code reports a project root that's a parent of the actual repo.
 */
export function discoverGitRoot(cwd?: string): string | null {
  const dir = cwd || process.cwd();

  // 1. Direct check
  const direct = getGitRoot(dir);
  if (direct) return direct;

  // 2. Check common workspace patterns (e.g. .openclaw/workspace/*)
  const workspacePatterns = [
    path.join(dir, '.openclaw', 'workspace'),
    path.join(dir, 'workspace'),
  ];
  for (const wsDir of workspacePatterns) {
    try {
      if (!fs.existsSync(wsDir)) continue;
      const entries = fs.readdirSync(wsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(wsDir, entry.name);
        const found = getGitRoot(candidate);
        if (found) return found;
      }
    } catch { /* ignore */ }
  }

  // 3. Scan immediate subdirectories (one level deep)
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = path.join(dir, entry.name);
      if (fs.existsSync(path.join(candidate, '.git'))) {
        return getGitRoot(candidate);
      }
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Discover git repos in known multi-repo workspace layouts.
 *
 * Only matches the intentional cowork pattern (`.openclaw/workspace/*` or
 * `workspace/*`). We deliberately do NOT scan arbitrary subdirectories —
 * running an agent from a parent dir like `~` or `~/projects` used to attach
 * every unrelated repo under it to the session. Repos that aren't part of
 * a workspace get attached lazily when the agent actually touches a file in
 * them (see `handlePreToolUse` / `handlePostToolUse` in hooks.ts).
 */
export function discoverAllGitRoots(cwd?: string): string[] {
  const dir = cwd || process.cwd();

  // If the directory itself is a git repo, return just that
  const direct = getGitRoot(dir);
  if (direct) return [direct];

  const roots: string[] = [];

  // Known multi-repo workspace patterns
  const workspacePatterns = [
    path.join(dir, '.openclaw', 'workspace'),
    path.join(dir, 'workspace'),
  ];
  for (const wsDir of workspacePatterns) {
    try {
      if (!fs.existsSync(wsDir)) continue;
      const entries = fs.readdirSync(wsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(wsDir, entry.name);
        const found = getGitRoot(candidate);
        if (found && !roots.includes(found)) roots.push(found);
      }
    } catch { /* ignore */ }
  }

  return roots;
}

/**
 * True when `p` is the bare openclaw cowork CONTAINER directory
 * (`…/.openclaw/workspace`) itself, not a repo inside it.
 *
 * The openclaw harness repeatedly relaunches a bare `claude` at this container
 * — no git repo, no repos inside — as warm-up / health-check probes that send
 * no prompt and touch no file. session-start uses this to skip registering a
 * throwaway non-git "workspace" session for those launches. Real work in the
 * harness launches from a repo SUBDIR under the container
 * (`…/.openclaw/workspace/<repo>`), which resolves to that repo and is tracked
 * normally — so only the empty container launch is dropped.
 *
 * Deliberately matches ONLY the intentional `.openclaw/workspace` cowork
 * pattern — NOT a bare `~/workspace`, which is commonly a real project dir.
 */
export function isCoworkContainerPath(p: string | null | undefined): boolean {
  if (!p) return false;
  const norm = p.replace(/[\\/]+$/, '');
  return /(^|[\\/])\.openclaw[\\/]workspace$/.test(norm);
}

/**
 * True when `p` is a filesystem ROOT (`/`, `C:\`). No real coding session
 * runs at the root of the filesystem — but agent apps' own internal LLM
 * subroutines do: the Codex app fires its ambient-suggestion safety filter /
 * title-generation meta-calls with `cwd: "/"`, and each one fired the full
 * session-start → user-prompt-submit → stop hook trio, registering a
 * repo-less junk session (e.g. "gpt-5.4-mini / 0 files / 'You are an expert
 * at upholding safety and compliance standards for Codex ambient
 * suggestions…'"). session-start uses this to skip registering any non-git
 * session anchored at a bare filesystem root.
 */
export function isFilesystemRootPath(p: string | null | undefined): boolean {
  if (!p) return false;
  const resolved = path.resolve(p);
  return resolved === path.parse(resolved).root;
}

export function getHeadSha(cwd?: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

export function getBranch(cwd?: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim() || null;
  } catch {
    return null;
  }
}

// Resolve the branch the session is ACTUALLY on. `repoPath` is collapsed to
// the MAIN repo for linked worktrees (getGitRoot does this so the dashboard
// attributes the session to the canonical project, not the worktree's
// basename). But the agent works on the worktree's OWN branch — reading the
// branch from repoPath returns the MAIN checkout's branch ("main") for every
// worktree session, which is the "all sessions show main" bug.
//
// Always prefer the live working directory (the hook's cwd, or the last cwd
// seen on a lifecycle hook) where `git rev-parse HEAD` resolves the worktree's
// branch; fall back to repoPath only when no working-dir cwd is known. Each
// candidate is guarded so we never run getBranch() against process.cwd()
// (an undefined cwd), which could be an unrelated directory.
export function resolveSessionBranch(
  state: { lastCwd?: string; repoPath?: string },
  cwdHint?: string,
): string | null {
  for (const dir of [cwdHint, state.lastCwd, state.repoPath]) {
    if (!dir) continue;
    const b = getBranch(dir);
    if (b) return b;
  }
  return null;
}

// ─── Session State Persistence ─────────────────────────────────────────────

/**
 * Get the path for storing session state.
 * Prefers .git/origin-session.json if in a git repo.
 * Falls back to ~/.origin/sessions/<cwd-hash>.json otherwise.
 */
export function getStatePath(cwd?: string, sessionTag?: string): string {
  const suffix = sessionTag ? `origin-session-${sessionTag}.json` : 'origin-session.json';

  // Try git dir first — the COMMON dir, so a worktree session's state is
  // discoverable by repo-scoped lookups from any checkout (see
  // gitCommonDirFilePath). Falls back to --git-dir (identical outside
  // worktrees) for odd setups where --git-common-dir fails.
  const gitDir = getGitCommonDir(cwd) || getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    return path.join(resolvedGitDir, suffix);
  }

  // Fallback: store in ~/.origin/sessions/ keyed by cwd hash
  return getGlobalFallbackStatePath(cwd, sessionTag);
}

// Sandbox-safe state location, OUTSIDE the repo's .git — keyed by cwd (+ tag)
// so save and load agree. Codex's workspace-write sandbox forbids writes inside
// .git, so a hook that can't persist state into .git lands it here instead.
// This is also the path getStatePath returns when there's no git dir at all.
export function getGlobalFallbackStatePath(cwd?: string, sessionTag?: string): string {
  const effectiveCwd = cwd || process.cwd();
  const cwdHash = crypto.createHash('md5').update(effectiveCwd).digest('hex').slice(0, 12);
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const basename = sessionTag ? `${cwdHash}-${sessionTag}.json` : `${cwdHash}.json`;
  return path.join(sessionsDir, basename);
}

export function saveSessionState(state: SessionState, cwd?: string, sessionTag?: string): void {
  // First-write-wins ownership stamp so a later account switch can't pull this
  // session into a different account (see session-owner.ts).
  ensureOwnerStamp(state);
  const statePath = getStatePath(cwd, sessionTag || state.sessionTag);
  try {
    const tmpStatePath = statePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpStatePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmpStatePath, statePath);
  } catch (err: any) {
    // Sandboxed agents (Codex's workspace-write) forbid writes INSIDE .git →
    // EPERM/EACCES. A thrown save aborts the whole Stop hook, which the agent
    // then surfaces as "hook timed out after 10s". Persist to the sandbox-safe
    // fallback the loader also checks instead of failing the hook.
    if (err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EROFS') {
      const fb = getGlobalFallbackStatePath(cwd, sessionTag || state.sessionTag);
      if (fb !== statePath) {
        const tmpFb = fb + '.tmp.' + process.pid;
        fs.writeFileSync(tmpFb, JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.renameSync(tmpFb, fb);
      }
    } else {
      throw err;
    }
  }

  // Also mirror to ~/.origin/sessions/ for global discovery (origin sessions --all)
  // Always mark as RUNNING since this is an active save
  try {
    const globalDir = path.join(os.homedir(), '.origin', 'sessions');
    fs.mkdirSync(globalDir, { recursive: true, mode: 0o700 });
    const globalPath = path.join(globalDir, `${state.sessionId.slice(0, 12)}.json`);
    const globalState = { ...state, status: 'RUNNING' };
    const tmpGlobalPath = globalPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpGlobalPath, JSON.stringify(globalState, null, 2), { mode: 0o600 });
    fs.renameSync(tmpGlobalPath, globalPath);
  } catch { /* non-fatal */ }
}

export function loadSessionState(cwd?: string, sessionTag?: string): SessionState | null {
  const statePath = getStatePath(cwd, sessionTag);
  const tryRead = (p: string): SessionState | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.sessionId || !parsed.claudeSessionId) return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const primary = tryRead(statePath);
  if (primary) return primary;
  // Sandbox couldn't write .git → the state landed in the global fallback.
  const fb = getGlobalFallbackStatePath(cwd, sessionTag);
  if (fb !== statePath) return tryRead(fb);
  return null;
}

export function clearSessionState(cwd?: string, sessionTag?: string): void {
  const statePath = getStatePath(cwd, sessionTag);
  const fbPath = getGlobalFallbackStatePath(cwd, sessionTag);
  // The active state lives in .git normally, or in the global fallback when a
  // sandbox blocked the .git write — read from wherever it actually landed.
  let raw: string | null = null;
  for (const p of (fbPath !== statePath ? [statePath, fbPath] : [statePath])) {
    try { raw = fs.readFileSync(p, 'utf-8'); break; } catch { /* try next */ }
  }
  try {
    if (raw) {
      // Instead of deleting, mark as ended and archive to ~/.origin/sessions/
      const state = JSON.parse(raw);
      state.status = 'ENDED';
      state.endedAt = new Date().toISOString();

      // Archive to ~/.origin/sessions/ so origin sessions --all can find it
      const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      const archivePath = path.join(archiveDir, `${state.sessionId.slice(0, 12)}.json`);
      const tmpArchivePath = archivePath + '.tmp.' + process.pid;
      fs.writeFileSync(tmpArchivePath, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmpArchivePath, archivePath);
    }
  } catch { /* corrupt state — fall through to plain delete */ }
  // Remove the active state file from both possible locations.
  try { fs.unlinkSync(statePath); } catch { /* ignore */ }
  if (fbPath !== statePath) { try { fs.unlinkSync(fbPath); } catch { /* ignore */ } }
}

// ─── Concurrent Session Support ──────────────────────────────────────────

// Idle cutoff for treating a non-ENDED session as actually-alive. A session
// with no fresh git-state-file write, no live heartbeat, and no recent state
// file touch within this window is a zombie (the agent process died without a
// clean end) and must not be considered for commit attribution etc.
const SESSION_STALE_MS = 3 * 60 * 60 * 1000; // 3 hours — matches findSessionByClaudeId / listAllActiveSessions

/**
 * Is this session genuinely still alive? An ENDED session is dead. Otherwise it
 * counts as alive only if there's a fresh signal: the repo's git-state file was
 * written recently, its heartbeat daemon's PID is live, or the state file the
 * session was loaded from was touched recently. Zombie sessions (process died
 * without a clean end — common for Cursor / stale-file agents) fail all three.
 *
 * `statePath` is the file the state was read from (attached by listActiveSessions
 * as `__statePath`); pass it for the freshest signal.
 */
export function isSessionAlive(state: SessionState, statePath?: string): boolean {
  if (!state) return false;
  if ((state as any).status === 'ENDED' || state.endedAt) return false;

  // 1. The repo's live git-state file was updated within the window.
  // gitCommonDirFilePath: state.repoPath is the WORKING root, which for a
  // linked worktree has a `.git` FILE — the state json lives in the COMMON
  // git dir, not at <repoPath>/.git/.
  if (state.repoPath && state.sessionTag) {
    try {
      const gitStateFile = gitCommonDirFilePath(state.repoPath, `origin-session-${state.sessionTag}.json`);
      if (Date.now() - fs.statSync(gitStateFile).mtimeMs < SESSION_STALE_MS) return true;
    } catch { /* file gone */ }
  }
  // 2. The heartbeat daemon's PID is still alive.
  try {
    const pidFile = path.join(os.homedir(), '.origin', 'heartbeats', `${state.sessionId}.pid`);
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) { process.kill(pid, 0); return true; }
    }
  } catch { /* process dead */ }
  // 3. The state file we loaded from was touched recently.
  const p = statePath || (state as any).__statePath;
  if (p) {
    try { if (Date.now() - fs.statSync(p).mtimeMs < SESSION_STALE_MS) return true; } catch { /* gone */ }
  }
  return false;
}

/**
 * Permanently close a session locally: mark it ENDED and persist to the file it
 * was loaded from (plus the ~/.origin/sessions global mirror). Used to
 * auto-close zombie sessions so they don't linger "RUNNING" and keep getting
 * picked for commit attribution. Returns true if it changed anything.
 */
export function markSessionEnded(state: SessionState): boolean {
  if (!state || (state as any).status === 'ENDED') return false;
  (state as any).status = 'ENDED';
  state.endedAt = state.endedAt || new Date().toISOString();
  const writeAtomic = (p: string) => {
    try {
      const tmp = `${p}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch { /* best effort */ }
  };
  const loadedFrom = (state as any).__statePath as string | undefined;
  if (loadedFrom) writeAtomic(loadedFrom);
  // Keep the global mirror in sync (the file may have been read from .git).
  try {
    if (state.repoPath && state.sessionTag) {
      const cwdHash = crypto.createHash('md5').update(state.repoPath).digest('hex').slice(0, 12);
      const mirror = path.join(os.homedir(), '.origin', 'sessions', `${cwdHash}-${state.sessionTag}.json`);
      if (mirror !== loadedFrom && fs.existsSync(mirror)) writeAtomic(mirror);
    }
  } catch { /* ignore */ }
  return true;
}

/**
 * List all active sessions in a git repo (or cwd).
 * Scans for all origin-session*.json files.
 */
export function listActiveSessions(cwd?: string): SessionState[] {
  const sessions: SessionState[] = [];

  // Check git dir (COMMON dir — matches getStatePath, so a lookup from a
  // worktree and one from the main checkout read the same directory)
  const gitDir = getGitCommonDir(cwd) || getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          try {
            const fullPath = path.join(resolvedGitDir, entry);
            const state = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            if (!state || typeof state !== 'object' || !state.sessionId) continue;
            // Extract sessionTag from filename: origin-session-TAG.json or origin-session.json
            if (!state.sessionTag) {
              const tagMatch = entry.match(/^origin-session-(.+)\.json$/);
              if (tagMatch) state.sessionTag = tagMatch[1];
            }
            Object.defineProperty(state, '__statePath', { value: fullPath, enumerable: false });
            sessions.push(state);
          } catch { /* skip corrupt files */ }
        }
      }
    } catch { /* ignore */ }
    return sessions;
  }

  // Check fallback dir
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  try {
    const effectiveCwd = cwd || process.cwd();
    const cwdHash = crypto.createHash('md5').update(effectiveCwd).digest('hex').slice(0, 12);
    const entries = fs.readdirSync(sessionsDir);
    for (const entry of entries) {
      if (entry.startsWith(cwdHash) && entry.endsWith('.json')) {
        try {
          const fullPath = path.join(sessionsDir, entry);
          const state = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          if (!state || typeof state !== 'object' || !state.sessionId) continue;
          Object.defineProperty(state, '__statePath', { value: fullPath, enumerable: false });
          sessions.push(state);
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }

  return sessions;
}

/**
 * List sessions from ALL repos (for --all/--global flag).
 * Scans ~/.origin/sessions/ for both active and archived sessions.
 */
export function listAllActiveSessions(): SessionState[] {
  const sessions: SessionState[] = [];
  const seen = new Set<string>();

  // Scan ~/.origin/sessions/ — ALL files (active + archived)
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  try {
    const entries = fs.readdirSync(sessionsDir);
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        try {
          const filePath = path.join(sessionsDir, entry);
          const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (!state || typeof state !== 'object' || !state.sessionId) continue;
          if (seen.has(state.sessionId)) continue;
          seen.add(state.sessionId);

          // Auto-expire RUNNING sessions that are stale:
          // If status is not ENDED, check if the session is actually still alive
          if (state.status !== 'ENDED') {
            const STALE_MS = 3 * 60 * 60 * 1000; // 3 hours
            let isAlive = false;

            // Check 1: is there an active .git state file being updated?
            // (worktree-aware: resolves the per-worktree git dir)
            if (state.repoPath && state.sessionTag) {
              try {
                const gitStateFile = gitCommonDirFilePath(state.repoPath, `origin-session-${state.sessionTag}.json`);
                const stat = fs.statSync(gitStateFile);
                if (Date.now() - stat.mtimeMs < STALE_MS) {
                  isAlive = true;
                }
              } catch { /* file gone or not accessible */ }
            }

            // Check 2: is the heartbeat daemon still running?
            if (!isAlive) {
              try {
                const heartbeatDir = path.join(os.homedir(), '.origin', 'heartbeats');
                const pidFile = path.join(heartbeatDir, `${state.sessionId}.pid`);
                if (fs.existsSync(pidFile)) {
                  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
                  if (pid > 0) {
                    process.kill(pid, 0); // existence check
                    isAlive = true;
                  }
                }
              } catch { /* process dead or pid file gone */ }
            }

            // Check 3: was the archive file itself recently updated?
            if (!isAlive) {
              try {
                const stat = fs.statSync(filePath);
                if (Date.now() - stat.mtimeMs < STALE_MS) {
                  isAlive = true;
                }
              } catch { /* ignore */ }
            }

            if (!isAlive) {
              state.status = 'ENDED';
              state.endedAt = state.endedAt || new Date().toISOString();
              // Persist the correction
              try {
                const tmpFilePath = filePath + '.tmp.' + process.pid;
                fs.writeFileSync(tmpFilePath, JSON.stringify(state), { mode: 0o600 });
                fs.renameSync(tmpFilePath, filePath);
              } catch { /* best effort */ }
            }
          }

          sessions.push(state);
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }

  return sessions;
}

/**
 * Find a session by its Claude session ID.
 *
 * Searches both the local repo's state files and the global mirror
 * (`~/.origin/sessions/`), which catches multi-repo workspaces where a nested
 * `.git/` dir belonged to a different hookCwd than session-start saw. Stale
 * `.git/origin-session-*.json` files whose mtime is older than FRESH_MS are
 * skipped so a previous day's crashed session can't hijack a resumed Claude
 * session that reuses the same claudeSessionId.
 */
export function findSessionByClaudeId(claudeSessionId: string, cwd?: string): SessionState | null {
  const FRESH_MS = 3 * 60 * 60 * 1000; // 3 hours — matches listAllActiveSessions staleness
  const candidates: Array<{ state: SessionState; mtime: number }> = [];

  const pushIfFresh = (filePath: string, state: unknown) => {
    const s = state as SessionState | null;
    if (!s || s.claudeSessionId !== claudeSessionId) return;
    if (s.status === 'ENDED') return;
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
    if (mtime && Date.now() - mtime > FRESH_MS) return;
    candidates.push({ state: s, mtime });
  };

  // Local .git / hashed fallback — both default and tagged files
  const defaultPath = getStatePath(cwd);
  try { pushIfFresh(defaultPath, JSON.parse(fs.readFileSync(defaultPath, 'utf-8'))); } catch { /* ignore */ }
  const gitDir = getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    try {
      for (const entry of fs.readdirSync(resolvedGitDir)) {
        if (!entry.startsWith('origin-session') || !entry.endsWith('.json')) continue;
        const p = path.join(resolvedGitDir, entry);
        try { pushIfFresh(p, JSON.parse(fs.readFileSync(p, 'utf-8'))); } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  // Global mirror — catches nested-repo / multi-repo cases where the active
  // session was saved under a different cwd's git dir.
  const globalDir = path.join(os.homedir(), '.origin', 'sessions');
  try {
    for (const entry of fs.readdirSync(globalDir)) {
      if (!entry.endsWith('.json')) continue;
      const p = path.join(globalDir, entry);
      try { pushIfFresh(p, JSON.parse(fs.readFileSync(p, 'utf-8'))); } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  if (candidates.length === 0) return null;
  // Prefer the most recently-written candidate — that's the live session.
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].state;
}

/**
 * Clear all session state files (e.g., after session-end).
 */
// ─── Heartbeat Daemon ───────────────────────────────────────────────────────

function getHeartbeatPidFile(sessionId: string): string {
  const dir = path.join(os.homedir(), '.origin', 'heartbeats');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${sessionId}.pid`);
}

/**
 * Walk up the process tree to find an ancestor whose command matches a pattern.
 * Returns the PID of the matching ancestor, or 0 if not found.
 * Used to find the actual agent process (e.g. Codex, Gemini) since hooks are
 * spawned via shell wrappers that die immediately after the hook exits.
 */
// Heuristic to recognize Origin's own hook subprocesses so we DON'T
// pick them as the "agent" PID. The command line of a hook invocation
// is something like
//   node /path/to/origin/dist/index.js hooks claude-code stop
// which contains "claude-code" and would happily satisfy a
// /claude/i ancestor search — but the hook subprocess dies seconds
// after it returns. Heartbeat would then think Claude exited and
// end the session ~30s into the user's first real prompt.
//
// Recognized markers (in priority order):
//   - "origin hooks" / "origin-cli" command path → almost certainly
//     us. The CLI's binary directory tends to contain "origin" too.
//   - "origin-cli" anywhere in the argv (npm install paths, dev
//     symlinks).
// Conservative — we'd rather walk past one of our own subprocesses
// and find the real agent than match the wrong PID.
const ORIGIN_HOOK_MARKER = /origin[-/](?:cli|hooks?)|origin\s+hooks?\b|@origin\/cli/i;

function findAncestorPid(pattern: RegExp, maxDepth = 10): number {
  try {
    let pid = process.ppid || 0;
    for (let i = 0; i < maxDepth && pid > 1; i++) {
      // Get the command and parent of this PID
      const info = execSync(`ps -p ${pid} -o ppid=,command=`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      // Pull ppid off the front BEFORE testing the rest against
      // the pattern so the "match" is on the actual command line,
      // not "<ppid> <command>".
      const firstSpace = info.indexOf(' ');
      const commandPart = firstSpace >= 0 ? info.slice(firstSpace + 1) : info;
      // Skip Origin's own hook subprocesses — they match every
      // agent pattern via their argv but die after the hook
      // returns. Walking past them gets us to the real agent.
      const isOriginSelf = ORIGIN_HOOK_MARKER.test(commandPart);
      if (!isOriginSelf && pattern.test(commandPart)) return pid;
      // Move to parent
      const ppid = parseInt(info.trim().split(/\s+/)[0], 10);
      if (isNaN(ppid) || ppid <= 1 || ppid === pid) break;
      pid = ppid;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * Spawn a detached background process that pings the API every 30s.
 * Keeps the session marked as RUNNING even when idle between prompts.
 * Passes the parent PID and session state file path so the daemon can
 * self-terminate when the agent process dies or the session ends.
 */
export function startHeartbeat(sessionId: string, apiUrl: string, apiKey: string, stateFile?: string, agentSlug?: string): void {
  const pidFile = getHeartbeatPidFile(sessionId);

  // Kill any existing heartbeat for this session
  stopHeartbeat(sessionId);

  try {
    // Resolve the heartbeat script path (sibling to this file in dist/)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const heartbeatScript = path.join(__dirname, 'heartbeat.js');

    if (!fs.existsSync(heartbeatScript)) {
      // Fallback: script not found (dev mode or missing build)
      return;
    }

    // Agent → liveness-detection strategy.
    //
    // LONG_RUNNING_AGENTS: process.ppid IS the agent (heartbeat watches
    //   that single PID). Only works when the agent runs the hook in its
    //   own process and stays alive between hook fires.
    // STALE_FILE_ONLY_AGENTS: parent PID is unreliable, so the heartbeat
    //   relies on state-file mtime instead. Used for IDE/Electron agents
    //   whose process tree is full of short-lived helpers.
    // AGENT_PROCESS_PATTERNS: walk up the tree and match by command
    //   substring. Last-resort — fragile against OS wrappers.
    //
    // Why Claude Code is now stale-file-only:
    // On macOS the Claude Desktop app launches the real `claude` CLI via
    // `/Applications/Claude.app/Contents/Helpers/disclaimer`, which
    // exec-launches the binary and exits shortly after. When the hook
    // fires from a descendant of `claude`, walking up matches the
    // `disclaimer` wrapper first (its argv contains the absolute path
    // `.../claude.app/Contents/MacOS/claude`, satisfying /claude/i). The
    // wrapper then dies, the heartbeat sees the captured PID gone, and
    // ends the session at ~19 minutes while the Claude tab is still
    // open. The same trap exists for Squirrel's `ShipIt` auto-updater,
    // which also matches /claude/i but is transient. Per-OS wrapper
    // carve-outs are an endless game of whack-a-mole; the only durable
    // signal we have is "did any Claude hook fire recently" — that
    // updates the state file via saveSessionState on every
    // UserPromptSubmit / PreToolUse / Stop / etc., so a fresh file mtime
    // means Claude is alive. Staleness threshold is raised to 90 min in
    // heartbeat.ts so a long read of a single response doesn't false-end.
    const LONG_RUNNING_AGENTS = ['windsurf'];
    // Cursor: Electron helpers die immediately, can't track parent PID.
    // Claude Code: macOS wrapper trap (see above). Treat both as
    // stale-file-only.
    const STALE_FILE_ONLY_AGENTS = ['cursor', 'claude-code'];
    const AGENT_PROCESS_PATTERNS: Record<string, RegExp> = {
      'gemini': /gemini/i,
      'aider': /aider/i,
      'codex': /codex/i,
    };

    let parentPid: number;
    if (agentSlug && LONG_RUNNING_AGENTS.includes(agentSlug)) {
      // For Claude Code / Windsurf, process.ppid is the agent itself
      parentPid = process.ppid || 0;
      // Verify the parent is actually alive
      if (parentPid > 0) {
        try { process.kill(parentPid, 0); } catch { parentPid = 0; }
      }
    } else if (agentSlug && STALE_FILE_ONLY_AGENTS.includes(agentSlug)) {
      // Cursor: can't reliably detect parent — use stale file check only
      parentPid = 0;
    } else {
      // For all other agents, walk the process tree to find the agent process.
      // If we find it, heartbeat monitors that PID. If not, fall back to stale file check.
      const pattern = agentSlug ? AGENT_PROCESS_PATTERNS[agentSlug] : undefined;
      parentPid = pattern ? findAncestorPid(pattern) : 0;
      // If pattern search failed, try to find the shell/terminal as a fallback
      // so the heartbeat dies when the terminal is closed
      if (parentPid <= 0) {
        parentPid = findAncestorPid(/bash|zsh|fish|sh$/i) || 0;
      }
    }

    const child = spawn(process.execPath, [heartbeatScript, sessionId, apiUrl, '', pidFile, String(parentPid), stateFile || ''], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ORIGIN_HEARTBEAT_API_KEY: apiKey },
    });
    child.unref();
  } catch {
    // Non-fatal — session tracking still works, just no keepalive
  }
}

/**
 * Kill the heartbeat daemon for a session.
 */
export function stopHeartbeat(sessionId: string): void {
  const pidFile = getHeartbeatPidFile(sessionId);
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      fs.unlinkSync(pidFile);
    }
  } catch {
    // Ignore
  }
}

/**
 * Check if the heartbeat daemon is still alive for a session.
 */
export function isHeartbeatAlive(sessionId: string): boolean {
  const pidFile = getHeartbeatPidFile(sessionId);
  try {
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (pid <= 0) return false;
    // signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function clearAllSessionStates(cwd?: string): void {
  const gitDir = getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          try { fs.unlinkSync(path.join(resolvedGitDir, entry)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}
