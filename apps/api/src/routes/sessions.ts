import { Router, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';
import { expensiveLimiter } from '../middleware/rate-limit.js';
import { notifyOrgAdmins, notifyOrgMembers } from '../services/notifications.js';
import { safeParseArray, safeParseObject } from '../utils/safe-json.js';
import {
  ORIGIN_AUTO_MANAGED_FILES,
  stripAutoManagedSections,
  isDiffEntirelyOriginManaged,
} from '../utils/auto-managed-files.js';
import { generateSessionTitle } from '../services/ai-summarize.js';

/** Check if user has admin/owner role */
function isAdminUser(req: AuthRequest): boolean {
  const role = (req.activeRole! || '').toUpperCase();
  return role === 'ADMIN' || role === 'OWNER';
}

/** Build session where-clause scoped to user (non-admins see only own sessions) */
function scopedSessionWhere(req: AuthRequest, base: any = {}): any {
  if (!isAdminUser(req)) {
    base.userId = req.user!.id;
  }
  return base;
}
import {
  getIntegrationConfig,
  getSessionsForPR,
  computeCheckStatus,
  postCommitStatus,
  postPRComment,
  updatePRComment,
  buildSessionSummaryComment,
  parseRepoFullName,
} from '../services/github-integration.js';
import { onSessionEvent, SessionEvent, emitSessionEvent } from '../services/session-events.js';
import { callLLM } from './chat.js';
import { getOrgLLMKey, getOrgLLMModel, getOrgLLMProvider } from './settings.js';
import { runAIReview } from '../services/ai-review.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

const IDLE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min without prompt activity → IDLE
// Auto-end sessions idle for 1 hour even if heartbeat is alive (agent stopped working)
const AUTO_END_IDLE_MS = 60 * 60 * 1000; // 1 hour
// Safety net: if heartbeat hasn't pinged in 2 hours, the agent is truly dead.
// This only catches cases where the heartbeat daemon crashed without sending session/end.
const ABANDONED_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
// Hard cap: no real coding session should run longer than this. Catches
// runaway heartbeats and ghost sessions that never sent a prompt or end
// event. If startedAt was >24h ago and we're still "RUNNING", force-close.
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function computeStatus(s: any): string {
  // COMPLETED/ERROR = terminal states. Only set by explicit session/end call.
  if (s.status === 'COMPLETED' || s.status === 'ERROR') return s.status;

  // RUNNING sessions: check prompt activity for IDLE detection
  if (s.status === 'RUNNING') {
    const lastPrompt = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;
    if (lastPrompt && Date.now() - lastPrompt > IDLE_THRESHOLD_MS) return 'IDLE';
    return 'RUNNING';
  }

  return s.status || 'COMPLETED';
}

/**
 * Derive a short human-readable title for a session from the data we have.
 *
 * Strategy (cheap, no LLM): first non-empty line of the first prompt, then
 * the first commit message, then the model. Capped to ~70 chars so the
 * snapshot list and sessions list stay tidy. The DB column \`aiTitle\` lets
 * a future enrichment pass overwrite this with an LLM-generated summary
 * without changing the read path.
 */
function deriveSessionTitle(s: any): string | null {
  const clean = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    // Drop common boilerplate prefixes / role markers.
    let t = String(raw).trim();
    if (!t) return null;
    // First non-empty line
    t = t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
    if (!t) return null;
    // Strip leading punctuation/markdown
    t = t.replace(/^[#>\-*\s]+/, '').trim();
    if (t.length > 70) t = t.slice(0, 67).trimEnd() + '…';
    // Title-case the first letter so it reads as a session label.
    if (t.length > 0) t = t[0].toUpperCase() + t.slice(1);
    return t || null;
  };

  // Prefer the first prompt — it's almost always the most descriptive.
  // promptChanges (when included by the query) preserve order; fall back
  // to s.prompt which is the joined prompt text.
  const firstPrompt = Array.isArray(s.promptChanges) && s.promptChanges.length > 0
    ? s.promptChanges[0]?.promptText
    : null;
  const fromPrompt = clean(firstPrompt) || clean(s.prompt);
  if (fromPrompt) return fromPrompt;

  const fromCommit = clean(s.commit?.message);
  if (fromCommit) return fromCommit;

  return null;
}

// Cap diff size returned to clients. A single Gemini prompt that touched
// many files can produce a 1-5MB pc.diff (full unified diff incl. context
// for every file). Even though sessionDiff itself was capped at 500KB on
// the storage path, per-prompt diffs weren't — and rendering a multi-MB
// diff in DiffHunkRenderer creates tens of thousands of DOM nodes that
// freeze Chrome for seconds. 200KB per diff is plenty for human review;
// the rare giant diff gets a "(truncated)" tail so users know there's more.
const DIFF_RESPONSE_CAP = 200_000;
function capDiffForResponse(raw: string | null | undefined): string {
  if (!raw) return raw || '';
  if (raw.length <= DIFF_RESPONSE_CAP) return raw;
  return raw.slice(0, DIFF_RESPONSE_CAP) + '\n… (diff truncated — full diff omitted to keep the dashboard responsive)';
}

// Cap transcript size returned to clients. Multi-MB transcripts (Gemini
// with verbose tool capture) block Chrome's main thread for seconds on the
// response's JSON.parse and freeze the session-detail page on every poll.
// Strategy: if the stored transcript parses as a JSON array of messages
// (the normal Origin shape), drop oldest messages until under the cap. If
// it doesn't parse, byte-truncate — the client falls back to its synth-
// from-promptChanges path when JSON.parse fails on the truncated chunk.
const TRANSCRIPT_RESPONSE_CAP = 500_000;
function capTranscriptForResponse(raw: string | null | undefined): string {
  if (!raw) return raw || '';
  if (raw.length <= TRANSCRIPT_RESPONSE_CAP) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Keep the newest messages, drop oldest until we fit. Newest first
      // is what the dashboard sorts to by default for RUNNING sessions, so
      // dropping the oldest preserves the visible/expanded content the
      // user is currently looking at.
      const kept: any[] = [];
      let size = 2; // "[]"
      for (let i = parsed.length - 1; i >= 0; i--) {
        const entry = JSON.stringify(parsed[i]);
        const add = entry.length + (kept.length > 0 ? 1 : 0); // comma between entries
        if (size + add > TRANSCRIPT_RESPONSE_CAP) break;
        kept.unshift(parsed[i]);
        size += add;
      }
      if (kept.length === 0) {
        // Even a single message exceeds the cap — fall back to a stub.
        return JSON.stringify([{ role: 'system', content: '(transcript truncated — too large to serve inline)' }]);
      }
      return JSON.stringify(kept);
    }
  } catch { /* fall through to byte-truncate */ }
  // Non-array transcript (or parse failed): byte-truncate. Client's JSON.parse
  // will throw on the partial JSON and fall through to synthesizing a
  // transcript from promptChanges.
  return raw.slice(0, TRANSCRIPT_RESPONSE_CAP);
}

function mapSession(s: any, pullRequests?: any[]) {
  return {
    id: s.id,
    commitId: s.commitId,
    agentId: s.agentId,
    agentName: s.agent?.name || null,
    userId: s.userId || null,
    // Prefer real user → email → API key name. Never expose the
    // "mcp-agent" placeholder string that the commit-author column
    // sometimes carries when no user is linked.
    userName: s.user?.name || s.user?.email || s.apiKeyName || null,
    userEmail: s.user?.email || null,
    apiKeyId: s.apiKeyId || null,
    apiKeyName: s.apiKeyName || null,
    repoId: s.commit?.repoId || null,
    repoName: s.commit?.repo?.name || null,
    repoNames: s.sessionRepos && s.sessionRepos.length > 0
      ? s.sessionRepos.map((sr: any) => sr.repo?.name).filter(Boolean)
      : (s.commit?.repo?.name ? [s.commit.repo.name] : []),
    commitSha: s.commit?.sha || null,
    commitMessage: s.commit?.message || null,
    commitAuthor: s.commit?.author || null,
    committedAt: s.commit?.committedAt || null,
    model: s.model,
    prompt: s.prompt,
    aiTitle: (s as any).aiTitle || deriveSessionTitle(s),
    // Cap transcript at 500KB so the browser doesn't block parsing a
    // multi-MB blob on every poll. Gemini sessions in particular can
    // accumulate huge transcripts (full tool outputs interleaved with
    // assistant text) — at megabyte scale Chrome's main thread blocks
    // long enough on JSON.parse that the page goes unresponsive. When
    // truncated we lop off the tail (not the head) since the UI shows
    // newest-first and a sentinel JSON-array close so the client's
    // JSON.parse still succeeds.
    transcript: capTranscriptForResponse(s.transcript),
    transcriptTruncated: (s.transcript?.length || 0) > 500_000,
    filesChanged: s.filesChanged,
    tokensUsed: s.tokensUsed,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: (s as any).cacheReadTokens ?? 0,
    cacheCreationTokens: (s as any).cacheCreationTokens ?? 0,
    toolCalls: s.toolCalls,
    durationMs: (() => {
      const status = computeStatus(s);
      // For active sessions, compute live duration from startedAt
      if ((status === 'RUNNING' || status === 'IDLE') && s.startedAt) {
        return Date.now() - new Date(s.startedAt).getTime();
      }
      return s.durationMs;
    })(),
    linesAdded: s.linesAdded,
    linesRemoved: s.linesRemoved,
    costUsd: s.costUsd,
    branch: s.branch || null,
    status: computeStatus(s),
    archived: s.archived || false,
    startedAt: s.startedAt || null,
    endedAt: s.endedAt || null,
    agentSystemPrompt: s.agentSystemPrompt || null,
    agentVersion: s.agentVersion || null,
    // safeParse* everywhere in this mapper: one corrupt row used to 500 the
    // entire list endpoint because a single JSON.parse throw inside a .map
    // callback bubbles all the way out. Logging + falling back to a sane
    // default keeps the list rendering while still surfacing the bad row.
    mergedFrom: s.mergedFrom ? safeParseObject(s.mergedFrom, `session.${s.id}.mergedFrom`, null as any) : null,
    mergedInto: s.mergedInto || null,
    agentSessionId: s.agentSessionId || null,
    parentSessionId: s.parentSessionId || null,
    createdAt: s.createdAt,
    review: s.review
      ? {
          id: s.review.id,
          status: s.review.status,
          note: s.review.note,
          score: s.review.score ?? null,
          riskLevel: s.review.riskLevel ?? null,
          concerns: safeParseArray(s.review.concerns, `session.${s.id}.review.concerns`),
          suggestions: safeParseArray(s.review.suggestions, `session.${s.id}.review.suggestions`),
          categories: s.review.categories
            ? safeParseObject(s.review.categories, `session.${s.id}.review.categories`, null as any)
            : null,
          isAutoReview: s.review.isAutoReview ?? false,
          reviewerName: s.review.user?.name || null,
          createdAt: s.review.createdAt,
        }
      : null,
    pullRequests: pullRequests
      ? pullRequests.map((pr: any) => ({
          id: pr.id,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          checkStatus: pr.checkStatus,
          author: pr.author,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
        }))
      : undefined,
    // Git capture data (only included on detail endpoint). Strip Origin-
    // auto-managed files (AGENTS.md, GEMINI.md, .windsurfrules, fully-managed
    // CLAUDE.md) at read time so they never reach the per-prompt diff /
    // session diff UIs. The CLI strips at capture time too, but legacy
    // sessions captured before that landing need the read-time pass.
    sessionDiff: s.sessionDiff
      ? {
          headBefore: s.sessionDiff.headBefore,
          headAfter: s.sessionDiff.headAfter,
          commitShas: safeParseArray<string>(s.sessionDiff.commitShas, `session.${s.id}.sessionDiff.commitShas`),
          diff: capDiffForResponse(stripAutoManagedSections(s.sessionDiff.diff || '')),
          diffTruncated: s.sessionDiff.diffTruncated || (s.sessionDiff.diff?.length || 0) > DIFF_RESPONSE_CAP,
          linesAdded: s.sessionDiff.linesAdded,
          linesRemoved: s.sessionDiff.linesRemoved,
        }
      : null,
    promptChanges: s.promptChanges
      ? (() => {
          // Deduplicate by promptIndex (race condition can create duplicates)
          const seen = new Set<number>();
          const isAutoManagedFile = (f: string): boolean => {
            const basename = (f || '').split('/').pop() || '';
            return (
              ORIGIN_AUTO_MANAGED_FILES.has(f) ||
              ORIGIN_AUTO_MANAGED_FILES.has(basename) ||
              basename === 'CLAUDE.md'
            );
          };
          // Strip diff sections whose file isn't in a known set. Reused
          // below to enforce editsJson as the authoritative file set when
          // the new pipeline populated it.
          const stripDiffToFiles = (diffText: string, allowed: Set<string>): string => {
            if (!diffText || allowed.size === 0) return diffText;
            const parts = diffText.split(/^(?=diff --git )/m);
            const kept: string[] = [];
            for (const part of parts) {
              const header = part.split('\n', 1)[0] || '';
              const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
              if (!m) continue;
              const fp = m[2].replace(/^\//, '');
              const basename = fp.split('/').pop() || '';
              if (allowed.has(fp) || allowed.has(basename)) kept.push(part);
            }
            return kept.join('').trim();
          };
          // Dedup pre-pass: when a prompt's uncommittedDiff is
          // byte-identical to the previous prompt's, this prompt didn't
          // introduce any new working-tree change — the heartbeat just
          // re-captured prompt N-1's still-pending edits. Carrying it
          // forward makes prompts 2+ look like they touched files they
          // never edited. Clear those (and the matching filesChanged /
          // diff if THEY also clone the previous turn). Same logic for
          // pc.diff: the post-commit hook sometimes echoes the same
          // commit diff across consecutive prompts when the user
          // committed once and then kept chatting.
          const orderedPcs = Array.from(s.promptChanges as any[]).sort(
            (a, b) => (a.promptIndex || 0) - (b.promptIndex || 0),
          );
          const blankByIndex = new Map<number, { diff: boolean; uncommitted: boolean; files: boolean }>();
          for (let i = 1; i < orderedPcs.length; i++) {
            const cur = orderedPcs[i];
            const prev = orderedPcs[i - 1];
            // Build the "effective" prev for comparison — when prev was
            // itself blanked, the carry-over chain continues against the
            // ORIGINAL signal (the prompt that first introduced this diff).
            // Without this, only consecutive prompts get deduped and the
            // 3rd/4th in a row would still echo the same content.
            let basePrev = prev;
            for (let k = i - 1; k >= 0; k--) {
              const candidate = orderedPcs[k];
              const blanked = blankByIndex.get(candidate.promptIndex);
              if (!blanked || !(blanked.diff && blanked.uncommitted)) {
                basePrev = candidate;
                break;
              }
            }
            const sameDiff = (cur.diff || '') === (basePrev.diff || '') && (cur.diff || '').length > 0;
            const sameUncommitted = (cur.uncommittedDiff || '') === (basePrev.uncommittedDiff || '') && (cur.uncommittedDiff || '').length > 0;
            const noNewWork = sameDiff && sameUncommitted;
            blankByIndex.set(cur.promptIndex, {
              diff: sameDiff,
              uncommitted: sameUncommitted,
              // When neither diff nor uncommittedDiff brought new
              // content vs the previous prompt, this prompt was
              // chat-only — also blank filesChanged AND skip the
              // commit-patch fallback below. Otherwise prompt N's UI
              // panel would still show files inherited from N-1.
              files: noNewWork,
            });
          }
          return s.promptChanges
            .map((pc: any) => {
              const blanks = blankByIndex.get(pc.promptIndex) || { diff: false, uncommitted: false, files: false };
              const rawFiles = blanks.files
                ? []
                : safeParseArray<string>(pc.filesChanged, `session.${s.id}.promptChanges.filesChanged`);

              // Authoritative editsJson takes over filesChanged + diff +
              // uncommittedDiff when present AND non-empty. An editsJson
              // with `edits: []` is NOT authoritative — Codex's extractor
              // returns an empty edits list whenever it can't attribute
              // commits to that prompt (rollout missing markers, last
              // prompt before stop hook, etc.). Treating an empty list as
              // "this prompt touched nothing" would strip the legacy
              // pc.diff/pc.uncommittedDiff data that actually came from
              // git capture. So we only apply the filter when editsJson
              // carries real edits — otherwise fall through to legacy
              // (which already filters auto-managed files + dedupes).
              let pcEditsFiles: Set<string> | null = null;
              if (typeof pc.editsJson === 'string' && pc.editsJson.length > 0) {
                try {
                  const cap = JSON.parse(pc.editsJson);
                  if (cap && Array.isArray(cap.edits) && cap.edits.length > 0) {
                    pcEditsFiles = new Set<string>();
                    for (const e of cap.edits) {
                      if (e && typeof e.file === 'string') {
                        pcEditsFiles.add(e.file);
                      }
                    }
                    if (pcEditsFiles.size === 0) pcEditsFiles = null;
                  }
                } catch { /* malformed — fall back to legacy */ }
              }

              let cleanFiles = rawFiles.filter((f) => !isAutoManagedFile(f));
              // Apply the dedup-pre-pass result: blank out diff /
              // uncommitted when this prompt's text is byte-identical to
              // the previous prompt's (carry-over of unchanged
              // working-tree state, not a new edit).
              let cleanDiff = blanks.diff
                ? ''
                : capDiffForResponse(stripAutoManagedSections(pc.diff || ''));
              let cleanUncommitted = blanks.uncommitted
                ? ''
                : capDiffForResponse(stripAutoManagedSections(pc.uncommittedDiff || ''));

              // Commit-patch fallback: when pc.diff is empty (the
              // per-prompt git-diff capture missed it — common when the
              // user-prompt-submit hook didn't fire before the agent's
              // commit) but pc.commitSha matches one of the session's
              // commits, use that Commit.patch as the displayed diff.
              // Same for filesChanged from Commit.filesChanged. Without
              // this, the prompt panel shows an empty card for any
              // prompt whose only data lives on its commit row.
              //
              // Skipped when this prompt is a chat-only carry-over of
              // the previous prompt's state (see blankByIndex above) —
              // otherwise the fallback would refill a deliberately
              // blanked prompt with prompt N-1's commit content.
              const isChatOnlyCarryOver = blanks.diff && blanks.uncommitted;
              if (
                !isChatOnlyCarryOver &&
                (!cleanFiles.length || !cleanDiff.trim()) &&
                pc.commitSha &&
                Array.isArray((s as any).commits)
              ) {
                const c: any = (s as any).commits.find((cc: any) => cc.sha === pc.commitSha);
                if (c) {
                  if (!cleanDiff.trim() && c.patch) {
                    cleanDiff = capDiffForResponse(stripAutoManagedSections(c.patch));
                  }
                  if (!cleanFiles.length && c.filesChanged) {
                    try {
                      const cf: string[] = JSON.parse(c.filesChanged || '[]');
                      cleanFiles = (Array.isArray(cf) ? cf : []).filter((f) => !isAutoManagedFile(f));
                    } catch { /* ignore malformed */ }
                  }
                }
              }

              // When pc.commitSha points at a real session commit, the
              // commit is the ground truth — editsJson does NOT get to
              // override. Without this gate, a Codex prompt whose
              // editsJson was wrongly assembled by the pre-fix extractor
              // would wipe out the (correct) pc.diff / commit content.
              const hasMatchingCommit = !!(
                pc.commitSha &&
                Array.isArray((s as any).commits) &&
                (s as any).commits.some((cc: any) => cc.sha === pc.commitSha)
              );
              if (pcEditsFiles && !hasMatchingCommit) {
                // editsJson is authoritative — drop anything outside it.
                cleanFiles = cleanFiles.filter((f) => {
                  const basename = f.split('/').pop() || '';
                  return pcEditsFiles!.has(f) || pcEditsFiles!.has(basename);
                });
                cleanDiff = stripDiffToFiles(cleanDiff, pcEditsFiles);
                cleanUncommitted = stripDiffToFiles(cleanUncommitted, pcEditsFiles);
              }

              return {
                promptIndex: pc.promptIndex,
                promptText: pc.promptText,
                filesChanged: cleanFiles,
                diff: cleanDiff,
                uncommittedDiff: cleanUncommitted,
                linesAdded: pc.linesAdded || 0,
                linesRemoved: pc.linesRemoved || 0,
                aiPercentage: pc.aiPercentage ?? 100,
                checkpointType: pc.checkpointType || null,
                commitSha: pc.commitSha || null,
                treeSha: pc.treeSha || null,
                createdAt: pc.createdAt,
              };
            })
            .filter((pc: any) => {
              if (seen.has(pc.promptIndex)) return false;
              seen.add(pc.promptIndex);
              return true;
            });
        })()
      : [],
    // Snapshots taken during this session, exposed for the timeline rail.
    snapshots: Array.isArray(s.snapshots)
      ? s.snapshots.map((sn: any) => ({
          id: sn.id,
          snapshotId: sn.snapshotId,
          type: sn.type,
          takenAt: sn.takenAt,
          promptIndex: sn.promptIndex,
          commitSha: sn.commitSha,
        }))
      : [],
    // All commits attributed to this session (primary + sessionCommits union),
    // deduplicated by SHA and sorted by time. Surfaces commits made on
    // feature branches during the session — the primary commit field only
    // ever points at one of them.
    commits: (() => {
      const all: any[] = [];
      if (s.commit) all.push(s.commit);
      if (Array.isArray(s.commits)) {
        for (const c of s.commits) all.push(c);
      }
      const seen = new Set<string>();
      return all
        .filter((c) => {
          if (!c?.sha || seen.has(c.sha)) return false;
          seen.add(c.sha);
          return true;
        })
        .sort((a, b) => new Date(a.committedAt).getTime() - new Date(b.committedAt).getTime())
        .map((c) => ({
          id: c.id,
          sha: c.sha,
          message: c.message,
          author: c.author,
          branch: c.branch || null,
          committedAt: c.committedAt,
          filesChanged: safeParseArray<string>(c.filesChanged, `session.${s.id}.commits.${c.sha}.filesChanged`),
          repoName: c.repo?.name || null,
        }));
    })(),
  };
}

// GET / — list coding sessions for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const where: any = {
      commit: {
        repo: { orgId },
      },
      archived: req.query.archived === 'true' ? true : false,
      mergedInto: null, // hide sessions that were merged into another
    };

    if (req.query.model) {
      where.model = req.query.model as string;
    }

    if (req.query.agentId) {
      where.agentId = req.query.agentId as string;
    }

    if (req.query.repoId) {
      where.OR = [
        { commit: { ...where.commit, repoId: req.query.repoId as string } },
        { commit: { repo: { orgId } }, sessionRepos: { some: { repoId: req.query.repoId as string } } },
      ];
    }

    if (req.query.repoName) {
      where.commit = {
        ...where.commit,
        repo: { ...where.commit?.repo, name: req.query.repoName as string },
      };
    }

    if (req.query.branch) {
      where.branch = req.query.branch as string;
    }

    if (req.query.userId) {
      where.userId = req.query.userId as string;
    }

    // Enforce repo-scoped API key access
    if (req.apiKeyRepoScopes && req.apiKeyRepoScopes.length > 0) {
      where.commit = {
        ...where.commit,
        repoId: { in: req.apiKeyRepoScopes },
      };
    }

    // User-level scoping:
    //   - Non-admin: see only your own sessions.
    //   - Admin/Owner of a TEAM org: see everyone's sessions in the org.
    //   - Admin/Owner of a PERSONAL org: still see only your own. A
    //     personal workspace is logically a single-user surface; seeing
    //     sessions attributed to a previous-user tombstone (e.g. after
    //     an account delete+recreate) confuses the dashboard more than
    //     it helps.
    //   - ?mine=true on any role forces "only mine".
    const userRole = (req.activeRole! || '').toUpperCase();
    const isAdmin = userRole === 'ADMIN' || userRole === 'OWNER';
    const orgRow = await prisma.org.findUnique({ where: { id: orgId }, select: { type: true } });
    const isPersonalOrg = orgRow?.type === 'personal';
    if (!isAdmin || isPersonalOrg || req.query.mine === 'true') {
      where.userId = req.user!.id;
    }

    const status = req.query.status as string;
    if (status === 'RUNNING' || status === 'COMPLETED') {
      where.status = status;
    } else if (status === 'reviewed') {
      where.review = { isNot: null };
    } else if (status === 'unreviewed') {
      where.review = null;
    } else if (status === 'flagged') {
      where.review = { status: 'FLAGGED' };
    } else if (status === 'approved') {
      where.review = { status: 'APPROVED' };
    } else if (status === 'rejected') {
      where.review = { status: 'REJECTED' };
    }

    const [sessions, total, aggregates] = await Promise.all([
      prisma.codingSession.findMany({
        where,
        include: {
          commit: { include: { repo: true } },
          agent: true,
          user: true,
          review: { include: { user: true } },
          sessionRepos: { include: { repo: true } },
          promptChanges: { orderBy: { promptIndex: 'asc' } },
        },
        orderBy: [
          { status: 'desc' },   // RUNNING sorts before COMPLETED alphabetically
          { createdAt: 'desc' },
        ],
        take: limit,
        skip: offset,
      }),
      prisma.codingSession.count({ where }),
      prisma.codingSession.aggregate({
        where,
        _sum: { costUsd: true, tokensUsed: true, durationMs: true, toolCalls: true },
        _avg: { costUsd: true, durationMs: true },
        _count: true,
      }),
    ]);

    // Safety net: expire abandoned or long-idle sessions.
    const now = Date.now();
    const abandonedIds: string[] = [];
    for (const s of sessions) {
      if (s.status === 'RUNNING') {
        const lastHeartbeat = new Date(s.updatedAt || s.createdAt).getTime();
        const lastPrompt = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;
        const startedAt = new Date(s.startedAt || s.createdAt).getTime();

        // Heartbeat died
        if (now - lastHeartbeat > ABANDONED_THRESHOLD_MS) {
          abandonedIds.push(s.id);
          s.status = 'COMPLETED';
          s.endedAt = s.updatedAt || s.createdAt;
          continue;
        }
        // Heartbeat alive but idle for 1 hour
        if (lastPrompt && now - lastPrompt > AUTO_END_IDLE_MS) {
          abandonedIds.push(s.id);
          s.status = 'COMPLETED';
          s.endedAt = new Date(lastPrompt + AUTO_END_IDLE_MS);
          continue;
        }
        // Hard cap: a single session running for more than 24h is always a
        // ghost. Catches heartbeat-only sessions that never sent a prompt
        // (so the lastPrompt check above short-circuits) and runaway
        // heartbeat loops.
        if (now - startedAt > MAX_SESSION_AGE_MS) {
          abandonedIds.push(s.id);
          s.status = 'COMPLETED';
          s.endedAt = new Date(startedAt + MAX_SESSION_AGE_MS);
          continue;
        }
      }
    }
    if (abandonedIds.length > 0) {
      prisma.codingSession.updateMany({
        where: { id: { in: abandonedIds } },
        data: { status: 'COMPLETED', endedAt: new Date() },
      }).catch(() => {});
    }

    // Count flagged/rejected sessions across all matching (not just current page)
    const flaggedCount = await prisma.sessionReview.count({
      where: {
        session: where,
        status: { in: ['FLAGGED', 'REJECTED'] },
      },
    }).catch(() => 0);

    // Count scored reviews for avg score
    const scoreAgg = await prisma.sessionReview.aggregate({
      where: {
        session: where,
        score: { not: null },
      },
      _avg: { score: true },
      _count: true,
    }).catch(() => ({ _avg: { score: null }, _count: 0 }));

    // Fire-and-forget: upgrade heuristic titles to LLM-generated ones for
    // sessions in this page that don't have an aiTitle yet. Capped to 5
    // per request so a fresh dashboard view doesn't fan out into dozens
    // of provider calls. Caller's response uses whatever's already on
    // the row; the next page load picks up the upgraded titles.
    try {
      const needsTitle = sessions.filter((s: any) => !s.aiTitle).slice(0, 5);
      for (const s of needsTitle) {
        generateSessionTitle(s.id).catch(() => { /* silent — heuristic stays */ });
      }
    } catch { /* ignore */ }

    res.json({
      sessions: sessions.map((s) => mapSession(s)),
      total,
      aggregates: {
        totalCost: aggregates._sum.costUsd || 0,
        totalTokens: aggregates._sum.tokensUsed || 0,
        totalDuration: aggregates._sum.durationMs || 0,
        totalTools: aggregates._sum.toolCalls || 0,
        avgCost: aggregates._avg.costUsd || 0,
        avgDuration: aggregates._avg.durationMs || 0,
        avgScore: scoreAgg._avg.score != null ? Math.round(scoreAgg._avg.score) : null,
        flaggedCount,
      },
    });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /active — currently running sessions
router.get('/active', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    const activeWhere: any = {
      status: 'RUNNING',
      commit: { repo: { orgId } },
    };

    // Non-admin users only see their own active sessions
    const activeRole = (req.activeRole! || '').toUpperCase();
    const activeIsAdmin = activeRole === 'ADMIN' || activeRole === 'OWNER';
    if (!activeIsAdmin) {
      activeWhere.userId = req.user!.id;
    }

    // Active sessions list — cap 500 since "active" should be small by
    // definition (sessions still running in the last ~2h).
    const sessions = await prisma.codingSession.findMany({
      where: activeWhere,
      include: {
        commit: { include: { repo: true } },
        agent: true,
        user: true,
        review: { include: { user: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Auto-end abandoned or long-idle sessions
    const now = Date.now();
    const endIds: string[] = [];
    for (const s of sessions) {
      const lastHeartbeat = new Date(s.updatedAt || s.createdAt).getTime();
      const lastPrompt = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;

      // Heartbeat died — agent crashed
      if (now - lastHeartbeat > ABANDONED_THRESHOLD_MS) {
        endIds.push(s.id);
        s.status = 'COMPLETED';
        s.endedAt = s.updatedAt || s.createdAt;
        continue;
      }

      // Heartbeat alive but no prompt activity for 1 hour — agent stopped working
      if (lastPrompt && now - lastPrompt > AUTO_END_IDLE_MS) {
        endIds.push(s.id);
        s.status = 'COMPLETED';
        s.endedAt = new Date(lastPrompt + AUTO_END_IDLE_MS);
        continue;
      }
    }
    if (endIds.length > 0) {
      prisma.codingSession.updateMany({
        where: { id: { in: endIds } },
        data: { status: 'COMPLETED', endedAt: new Date() },
      }).catch(() => {});
    }

    // Only return truly active sessions
    const endSet = new Set(endIds);
    const activeSessions = sessions.filter((s) => !endSet.has(s.id));

    res.json({ sessions: activeSessions.map((s) => mapSession(s)) });
  } catch (err) {
    console.error('List active sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /by-pr — sessions grouped by pull request
router.get('/by-pr', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    // Get all repos for org (cap — the in(...) filter below otherwise
    // scales with total org repos, and unbounded materialization of
    // the id list alone is a DoS on large tenants).
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
      take: 5000,
    });
    const repoIds = repos.map((r) => r.id);

    // Get all PRs with their sessions
    const pullRequests = await prisma.pullRequest.findMany({
      where: { repoId: { in: repoIds } },
      include: { repo: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const results = [];

    for (const pr of pullRequests) {
      let commitShas: string[] = [];
      try {
        commitShas = JSON.parse(pr.commitShas);
      } catch {
        continue;
      }

      if (commitShas.length === 0) continue;

      // Find commits for these SHAs (cap matches PR commit list ceiling)
      const commits = await prisma.commit.findMany({
        where: { repoId: pr.repoId, sha: { in: commitShas } },
        select: { id: true },
        take: 5000,
      });

      const commitIds = commits.map((c) => c.id);
      if (commitIds.length === 0) continue;

      // Find sessions for these commits
      const sessions = await prisma.codingSession.findMany({
        where: { commitId: { in: commitIds } },
        include: {
          commit: { include: { repo: true } },
          agent: true,
          user: true,
          review: { include: { user: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      });

      if (sessions.length === 0) continue;

      // Aggregate stats
      const totalCost = sessions.reduce((sum, s) => sum + s.costUsd, 0);
      const totalTokens = sessions.reduce((sum, s) => sum + s.tokensUsed, 0);
      const totalLinesAdded = sessions.reduce((sum, s) => sum + s.linesAdded, 0);
      const totalLinesRemoved = sessions.reduce((sum, s) => sum + s.linesRemoved, 0);

      results.push({
        pr: {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          author: pr.author,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
          checkStatus: pr.checkStatus,
          repoName: pr.repo.name,
          createdAt: pr.createdAt,
        },
        sessions: sessions.map((s) => mapSession(s)),
        stats: {
          sessionCount: sessions.length,
          totalCost: parseFloat(totalCost.toFixed(2)),
          totalTokens,
          totalLinesAdded,
          totalLinesRemoved,
          reviewStatus: sessions.every((s) => (s as any).review?.status === 'APPROVED')
            ? 'all_approved'
            : sessions.some((s) => (s as any).review?.status === 'REJECTED')
              ? 'has_rejections'
              : sessions.some((s) => (s as any).review?.status === 'FLAGGED')
                ? 'has_flags'
                : 'pending',
        },
      });
    }

    res.json({ groups: results });
  } catch (err) {
    console.error('Sessions by PR error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /by-commit — find session linked to a specific commit SHA
router.get('/by-commit', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const sha = req.query.sha as string;

    if (!sha) {
      return res.status(400).json({ error: 'sha query parameter required' });
    }

    // Find commits matching this SHA in org's repos
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
    });
    const repoIds = repos.map((r) => r.id);

    const commit = await prisma.commit.findFirst({
      where: {
        sha,
        repoId: { in: repoIds },
      },
      include: {
        session: {
          include: {
            agent: true,
            _count: { select: { promptChanges: true } },
          },
        },
        codingSession: {
          include: {
            agent: true,
            _count: { select: { promptChanges: true } },
          },
        },
      },
    });

    if (!commit) {
      return res.status(404).json({ error: 'No session found for this commit' });
    }

    const session = commit.session || commit.codingSession;
    if (!session) {
      return res.status(404).json({ error: 'No session found for this commit' });
    }

    let filesChanged: string[] = [];
    try {
      filesChanged = JSON.parse(session.filesChanged || '[]');
    } catch (err) {
      console.warn(`[sessions] malformed filesChanged JSON for session ${session.id}:`, (err as Error).message);
    }

    res.json({
      sessionId: session.id,
      model: session.model,
      agentName: session.agent?.name || null,
      costUsd: session.costUsd,
      promptCount: (session as any)._count?.promptChanges || 0,
      filesChanged,
    });
  } catch (err) {
    console.error('Get session by commit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /stream — SSE real-time session events
// Per-user concurrent stream cap. Without this an attacker who has a valid
// token (or a misbehaving client) can open N streams within the 120/min
// sessionLimiter budget and hold them indefinitely via server heartbeats,
// pinning sockets + EventEmitter listeners on the server. 10 is generous
// for legit use cases (multi-tab dashboards) and cheap to track in-memory.
const MAX_STREAMS_PER_USER = 10;
const activeStreamCounts = new Map<string, number>();
router.get('/stream', async (req: AuthRequest, res: Response) => {
  const orgId = req.activeOrgId!;
  const streamUserId = req.user!.id;

  const current = activeStreamCounts.get(streamUserId) || 0;
  if (current >= MAX_STREAMS_PER_USER) {
    return res.status(429).json({ error: 'Too many concurrent streams for this user' });
  }
  activeStreamCounts.set(streamUserId, current + 1);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('data: {"type":"connected"}\n\n');

  const streamIsAdmin = isAdminUser(req);

  const unsubscribe = onSessionEvent((event: SessionEvent) => {
    if (event.orgId === orgId && (streamIsAdmin || event.userId === streamUserId)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  // Heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    const next = (activeStreamCounts.get(streamUserId) || 1) - 1;
    if (next <= 0) activeStreamCounts.delete(streamUserId);
    else activeStreamCounts.set(streamUserId, next);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

// PATCH /bulk/archive — bulk archive sessions
router.patch('/bulk/archive', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { sessionIds, archived } = req.body;
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ error: 'sessionIds array required' });
    }
    // DoS cap: one bulk-archive call can touch at most 1000 sessions.
    // Without this a client could pass an arbitrarily long id list and
    // force a huge UPDATE.
    if (sessionIds.length > 1000) {
      return res.status(400).json({ error: 'Cannot archive more than 1000 sessions at once' });
    }

    const orgId = req.activeOrgId!;
    const result = await prisma.codingSession.updateMany({
      where: {
        id: { in: sessionIds },
        commit: { repo: { orgId } },
      },
      data: { archived: archived !== false },
    });

    res.json({ success: true, count: result.count });
  } catch (err) {
    console.error('Bulk archive error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — single session
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const __t0 = Date.now();
  const __tag = (req.params.id as string).slice(0, 8);
  console.log(`[session/get] begin ${__tag}`);
  try {
    const id = req.params.id as string;

    const detailWhere: any = {
      id: id.length < 36 ? { startsWith: id } : id,
      commit: { repo: { orgId: req.activeOrgId! } },
    };

    // Non-admin users can only view their own sessions
    const detailRole = (req.activeRole! || '').toUpperCase();
    const detailIsAdmin = detailRole === 'ADMIN' || detailRole === 'OWNER';
    if (!detailIsAdmin) {
      detailWhere.userId = req.user!.id;
    }

    const session = await prisma.codingSession.findFirst({
      where: detailWhere,
      include: {
        commit: { include: { repo: true } },
        // Additional commits attributed to this session (sessionCommits relation).
        // A session can span multiple commits — especially across branches when
        // a prompt runs `git checkout -b …`. `commit` above is the primary;
        // `commits` is every commit the post-commit hook attributed to us.
        commits: {
          include: { repo: { select: { name: true } } },
          orderBy: { committedAt: 'asc' },
          take: 500,
        },
        agent: true,
        user: true,
        review: { include: { user: true } },
        sessionDiff: true,
        promptChanges: { orderBy: { promptIndex: 'asc' } },
        sessionRepos: { include: { repo: true } },
        snapshots: { orderBy: { takenAt: 'asc' }, take: 500 },
      },
    });

    if (!session) {
      console.log(`[session/get] ${__tag} not-found ${Date.now()-__t0}ms`);
      return res.status(404).json({ error: 'Session not found' });
    }
    const __tDb = Date.now() - __t0;
    const __transcriptLen = (session.transcript || '').length;
    const __sessionDiffLen = (session.sessionDiff?.diff || '').length;
    const __pcCount = session.promptChanges?.length || 0;
    const __pcDiffSizes = (session.promptChanges || []).map((pc: any) => (pc.diff || '').length + '+' + (pc.uncommittedDiff || '').length).join(',');
    const __sysPromptLen = (session.agentSystemPrompt || '').length;
    console.log(`[session/get] ${__tag} db ${__tDb}ms transcript=${__transcriptLen} sessionDiff=${__sessionDiffLen} sysPrompt=${__sysPromptLen} pcCount=${__pcCount} pcDiffs=[${__pcDiffSizes}]`);

    // Find linked pull requests
    let pullRequests: any[] = [];
    if (session.commit?.sha && session.commit?.repoId) {
      // Cap at 2000 PRs per repo. We can't narrow in SQL because
      // commitShas is a JSON string column, not a relation, so we fetch
      // and filter in memory. 2000 is well above typical per-repo PR
      // counts; beyond that we should migrate commitShas to a proper
      // join table.
      const allPRs = await prisma.pullRequest.findMany({
        where: { repoId: session.commit.repoId },
        take: 2000,
        orderBy: { createdAt: 'desc' },
      });
      pullRequests = allPRs.filter((pr) => {
        try {
          const shas: string[] = JSON.parse(pr.commitShas);
          return shas.includes(session.commit!.sha);
        } catch {
          return false;
        }
      });
    }

    const mapped: any = mapSession(session, pullRequests);

    // Fetch chain siblings if this session is part of a chain
    const chainId = session.parentSessionId || session.id;
    const chainSessions = await prisma.codingSession.findMany({
      where: {
        OR: [{ id: chainId }, { parentSessionId: chainId }],
        mergedInto: null,
      },
      select: { id: true, startedAt: true, endedAt: true, costUsd: true, tokensUsed: true, durationMs: true, status: true, model: true },
      orderBy: { startedAt: 'asc' },
      take: 500,
    });
    if (chainSessions.length > 1) {
      mapped.chainSessions = chainSessions;
    }

    // Mid-session model switches: surface every distinct model the session
    // saw across its prompt changes. Falls back to [session.model] when no
    // PromptChange.model values are present (older clients / single-model
    // sessions). Order: first-seen-first.
    const seen = new Set<string>();
    const modelsUsed: string[] = [];
    for (const pc of session.promptChanges ?? []) {
      const m = (pc as { model?: string | null }).model || null;
      if (m && !seen.has(m)) { seen.add(m); modelsUsed.push(m); }
    }
    if (modelsUsed.length === 0 && session.model) modelsUsed.push(session.model);
    mapped.modelsUsed = modelsUsed;

    const __tTotal = Date.now() - __t0;
    const __responseTranscriptLen = (mapped.transcript || '').length;
    console.log(`[session/get] ${__tag} done ${__tTotal}ms responseTranscript=${__responseTranscriptLen}`);
    res.json(mapped);
  } catch (err) {
    console.error('Get session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/diff — get session diff (lazy-loadable for large diffs)
router.get('/:id/diff', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const session = await prisma.codingSession.findFirst({
      where: scopedSessionWhere(req, {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
      }),
      include: { sessionDiff: true },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session.sessionDiff) {
      return res.json({ diff: null });
    }

    res.json({
      headBefore: session.sessionDiff.headBefore,
      headAfter: session.sessionDiff.headAfter,
      commitShas: safeParseArray<string>(session.sessionDiff.commitShas, `sessions.diff ${session.id}`),
      diff: session.sessionDiff.diff,
      diffTruncated: session.sessionDiff.diffTruncated,
      linesAdded: session.sessionDiff.linesAdded,
      linesRemoved: session.sessionDiff.linesRemoved,
    });
  } catch (err) {
    console.error('Get session diff error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/review — create or update review
router.post('/:id/review', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { status, note } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Missing required field: status' });
    }
    if (typeof status !== 'string' || status.length > 50) {
      return res.status(400).json({ error: 'Field status must be a string ≤ 50 chars' });
    }
    if (note != null && (typeof note !== 'string' || note.length > 10_000)) {
      return res.status(400).json({ error: 'Field note must be a string ≤ 10000 chars' });
    }

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const review = await prisma.sessionReview.upsert({
      where: { sessionId: id },
      create: {
        sessionId: id,
        userId: req.user!.id,
        status,
        note: note || null,
      },
      update: {
        userId: req.user!.id,
        status,
        note: note || null,
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'SESSION_REVIEWED',
        resource: id,
        metadata: JSON.stringify({ sessionId: id, status }),
      },
    });

    // Notify based on review status
    if (status === 'FLAGGED') {
      await notifyOrgAdmins(
        req.activeOrgId!,
        'SESSION_FLAGGED',
        'Session Flagged',
        `A coding session has been flagged for review`,
        `/sessions/${id}`,
        { sessionId: id, status }
      );
    } else {
      await notifyOrgAdmins(
        req.activeOrgId!,
        'REVIEW_COMPLETED',
        'Review Completed',
        `A coding session has been ${status.toLowerCase()}`,
        `/sessions/${id}`,
        { sessionId: id, status }
      );
    }

    // ── Update GitHub PR status check if integration is configured ──
    let githubUpdated = false;
    let prsUpdated = 0;
    try {
      const integration = await getIntegrationConfig(req.activeOrgId!);
      if (integration?.parsedSettings.checkOnReview && session.commitId) {
        const commit = await prisma.commit.findUnique({
          where: { id: session.commitId },
          include: { repo: true },
        });

        if (commit?.sha && commit.repo) {
          // Find PRs that include this commit. Cap at 2000 per repo
          // (see identical comment above).
          const allPRs = await prisma.pullRequest.findMany({
            where: { repoId: commit.repoId },
            take: 2000,
            orderBy: { createdAt: 'desc' },
          });

          const linkedPRs = allPRs.filter((pr) => {
            try {
              const shas: string[] = JSON.parse(pr.commitShas);
              return shas.includes(commit.sha);
            } catch {
              return false;
            }
          });

          const parsed = parseRepoFullName(commit.repo.path);
          const originBaseUrl = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';

          for (const pr of linkedPRs) {
            let commitShas: string[];
            try {
              commitShas = JSON.parse(pr.commitShas);
            } catch {
              commitShas = [];
            }

            const sessions = await getSessionsForPR(commit.repoId, commitShas);
            const { state, description } = computeCheckStatus(sessions);

            // Update status check
            if (parsed) {
              await postCommitStatus(
                integration.token,
                parsed.owner,
                parsed.repo,
                commit.sha,
                state,
                description,
                `${originBaseUrl}/sessions`,
                integration.apiBaseUrl,
              );
            }

            // Update or create PR comment
            if (integration.parsedSettings.postComments && parsed) {
              const org = await prisma.org.findUnique({ where: { id: req.activeOrgId! }, select: { slug: true } });
              const commentBody = buildSessionSummaryComment(sessions, originBaseUrl, org?.slug);
              if (pr.commentId) {
                await updatePRComment(
                  integration.token,
                  parsed.owner,
                  parsed.repo,
                  pr.commentId,
                  commentBody,
                  integration.apiBaseUrl,
                );
              } else {
                const result = await postPRComment(
                  integration.token,
                  parsed.owner,
                  parsed.repo,
                  pr.number,
                  commentBody,
                  integration.apiBaseUrl,
                );
                if (result.commentId) {
                  await prisma.pullRequest.update({
                    where: { id: pr.id },
                    data: { commentId: result.commentId },
                  });
                }
              }
            }

            // Update check status on PR record
            await prisma.pullRequest.update({
              where: { id: pr.id },
              data: { checkStatus: state },
            });

            prsUpdated++;
          }

          if (prsUpdated > 0) githubUpdated = true;
        }
      }
    } catch (err) {
      console.error('Failed to update GitHub PR status on review:', err);
      // Don't fail the review if GitHub update fails
    }

    emitSessionEvent({
      type: 'session:reviewed',
      sessionId: id,
      orgId: req.activeOrgId!,
      data: { status },
      timestamp: new Date().toISOString(),
    });

    res.json({ ...review, githubUpdated, prsUpdated });
  } catch (err) {
    console.error('Review session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/ai-review — trigger AI review on an existing session
// AI review hits the org's LLM key with the full session transcript —
// the most expensive single op in the API. Gate behind the strict
// limiter (10/min/user) so a compromised user token can't burn the
// entire budget in a tight loop.
router.post('/:id/ai-review', expensiveLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
      },
      include: {
        commit: { include: { repo: true } },
        agent: true,
        sessionDiff: true,
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Delete existing AI review if present (allow re-run)
    const existing = await prisma.sessionReview.findUnique({
      where: { sessionId: id },
    });
    if (existing?.isAutoReview) {
      await prisma.sessionReview.delete({ where: { sessionId: id } });
    }

    let filesChanged: string[] = [];
    try { filesChanged = JSON.parse(session.filesChanged); } catch (err) {
      console.warn(`[sessions] malformed filesChanged JSON for review session ${id}:`, (err as Error).message);
    }

    const result = await runAIReview({
      sessionId: id,
      orgId: req.activeOrgId!,
      model: session.model,
      prompt: session.prompt || '',
      filesChanged,
      tokensUsed: session.tokensUsed,
      toolCalls: session.toolCalls,
      linesAdded: session.linesAdded,
      linesRemoved: session.linesRemoved,
      costUsd: session.costUsd,
      durationMs: session.durationMs,
      transcript: session.transcript || undefined,
      diff: session.sessionDiff?.diff || undefined,
    });

    if (!result) {
      return res.status(500).json({ error: 'AI review failed — configure LLM key in Settings > Integrations' });
    }

    // Fetch the updated review
    const review = await prisma.sessionReview.findUnique({
      where: { sessionId: id },
      include: { user: true },
    });

    res.json({
      score: result.score,
      status: result.status,
      riskLevel: result.riskLevel,
      categories: result.categories,
      concerns: result.concerns,
      suggestions: result.suggestions,
      review: review ? {
        id: review.id,
        status: review.status,
        note: review.note,
        score: review.score,
        riskLevel: review.riskLevel,
        concerns: safeParseArray(review.concerns, `sessions.ai-review ${id}.concerns`),
        suggestions: safeParseArray(review.suggestions, `sessions.ai-review ${id}.suggestions`),
        categories: review.categories ? safeParseObject(review.categories, `sessions.ai-review ${id}.categories`, null as any) : null,
        isAutoReview: review.isAutoReview,
        reviewerName: review.user?.name || null,
        createdAt: review.createdAt,
      } : null,
    });
  } catch (err) {
    console.error('AI review trigger error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/end — mark a running session as completed (admin or session owner)
router.post('/:id/end', async (req: AuthRequest, res: Response) => {
  try {
    const idParam = req.params.id as string;

    // Support both full UUID and short prefix (e.g. "4f39c580")
    // Sessions may not have a linked commit yet, so also match by org via repo or user
    const idFilter = idParam.length < 36 ? { startsWith: idParam } : idParam;
    const session = await prisma.codingSession.findFirst({
      where: {
        id: idFilter,
        OR: [
          { commit: { repo: { orgId: req.activeOrgId! } } },
          { userId: req.user!.id },
        ],
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Only admin/owner or the session owner can end a session
    if (!isAdminUser(req) && session.userId !== req.user!.id) {
      return res.status(403).json({ error: 'Only admins or the session owner can end a session' });
    }

    if (session.status !== 'RUNNING') {
      // Already ended — return success (idempotent)
      return res.json({ ok: true, message: 'Session already ended' });
    }

    const now = new Date();
    const durationMs = session.startedAt
      ? now.getTime() - new Date(session.startedAt).getTime()
      : session.durationMs;

    // Wrap the status flip + audit log in a single transaction so a crash or
    // connection drop can't leave a RUNNING session with an orphan audit row
    // (or vice versa). Both writes succeed or neither does.
    await prisma.$transaction([
      prisma.codingSession.update({
        where: { id: session.id },
        data: {
          status: 'COMPLETED',
          endedAt: now,
          durationMs,
        },
      }),
      prisma.auditLog.create({
        data: {
          orgId: req.activeOrgId!,
          userId: req.user!.id,
          action: 'SESSION_ENDED',
          resource: session.id,
          metadata: JSON.stringify({ sessionId: session.id }),
        },
      }),
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('End session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/branch — queue a branch-creation command for the CLI heartbeat to pick up
router.post('/:id/branch', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.activeOrgId!;
    const { commitSha, branchName, checkout } = req.body;

    if (!commitSha) return res.status(400).json({ error: 'commitSha required' });

    const session = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { id: true },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const command = JSON.stringify({
      type: 'branch',
      commitSha,
      branchName: branchName || null,
      checkout: !!checkout,
      requestedAt: new Date().toISOString(),
      requestedBy: (req.user as any).email || req.user!.id,
    });

    await prisma.codingSession.update({
      where: { id },
      data: { pendingCommand: command, lastCommandResult: null },
    });

    res.json({ success: true, message: 'Branch queued. CLI will create it on next heartbeat.' });
  } catch (err) {
    console.error('Branch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/restore — queue a restore command for the CLI heartbeat to pick up
router.post('/:id/restore', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.activeOrgId!;
    const { treeSha, commitSha, promptIndex } = req.body;

    if (!treeSha && !commitSha) {
      return res.status(400).json({ error: 'treeSha or commitSha required' });
    }

    // Verify session belongs to org
    const session = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { id: true, status: true },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Queue the restore command — CLI heartbeat will pick it up
    const command = JSON.stringify({
      type: 'restore',
      treeSha: treeSha || null,
      commitSha: commitSha || null,
      promptIndex: promptIndex ?? null,
      requestedAt: new Date().toISOString(),
      requestedBy: (req.user as any).email || req.user!.id,
    });

    await prisma.codingSession.update({
      where: { id },
      data: { pendingCommand: command, lastCommandResult: null },
    });

    res.json({ success: true, message: 'Restore queued. CLI will pick it up on next heartbeat.' });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/restore-status — lightweight status check for pending restore
router.get('/:id/restore-status', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.activeOrgId!;

    const session = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { pendingCommand: true, lastCommandResult: true, status: true },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let result: any = null;
    if (session.lastCommandResult) {
      try { result = JSON.parse(session.lastCommandResult); } catch { /* ignore */ }
    }

    res.json({
      sessionStatus: session.status,
      pending: !!session.pendingCommand,
      result,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete a session and its related data (ADMIN+)
// PATCH /:id/archive — archive or unarchive a session
router.patch('/:id/archive', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { archived } = req.body;

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await prisma.codingSession.update({
      where: { id },
      data: { archived: archived !== false },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: archived !== false ? 'SESSION_ARCHIVED' : 'SESSION_UNARCHIVED',
        resource: id,
        metadata: JSON.stringify({ sessionId: id }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Archive session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Cascade delete in a single transaction so a partial failure can't
    // leave orphan child rows (sessionDiff, promptChange, etc.) referencing
    // a non-existent session.
    await prisma.$transaction([
      prisma.issueSession.deleteMany({ where: { sessionId: id } }),
      prisma.sessionDiff.deleteMany({ where: { sessionId: id } }),
      prisma.promptChange.deleteMany({ where: { sessionId: id } }),
      prisma.secretFinding.deleteMany({ where: { sessionId: id } }),
      prisma.sessionReview.deleteMany({ where: { sessionId: id } }),
      prisma.codingSession.delete({ where: { id } }),
      prisma.commit.delete({ where: { id: session.commitId } }),
    ]);

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'SESSION_DELETED',
        resource: id,
        metadata: JSON.stringify({ sessionId: id }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/blame — Line-level AI attribution for a file in a session
// ---------------------------------------------------------------------------

// ORIGIN_AUTO_MANAGED_FILES + stripAutoManagedSections + isDiffEntirelyOriginManaged
// now live in utils/auto-managed-files.ts (imported at the top of this file)
// so the commit-detail endpoint and any other route can apply the identical
// strip without duplicating the regex. See memory feedback_strip_auto_managed.md
// for the user-facing requirement.

interface BlameAttribution {
  promptIndex: number;
  promptText: string;
  type: 'added' | 'modified';
  // Source session of the PRIMARY attribution. Equal to the viewed session
  // when this session added the line; otherwise it's the prior session that
  // first wrote this line content.
  sessionId: string;
  isCurrentSession: boolean;
  sessionAiTitle?: string;
  sessionModel?: string;
  agentName?: string;
  // The human who ran the session — surfaced in the UI as the line's author
  // so reviewers can see who drove the change, not just which agent emitted
  // it. May be undefined for legacy sessions without a user link.
  authorName?: string;
  authorEmail?: string;
  // Secondary annotation: if a prior session FIRST wrote this line content
  // (and the current session subsequently added or modified an identical
  // line), `originalAuthor` carries the prior agent's attribution. UI shows
  // this as "originally added by <agent> in <session>".
  originalAuthor?: Omit<BlameAttribution, 'originalAuthor'>;
}

interface BlameLine {
  lineNumber: number;
  content: string;
  attribution: BlameAttribution | null;
  isGap?: boolean;
  // True when the line was added by a prompt whose pc.uncommittedDiff still
  // covers this file at session-read time — i.e. the change hasn't landed
  // in a commit yet. The UI uses this to mark uncommitted edits visually
  // alongside the attribution chip.
  isUncommitted?: boolean;
}

interface BlamePrompt {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
}

interface CrossSessionPrompt {
  sessionId: string;
  sessionAiTitle?: string;
  sessionModel?: string;
  agentName?: string;
  authorName?: string;
  authorEmail?: string;
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  createdAt: string;
}

/**
 * Parse a unified diff string and extract per-file hunks.
 * Returns line additions/modifications for the target file.
 */
function parseDiffForFile(
  diffText: string,
  targetFile: string,
): Array<{
  lineNumber: number;
  content: string;
  type: 'added' | 'modified';
  // When this `+` line directly follows a `-` block, the `-` block's
  // i-th line is paired with this `+` block's i-th line as a modification.
  // `precedingDeletedContent` is the content of the line this one replaces
  // (if any) — lets the blame algorithm inherit attribution when a later
  // prompt modifies a line a previous prompt added.
  precedingDeletedContent?: string;
}> {
  if (!diffText) return [];

  const results: Array<{
    lineNumber: number;
    content: string;
    type: 'added' | 'modified';
    precedingDeletedContent?: string;
  }> = [];

  // Split by file sections (diff --git or --- a/)
  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const filePath = headerMatch ? headerMatch[2] : '';

    // Check if this section is for our target file. Match boundaries are
    // critical: a naked `endsWith("utils.py")` test wrongly matches
    // `test_utils.py` and the blame for utils.py would merge in test_utils.py's
    // diff. Require either exact equality or a `/<target>` (or `<file>/`)
    // suffix so the match lands on a path-component boundary.
    const normalizedTarget = targetFile.replace(/^\//, '');
    const normalizedFile = filePath.replace(/^\//, '');
    if (
      normalizedFile !== normalizedTarget &&
      !normalizedFile.endsWith('/' + normalizedTarget) &&
      !normalizedTarget.endsWith('/' + normalizedFile)
    ) {
      continue;
    }

    // Parse hunks. Track a "pending deletes" buffer so we can pair
    // consecutive `-` lines with the following `+` lines (a modification
    // block in unified-diff format). The i-th deleted line is paired with
    // the i-th added line; surplus deletes are pure removals (no pairing),
    // surplus adds are pure additions (no `precedingDeletedContent`).
    let newLineNum = 0;
    let pendingDeletes: string[] = [];
    let pendingAddIdx = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('@@')) {
        pendingDeletes = [];
        pendingAddIdx = 0;
        const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          newLineNum = parseInt(hunkMatch[1], 10);
        }
        continue;
      }

      if (line.startsWith('+++') || line.startsWith('---')) continue;

      if (line.startsWith('+')) {
        const precedingDeletedContent =
          pendingAddIdx < pendingDeletes.length ? pendingDeletes[pendingAddIdx] : undefined;
        results.push({
          lineNumber: newLineNum,
          content: line.slice(1),
          type: precedingDeletedContent != null ? 'modified' : 'added',
          ...(precedingDeletedContent != null ? { precedingDeletedContent } : {}),
        });
        newLineNum++;
        pendingAddIdx++;
      } else if (line.startsWith('-')) {
        // Stash for pairing with a following `+`. Reset the add-cursor only
        // when we transition from add→delete, not on every `-`.
        if (pendingAddIdx > 0) {
          pendingDeletes = [];
          pendingAddIdx = 0;
        }
        pendingDeletes.push(line.slice(1));
      } else {
        // Context line — closes any open delete-block.
        pendingDeletes = [];
        pendingAddIdx = 0;
        newLineNum++;
      }
    }
  }

  return results;
}

/**
 * Parse a unified diff and extract ALL lines (context + additions + gap markers)
 * for a target file. Returns the file view as seen in the "new" version.
 * Context lines = human-written / unchanged. Added lines = AI-written.
 */
function parseFullDiffForFile(
  diffText: string,
  targetFile: string,
): Array<{ lineNumber: number; content: string; type: 'context' | 'added'; isGap?: boolean }> {
  if (!diffText) return [];

  const results: Array<{ lineNumber: number; content: string; type: 'context' | 'added'; isGap?: boolean }> = [];
  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);
  let lastLineNum = 0;

  for (const section of fileSections) {
    const lines = section.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const filePath = headerMatch ? headerMatch[2] : '';

    const normalizedTarget = targetFile.replace(/^\//, '');
    const normalizedFile = filePath.replace(/^\//, '');
    // Path-component-boundary match: `utils.py` must not match
    // `test_utils.py`. See parseDiffForFile above for the same fix.
    if (
      normalizedFile !== normalizedTarget &&
      !normalizedFile.endsWith('/' + normalizedTarget) &&
      !normalizedTarget.endsWith('/' + normalizedFile)
    ) continue;

    let newLineNum = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Skip meta lines
      if (line.startsWith('\\ ')) continue;
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') ||
          line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity') ||
          line.startsWith('rename ') || line.startsWith('Binary ')) continue;

      if (line.startsWith('@@')) {
        const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          const nextLineNum = parseInt(hunkMatch[1], 10);
          // Insert gap marker if there are hidden lines between hunks
          if (lastLineNum > 0 && nextLineNum > lastLineNum + 1) {
            results.push({
              lineNumber: -1,
              content: `${nextLineNum - lastLineNum - 1} lines hidden`,
              type: 'context',
              isGap: true,
            });
          } else if (lastLineNum === 0 && nextLineNum > 1) {
            results.push({
              lineNumber: -1,
              content: `${nextLineNum - 1} lines hidden`,
              type: 'context',
              isGap: true,
            });
          }
          newLineNum = nextLineNum;
        }
        continue;
      }

      if (line.startsWith('+')) {
        results.push({ lineNumber: newLineNum, content: line.slice(1), type: 'added' });
        lastLineNum = newLineNum;
        newLineNum++;
      } else if (line.startsWith('-')) {
        // Removed lines are not in the new file — skip
      } else {
        // Context line (starts with ' ' or is empty)
        results.push({
          lineNumber: newLineNum,
          content: line.startsWith(' ') ? line.slice(1) : line,
          type: 'context',
        });
        lastLineNum = newLineNum;
        newLineNum++;
      }
    }
  }

  return results;
}

// ─── Authoritative editsJson → line attribution ─────────────────────────
//
// New per-prompt pipeline (see packages/cli/src/prompt-capture) populates
// `PromptChange.editsJson` with an authoritative list of file operations
// the agent performed. Each PromptEdit carries the file path and the
// before/after content of the affected region. When present, blame
// derives attribution by running a line-level LCS over (oldContent,
// newContent) per edit instead of parsing the legacy `pc.diff` text —
// which conflated cross-prompt cumulative captures and inflated the
// "added by this prompt" set with content owned by other prompts.

interface PromptEditFromJson {
  file: string;
  op?: string;
  oldContent?: string;
  newContent?: string;
  oldPath?: string;
  source?: string;
  commitSha?: string;
}
interface PromptCaptureFromJson {
  promptIndex: number;
  promptText: string;
  agent: string;
  edits: PromptEditFromJson[];
  commits: string[];
}

// Hirschberg-friendly line LCS. Returns indices in the new array that
// are NEW (i.e. not in the LCS) — those are the lines added by this
// edit relative to its prior state. n*m table is fine here because
// per-edit content rarely exceeds a few thousand lines.
function addedLineIndicesViaLcs(oldLines: string[], newLines: string[]): number[] {
  const n = oldLines.length, m = newLines.length;
  if (n === 0) return Array.from({ length: m }, (_, i) => i);
  if (m === 0) return [];
  // Cap to avoid pathological allocations on huge files; full-file LCS at
  // 50k * 50k would blow heap. Beyond cap, treat the entire new content
  // as added.
  if (n * m > 4_000_000) return Array.from({ length: m }, (_, i) => i);

  const prev = new Int32Array(m + 1);
  const curr = new Int32Array(m + 1);
  // Track parent direction in a compact byte matrix.
  // 0 = match (came from i-1,j-1), 1 = up (i-1,j), 2 = left (i,j-1)
  const parent = new Uint8Array((n + 1) * (m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        parent[i * (m + 1) + j] = 0;
      } else if (prev[j] >= curr[j - 1]) {
        curr[j] = prev[j];
        parent[i * (m + 1) + j] = 1;
      } else {
        curr[j] = curr[j - 1];
        parent[i * (m + 1) + j] = 2;
      }
    }
    prev.set(curr);
  }
  const added: number[] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const p = parent[i * (m + 1) + j];
    if (p === 0) { i--; j--; }
    else if (p === 1) { i--; }
    else { added.push(j - 1); j--; }
  }
  while (j > 0) { added.push(j - 1); j--; }
  added.reverse();
  return added;
}

// True when an edit's recorded file path is the target file we're
// blaming (matches under either full path or trailing-path equivalence).
function editMatchesFile(editFile: string, targetFile: string): boolean {
  if (!editFile || !targetFile) return false;
  const a = editFile.replace(/^\//, '');
  const b = targetFile.replace(/^\//, '');
  // Match on full equality or path-component boundary. A naked
  // `endsWith(b)` matches `test_utils.py` against target `utils.py`,
  // collapsing two distinct files into one view.
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

// Parse the encrypted/plain editsJson string and return null on any
// parsing failure so the caller can fall back to the legacy path.
function parseEditsJson(raw: string | null | undefined): PromptCaptureFromJson | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.edits)) return null;
    return parsed as PromptCaptureFromJson;
  } catch { return null; }
}

// Compute per-prompt added lines for a single target file from the
// authoritative editsJson. Returns one entry per added line in the
// SAME shape parseDiffForFile produces, so the caller can drop this
// into the existing attribution loop with no further changes.
function lineChangesFromEdits(
  cap: PromptCaptureFromJson,
  targetFile: string,
): Array<{ lineNumber: number; content: string; type: 'added' | 'modified'; precedingDeletedContent?: string }> {
  const out: Array<{ lineNumber: number; content: string; type: 'added' | 'modified'; precedingDeletedContent?: string }> = [];
  // Synthetic line counter — sessionDiff-driven rendering keys off line
  // CONTENT for attribution; the line number only matters for the
  // no-sessionDiff fallback, where we want monotonically increasing
  // numbers per prompt.
  let cursor = 1;
  for (const edit of cap.edits) {
    if (!editMatchesFile(edit.file || '', targetFile)) continue;
    const oldText = edit.oldContent ?? '';
    const newText = edit.newContent ?? '';
    if (!newText && edit.op === 'delete') continue; // pure deletion
    const oldLines = oldText.length === 0 ? [] : oldText.split('\n');
    const newLines = newText.length === 0 ? [] : newText.split('\n');
    const addedIdxs = addedLineIndicesViaLcs(oldLines, newLines);
    // For a 'write' / 'create' op with empty oldContent we treat every
    // new line as added; addedLineIndicesViaLcs already returns that.
    for (const idx of addedIdxs) {
      const content = newLines[idx];
      // Pair each added line with its preceding deleted line (when the
      // edit replaces a contiguous region) so the within-session
      // modification-inheritance rule in the legacy loop still fires.
      // We look at the old line at the same relative position — close
      // enough for the inheritance heuristic, which only needs to find
      // SOME prior-prompt content the modifying prompt is replacing.
      const replaced = oldLines[idx];
      out.push({
        lineNumber: cursor++,
        content,
        type: replaced && replaced !== content ? 'modified' : 'added',
        ...(replaced && replaced !== content ? { precedingDeletedContent: replaced } : {}),
      });
    }
  }
  return out;
}

router.get('/:id/blame', async (req: AuthRequest, res: Response) => {
  const dbgT0 = Date.now();
  const id = req.params.id as string;
  const file = req.query.file as string;
  console.log('[blame] enter', JSON.stringify({ id: id.slice(0, 8), file }));
  try {
    if (!file) {
      return res.status(400).json({ error: 'file query parameter is required' });
    }

    const session = await prisma.codingSession.findFirst({
      where: scopedSessionWhere(req, {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
      }),
      include: {
        commit: { select: { repoId: true } },
        promptChanges: { orderBy: { promptIndex: 'asc' } },
        sessionDiff: true,
        agent: { select: { name: true, slug: true } },
        user: { select: { id: true, name: true, email: true } },
        // Every commit this session authored. `filesChanged` builds the
        // knownFiles strip set (historical pollution cleanup). `sha` +
        // `patch` are the per-commit unified diff — used as a fallback
        // when pc.diff is empty for a prompt but pc.commitSha is set
        // (Claude/Cursor sessions where the per-prompt diff capture
        // missed the file but the post-commit hook landed the patch).
        commits: { select: { sha: true, filesChanged: true, patch: true } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Build the session's "known touched files" set from commit metadata +
    // session.filesChanged + every per-prompt diff/uncommittedDiff. If
    // non-empty, we'll drop pc.diff file sections whose path falls outside
    // this set (historical pollution cleanup). Pulling per-prompt diff
    // file headers in too is essential — without it, the set is just
    // committed files, which silently strips uncommitted edits (e.g.
    // main.py + notes-from-codex.txt edits that Codex hasn't committed
    // yet) from the "By Prompt" file list.
    const knownFiles = new Set<string>();
    for (const c of ((session as any).commits || []) as Array<{ filesChanged: string | null }>) {
      try {
        const arr = JSON.parse(c.filesChanged || '[]');
        if (Array.isArray(arr)) for (const f of arr) if (typeof f === 'string') knownFiles.add(f);
      } catch { /* ignore */ }
    }
    try {
      const sessFiles = JSON.parse(session.filesChanged || '[]');
      if (Array.isArray(sessFiles)) for (const f of sessFiles) if (typeof f === 'string') knownFiles.add(f);
    } catch { /* ignore */ }
    for (const pc of (session.promptChanges || []) as Array<{ diff: string | null; uncommittedDiff: string | null }>) {
      for (const blob of [pc.diff, pc.uncommittedDiff]) {
        if (!blob) continue;
        for (const m of blob.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
          const fp = m[2].replace(/^\//, '');
          if (fp) knownFiles.add(fp);
        }
      }
    }
    const stripUnknownFileSections = (diffText: string): string => {
      if (!diffText || knownFiles.size === 0) return diffText;
      const parts = diffText.split(/^(?=diff --git )/m);
      const kept: string[] = [];
      for (const part of parts) {
        const header = part.split('\n', 1)[0] || '';
        const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
        const filePath = m ? m[2] : '';
        const basename = filePath.split('/').pop() || '';
        // Keep if either the full path or the basename matches a known file.
        if (filePath && (knownFiles.has(filePath) || knownFiles.has(basename))) {
          kept.push(part);
        } else if (!filePath) {
          // Couldn't parse header — keep to be safe.
          kept.push(part);
        }
        // else: file not in knownFiles → drop (pollution).
      }
      return kept.join('').trim();
    };

    // Cross-session attribution: pull every PromptChange in this repo that
    // touched the target file, replay chronologically, earliest-prompt-wins.
    // Without this, a later agent (Gemini) that rewrites lines an earlier
    // agent (Codex) added would silently strip Codex's attribution from the
    // file. The user's "inter-agent memory" requirement is satisfied by
    // letting the attribution queue extend back across session boundaries.
    const repoId = (session as { commit?: { repoId: string } }).commit?.repoId;
    const orgId = req.activeOrgId!;
    const adminUser = isAdminUser(req);
    const userClause = adminUser ? {} : { userId: req.user!.id };
    // filesChanged is a JSON string array; `contains` on the basename
    // catches both absolute and relative path encodings.
    const fileBasename = (file || '').split('/').pop() || file;
    const allRepoChanges = repoId
      ? await prisma.promptChange.findMany({
          where: {
            session: {
              ...userClause,
              commit: {
                repoId,
                repo: { orgId },
              },
            },
            filesChanged: { contains: fileBasename },
          },
          include: {
            session: {
              select: {
                id: true,
                model: true,
                aiTitle: true,
                createdAt: true,
                agent: { select: { name: true, slug: true } },
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        })
      : [];

    // Sort: session.createdAt asc, then promptIndex asc. Earliest prompt across
    // the repo wins the line content it first established.
    allRepoChanges.sort((a, b) => {
      const at = (a as any).session.createdAt.getTime();
      const bt = (b as any).session.createdAt.getTime();
      if (at !== bt) return at - bt;
      return a.promptIndex - b.promptIndex;
    });

    // Two attribution layers:
    //   - PRIMARY (`contentAttributions`, `lineAttributions`): built ONLY from
    //     this session's prompts. Drives the legend, the "Prompt #N" badge,
    //     and the in-session blame. Keeps each session's view scoped to its
    //     own work — a Gemini session never claims a Codex prompt added one
    //     of its lines.
    //   - ORIGINAL AUTHOR (`priorContentAttributions`): built from prompts in
    //     OTHER sessions on the same repo+file. Surfaces as a secondary
    //     "originally added by …" annotation so the viewer can see who first
    //     wrote a context line, without polluting the primary attribution.
    type AttrEntry = {
      sessionId: string;
      isCurrentSession: boolean;
      sessionAiTitle?: string;
      sessionModel?: string;
      agentName?: string;
      authorName?: string;
      authorEmail?: string;
      promptIndex: number;
      promptText: string;
      type: 'added' | 'modified';
    };
    const lineAttributions = new Map<number, AttrEntry & { content: string }>();
    const contentAttributions = new Map<string, AttrEntry[]>();
    const priorContentAttributions = new Map<string, AttrEntry[]>();

    const promptsInfo: BlamePrompt[] = [];
    const crossSessionPrompts: CrossSessionPrompt[] = [];

    // Primary pass = this session's prompts only. Dedup by promptIndex.
    // Drop PromptChange rows that are entirely empty — empty diff, empty
    // uncommittedDiff, empty filesChanged. Those are phantom mappings that
    // Cursor's flaky transcript pickup can persist (a leftover promptText
    // from a prior chat with no actual code work attached). Without this
    // filter, the legend shows "Prompt #2 — make some small change..." for
    // a turn the agent never actually ran in this session.
    const sessionSeenIdx = new Set<number>();
    const sessionDedupedChanges = (session.promptChanges as any[])
      .filter((pc: any) => {
        const hasDiff = !!(pc.diff && pc.diff.trim());
        const hasUncommitted = !!(pc.uncommittedDiff && pc.uncommittedDiff.trim());
        let hasFiles = false;
        try {
          hasFiles = Array.isArray(JSON.parse(pc.filesChanged || '[]')) &&
            JSON.parse(pc.filesChanged || '[]').length > 0;
        } catch { /* ignore */ }
        return hasDiff || hasUncommitted || hasFiles;
      })
      .map((pc) => ({
        ...pc,
        sessionId: session.id,
        session: {
          id: session.id,
          model: session.model,
          aiTitle: (session as any).aiTitle,
          createdAt: session.createdAt,
          agent: (session as any).agent,
        },
      }))
      .filter((pc: any) => {
        if (sessionSeenIdx.has(pc.promptIndex)) return false;
        sessionSeenIdx.add(pc.promptIndex);
        return true;
      });

    // Prior pass = only sessions that STARTED before this one. A session
    // that started AFTER the current one can't be the "original author" of
    // anything in the current session — it ran later. Without this filter,
    // viewing Codex's earlier session would surface Gemini (which ran after)
    // as the original author of Codex's own lines, because Gemini's cumulative
    // capture re-added Codex's content as `+` lines.
    const currentSessionStart = (session as { createdAt: Date }).createdAt.getTime();
    const priorSeenKey = new Set<string>();
    const priorChanges = allRepoChanges
      .filter((pc: any) => pc.sessionId !== session.id)
      .filter((pc: any) => {
        const otherStart = (pc.session.createdAt as Date).getTime();
        return otherStart < currentSessionStart;
      })
      .filter((pc: any) => {
        const k = `${pc.sessionId}:${pc.promptIndex}`;
        if (priorSeenKey.has(k)) return false;
        priorSeenKey.add(k);
        return true;
      });

    // Iteration uses this session's prompts for PRIMARY accounting; the prior
    // list is processed separately further below.
    const dedupedChanges = sessionDedupedChanges;

    // Telemetry for the "0% AI" diagnosis: track per-prompt diff state so we
    // can tell from logs whether prompts are coming through with empty diffs,
    // whether parseDiffForFile is matching the target path, and what file
    // headers appear in the diff text. Aggregated and logged once below.
    const blameDebug = {
      totalPrompts: dedupedChanges.length,
      promptsWithDiff: 0,
      promptsWithMatchedLines: 0,
      diffFileHeaderSamples: new Set<string>(),
      // Per-prompt match counts so we can see which prompts contributed
      // attribution and which had a diff but matched zero lines (i.e. the
      // file appeared in the diff under a different path, or the prompt
      // only touched other files).
      perPromptMatches: [] as Array<{
        promptIndex: number;
        diffLen: number;
        fileHeadersInDiff: string[];
        matchedLines: number;
        sampleAddedContent: string[];
        diffSnippetForTarget: string;
      }>,
    };

    // ----- PRIMARY pass: only THIS session's prompts -----
    for (const pc of dedupedChanges) {
      const rawFiles: string[] = (() => {
        try {
          return JSON.parse(pc.filesChanged || '[]');
        } catch {
          return [];
        }
      })();
      // Build the per-prompt file list. Three signals, used in order:
      //   1. Files mentioned as `diff --git a/<x> b/<x>` headers in pc.diff /
      //      pc.uncommittedDiff. This IS the per-prompt git diff text — every
      //      file the prompt actually touched in this turn. Most accurate.
      //   2. `pc.filesChanged` from the CLI capture (a JSON array string).
      //      Used as a fallback when pc.diff is empty.
      //   3. The linked `Commit.filesChanged` via pc.commitSha. Last-resort
      //      fallback when pc.diff is also empty — restores cases where the
      //      pre-commit working-tree diff missed everything but the
      //      post-commit hook wrote the canonical patch.
      // The old "always prefer commit.filesChanged when a commit exists"
      // rule was wrong for Gemini, whose pc.diff contained 4 files but the
      // commit recorded only 2 (the other 2 landed in a later commit).
      const headersFromDiff: string[] = [];
      for (const blob of [pc.diff, (pc as any).uncommittedDiff]) {
        if (typeof blob !== 'string' || !blob) continue;
        for (const m of blob.matchAll(/^diff --git a\/(.+?)\s+b\/(.+)$/gm)) {
          const fp = m[2].replace(/^\//, '');
          if (!headersFromDiff.includes(fp)) headersFromDiff.push(fp);
        }
      }
      const commitForPc: any = (pc as any).commitSha
        ? ((session as any).commits || []).find(
            (cc: any) => cc.sha === (pc as any).commitSha,
          )
        : null;
      const commitFiles: string[] = commitForPc
        ? (() => {
            try {
              return JSON.parse(commitForPc.filesChanged || '[]');
            } catch { return []; }
          })()
        : [];
      const filesSource = headersFromDiff.length > 0
        ? headersFromDiff
        : (rawFiles.length > 0 ? rawFiles : commitFiles);
      const filesChanged = filesSource.filter((f) => {
        const basename = (f || '').split('/').pop() || '';
        // Drop Origin-managed files unconditionally — AGENTS.md / GEMINI.md /
        // .windsurfrules are always Origin's. CLAUDE.md is always Origin's
        // by convention here (the content-aware filter in
        // stripAutoManagedSections is for diff text; for the file LIST we
        // hide it unconditionally to match the user's "don't show
        // auto-managed files anywhere" rule).
        if (
          ORIGIN_AUTO_MANAGED_FILES.has(f) ||
          ORIGIN_AUTO_MANAGED_FILES.has(basename) ||
          basename === 'CLAUDE.md'
        ) return false;
        // Historical pollution cleanup: when we have a known-files set,
        // drop entries the session didn't actually touch. No-op when the
        // known set is empty (chat-only sessions, missing commit metadata).
        if (knownFiles.size > 0 && !knownFiles.has(f) && !knownFiles.has(basename)) return false;
        return true;
      });

      promptsInfo.push({
        promptIndex: pc.promptIndex,
        promptText: pc.promptText,
        filesChanged,
      });

      const attrMeta: Omit<AttrEntry, 'promptIndex' | 'promptText' | 'type'> = {
        sessionId: session.id,
        isCurrentSession: true,
        sessionAiTitle: (session as any).aiTitle || undefined,
        sessionModel: session.model || undefined,
        agentName: (session as any).agent?.name || undefined,
        authorName: (session as any).user?.name || undefined,
        authorEmail: (session as any).user?.email || undefined,
      };

      // ── Authoritative editsJson path ─────────────────────────────
      // When this PromptChange carries an authoritative edit list, use
      // LCS over (oldContent, newContent) to derive added/modified lines
      // for THIS prompt on THIS file. Skip pc.diff entirely for this
      // prompt — that text is the legacy cumulative blob and conflates
      // cross-prompt work. Other prompts in the same session can still
      // be on the legacy path; the queues merge cleanly.
      // pc.diff IS the ground truth for blame attribution — it's the raw
      // `git diff` text captured at the moment this prompt was recorded.
      // editsJson was an attempted improvement but its commit-walking
      // attribution misfires on Codex sessions captured before
      // 0.20260520.2250 (e.g. all timestamps land at the LAST prompt,
      // so prompt 1's lineChanges end up containing prompt 0's added
      // line). We use pc.diff exclusively here and treat editsJson only
      // as a hint about files touched (it's already consumed for that
      // in the session-detail mapper).
      //
      // Three-tier source resolution per (prompt, file):
      //   1. pc.diff — the per-prompt git diff the CLI captured at recording
      //      time. Correct for sessions where the user-prompt-submit hook
      //      fired before each turn (typical case).
      //   2. Commit.patch via pc.commitSha — the post-commit hook always
      //      writes the canonical per-commit unified diff to `Commit.patch`,
      //      even when pc.diff was empty or recorded against the wrong
      //      working-tree state (e.g. pre-existing dirty files leaked in).
      //   3. editsJson (Claude/Cursor/Gemini only) — the tool-call edit
      //      list, converted to per-file added lines via LCS. Used when
      //      neither pc.diff nor Commit.patch contains the target file.
      //
      // We pick whichever has the target file's `diff --git a/<file>`
      // header. This means each prompt can resolve to a different source
      // depending on which one has data for the file being blamed.
      const targetFileNorm = file.replace(/^\//, '');
      const sourceHasFile = (diffText: string): boolean => {
        if (!diffText) return false;
        const re = /^diff --git a\/(.+?)\s+b\/(.+)$/gm;
        for (const m of diffText.matchAll(re)) {
          const fp = m[2].replace(/^\//, '');
          if (
            fp === targetFileNorm ||
            fp.endsWith('/' + targetFileNorm) ||
            targetFileNorm.endsWith('/' + fp)
          ) return true;
        }
        return false;
      };

      let pcDiff = stripUnknownFileSections(stripAutoManagedSections(pc.diff));
      if (!sourceHasFile(pcDiff) && (pc as any).commitSha) {
        const c = ((session as any).commits || []).find(
          (cc: any) => cc.sha === (pc as any).commitSha,
        );
        if (c?.patch) {
          const patchClean = stripUnknownFileSections(stripAutoManagedSections(c.patch));
          if (sourceHasFile(patchClean)) pcDiff = patchClean;
        }
      }
      // editsJson lineChanges (Claude/Cursor/Gemini tool calls) as a
      // last-resort source. Skipped for Codex sessions captured before
      // 0.20260520.2250 where the extractor's commit-walking misattributed
      // commits to the last prompt — same misfire we saw earlier with
      // "Thirty-fifth" landing under prompt 1's edits.
      let editsBasedLineChanges: ReturnType<typeof parseDiffForFile> = [];
      const agentSlug = (session as any).agent?.slug || '';
      const trustEditsJson = agentSlug !== 'codex';
      if (!sourceHasFile(pcDiff) && trustEditsJson) {
        const editsCapture = parseEditsJson((pc as any).editsJson);
        if (editsCapture && Array.isArray(editsCapture.edits) && editsCapture.edits.length > 0) {
          editsBasedLineChanges = lineChangesFromEdits(editsCapture, file);
        }
      }

      if (!pcDiff && editsBasedLineChanges.length === 0) continue;
      blameDebug.promptsWithDiff++;

      const headersInThisDiff: string[] = [];
      for (const m of pcDiff.matchAll(/^diff --git a\/(.+?)\s+b\/(.+)$/gm)) {
        headersInThisDiff.push(m[2]);
        if (blameDebug.diffFileHeaderSamples.size < 10) blameDebug.diffFileHeaderSamples.add(m[2]);
      }

      const lineChanges = editsBasedLineChanges.length > 0
        ? editsBasedLineChanges
        : parseDiffForFile(pcDiff, file);
      if (lineChanges.length > 0) blameDebug.promptsWithMatchedLines++;

      let diffSnippetForTarget = '';
      {
        const sections = pcDiff.split(/^diff --git /m).filter(Boolean);
        for (const section of sections) {
          const head = section.split('\n')[0] || '';
          const m = head.match(/a\/(.+?)\s+b\/(.+)/);
          const filePath = m ? m[2] : '';
          const norm = (s: string) => s.replace(/^\//, '');
          const tgt = norm(file);
          const fp = norm(filePath);
          if (fp === tgt || fp.endsWith('/' + tgt) || tgt.endsWith('/' + fp)) {
            diffSnippetForTarget = section.slice(0, 300);
            break;
          }
        }
      }
      blameDebug.perPromptMatches.push({
        promptIndex: pc.promptIndex,
        diffLen: pc.diff.length,
        fileHeadersInDiff: headersInThisDiff.slice(0, 5),
        matchedLines: lineChanges.length,
        sampleAddedContent: lineChanges.slice(0, 3).map(c => c.content.slice(0, 80)),
        diffSnippetForTarget,
      });
      for (const change of lineChanges) {
        if (!lineAttributions.has(change.lineNumber)) {
          lineAttributions.set(change.lineNumber, {
            ...attrMeta,
            content: change.content,
            promptIndex: pc.promptIndex,
            promptText: pc.promptText,
            type: change.type,
          });
        }

        const queue = contentAttributions.get(change.content) || [];
        // Blame answers "who wrote THIS line." When prompt N replaces
        // prompt M's line with new text, the new text belongs to N, not
        // M. The previous "modification inheritance" copied M's entry
        // into the new content's queue — combined with the .shift()
        // earliest-wins rule below, that caused queries for prompt N's
        // visible content to surface as prompt M instead.
        // Cross-session original-author credit is handled separately
        // via priorContentAttributions and surfaces as a SECONDARY
        // `originalAuthor` annotation, not as the primary attribution.
        queue.push({
          ...attrMeta,
          promptIndex: pc.promptIndex,
          promptText: pc.promptText,
          type: change.type,
        });
        queue.sort((a, b) => a.promptIndex - b.promptIndex);
        contentAttributions.set(change.content, queue);
      }
    }

    // ----- ORIGINAL-AUTHOR pass: OTHER sessions' prompts on this file -----
    // These produce a secondary annotation only — they never appear in the
    // legend or in `prompts[]`, and they don't drive the "P#" badge for this
    // session's own lines. They surface as "originally added by <agent> in
    // <session>" for context lines (and for added lines whose content was
    // first written by an earlier agent on this file).
    for (const pc of priorChanges) {
      const rawFiles: string[] = (() => {
        try {
          return JSON.parse(pc.filesChanged || '[]');
        } catch {
          return [];
        }
      })();
      const filesChanged = rawFiles.filter((f) => {
        const basename = (f || '').split('/').pop() || '';
        if (ORIGIN_AUTO_MANAGED_FILES.has(f) || ORIGIN_AUTO_MANAGED_FILES.has(basename)) return false;
        // Historical pollution cleanup: when we have a known-files set,
        // drop entries the session didn't actually touch. No-op when the
        // known set is empty (chat-only sessions, missing commit metadata).
        if (knownFiles.size > 0 && !knownFiles.has(f) && !knownFiles.has(basename)) return false;
        return true;
      });

      const pcSessionMeta = (pc as any).session || {};
      crossSessionPrompts.push({
        sessionId: (pc as any).sessionId,
        sessionAiTitle: pcSessionMeta.aiTitle || undefined,
        sessionModel: pcSessionMeta.model || undefined,
        agentName: pcSessionMeta.agent?.name || undefined,
        authorName: pcSessionMeta.user?.name || undefined,
        authorEmail: pcSessionMeta.user?.email || undefined,
        promptIndex: pc.promptIndex,
        promptText: pc.promptText,
        filesChanged,
        createdAt: pcSessionMeta.createdAt
          ? new Date(pcSessionMeta.createdAt).toISOString()
          : new Date().toISOString(),
      });

      const priorAttrMeta: Omit<AttrEntry, 'promptIndex' | 'promptText' | 'type'> = {
        sessionId: (pc as any).sessionId,
        isCurrentSession: false,
        sessionAiTitle: pcSessionMeta.aiTitle || undefined,
        sessionModel: pcSessionMeta.model || undefined,
        agentName: pcSessionMeta.agent?.name || undefined,
        authorName: pcSessionMeta.user?.name || undefined,
        authorEmail: pcSessionMeta.user?.email || undefined,
      };

      const pcDiff = stripAutoManagedSections(pc.diff);
      if (!pcDiff) continue;
      const lineChanges = parseDiffForFile(pcDiff, file);
      for (const change of lineChanges) {
        const queue = priorContentAttributions.get(change.content) || [];
        queue.push({
          ...priorAttrMeta,
          promptIndex: pc.promptIndex,
          promptText: pc.promptText,
          type: change.type,
        });
        priorContentAttributions.set(change.content, queue);
      }
    }

    // Per-prompt "files with uncommitted edits" map. A blame line attributed
    // to prompt N is flagged uncommitted when N's stored uncommittedDiff still
    // contains the target file — Codex's heartbeat captures uncommittedDiff
    // alongside pc.diff, so this tells us at read time whether that prompt's
    // change is sitting in the working tree or already landed in a commit.
    const promptUncommittedFiles = new Map<number, Set<string>>();
    const normalizedFile = (file || '').replace(/^\//, '');
    for (const pc of sessionDedupedChanges) {
      const set = new Set<string>();
      const ud: string | null = (pc as any).uncommittedDiff || null;
      if (ud) {
        for (const m of ud.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
          const fp = m[2].replace(/^\//, '');
          set.add(fp);
        }
      }
      promptUncommittedFiles.set((pc as any).promptIndex, set);
    }
    const isPromptUncommittedForFile = (promptIdx: number): boolean => {
      const set = promptUncommittedFiles.get(promptIdx);
      if (!set || set.size === 0) return false;
      if (set.has(normalizedFile)) return true;
      for (const fp of set) {
        if (fp.endsWith(normalizedFile) || normalizedFile.endsWith(fp)) return true;
      }
      return false;
    };

    // Build the blame result
    // If sessionDiff exists, show full file context (human + AI lines + gaps)
    // Otherwise, fall back to only attributed lines
    let blameLines: BlameLine[] = [];

    const truncatePromptText = (t: string): string =>
      t.length > 200 ? t.slice(0, 200) + '...' : t;
    const toAttribution = (attr: AttrEntry): BlameAttribution => ({
      promptIndex: attr.promptIndex,
      promptText: truncatePromptText(attr.promptText),
      type: attr.type,
      sessionId: attr.sessionId,
      isCurrentSession: attr.isCurrentSession,
      sessionAiTitle: attr.sessionAiTitle,
      sessionModel: attr.sessionModel,
      agentName: attr.agentName,
      authorName: attr.authorName,
      authorEmail: attr.authorEmail,
    });

    // Block-attribution map: maps a fullView index → the prompt that
    // contributed that line's content as part of a contiguous hunk. Built
    // below from per-prompt diff hunks so prior-prompt committed additions
    // (which sessionDiff renders as plain context when its baseline is HEAD,
    // not session-start) still get attributed instead of looking like
    // un-tracked human work. Falls back to the existing per-line FIFO queue
    // for any lines a block didn't claim.
    const blockAttribution = new Map<number, AttrEntry>();

    if (session.sessionDiff?.diff) {
      const sessionDiffText = stripUnknownFileSections(stripAutoManagedSections(session.sessionDiff.diff));
      let fullView = parseFullDiffForFile(sessionDiffText, file);
      // SessionDiff is rebuilt at session end (or on commit, post-CLI update),
      // so during a running session it can miss files the agent edited but
      // hasn't committed yet — README.md is the typical case. When that
      // happens, splice the per-prompt diff/uncommittedDiff entries for this
      // file into the fullView so the user sees their actual changes instead
      // of an empty blame body.
      if (fullView.length === 0) {
        const fallbackChunks: string[] = [];
        for (const pc of sessionDedupedChanges) {
          for (const blob of [pc.diff, pc.uncommittedDiff]) {
            if (typeof blob !== 'string' || !blob) continue;
            for (const part of blob.split(/^(?=diff --git )/m)) {
              const header = part.split('\n', 1)[0] || '';
              const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
              if (!m) continue;
              const filePath = m[2].replace(/^\//, '');
              const target = file.replace(/^\//, '');
              if (
                filePath === target ||
                filePath.endsWith(target) ||
                target.endsWith(filePath)
              ) {
                fallbackChunks.push(part);
              }
            }
          }
        }
        if (fallbackChunks.length > 0) {
          fullView = parseFullDiffForFile(fallbackChunks.join(''), file);
        }
      }

      // Block-attribution pre-pass. For each pc.diff hunk's contiguous `+`
      // block (≥ 3 lines), find the matching consecutive sequence in fullView
      // and tag those positions with the prompt that added them. Sequences
      // shorter than 3 lines aren't matched here — they're left to the
      // per-line content queue below, which handles common single lines
      // (empty, brace-only) correctly. Each fullView position is claimed at
      // most once, and pc rows are scanned in promptIndex order so the
      // earliest matching prompt wins.
      {
        const normFile = (file || '').replace(/^\//, '');
        const sortedPCs = [...sessionDedupedChanges].sort(
          (a: any, b: any) => (a.promptIndex || 0) - (b.promptIndex || 0),
        );
        type AddedBlock = { lines: string[]; promptIndex: number; pc: any };
        const blocks: AddedBlock[] = [];
        for (const pc of sortedPCs) {
          for (const blob of [pc.diff, pc.uncommittedDiff]) {
            if (typeof blob !== 'string' || !blob) continue;
            const sections = blob.split(/^(?=diff --git )/m);
            for (const section of sections) {
              const headerLine = section.split('\n', 1)[0] || '';
              const m = headerLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
              if (!m) continue;
              const fp = m[2].replace(/^\//, '');
              if (
                fp !== normFile &&
                !fp.endsWith(normFile) &&
                !normFile.endsWith(fp)
              ) continue;
              // Extract contiguous + line runs, then split each run into
              // sub-blocks at section-header boundaries. A "header" is a
              // capitalized line ending with `:` (e.g. "Nasty example:") or
              // a markdown heading (starts with `#`). Without this split,
              // when a single hunk in the cumulative pc.diff lumps multiple
              // prompts' additions into one big run, the earlier prompts'
              // anchors are already claimed and the run as a whole fails to
              // match — losing attribution for the later sub-section.
              const splitIntoSubBlocks = (run: string[]): string[][] => {
                if (run.length < 3) return [];
                const out: string[][] = [];
                let buf: string[] = [];
                for (let i = 0; i < run.length; i++) {
                  const ln = run[i];
                  const prev = i > 0 ? run[i - 1] : null;
                  const isHeader =
                    /^[A-Z][^:]*:\s*$/.test(ln) || /^#{1,6}\s+\S/.test(ln);
                  // Section boundaries: prose headers (capital + colon),
                  // markdown headings, OR a non-blank line that follows a
                  // blank line (typical logical break in code — e.g.
                  // `if "--title" ...\n    ...\n    ...\n\nif "--nasty" ...`).
                  const startsAfterBlank = prev === '' && ln !== '';
                  if ((isHeader || startsAfterBlank) && buf.length >= 3) {
                    out.push(buf);
                    buf = [];
                  }
                  buf.push(ln);
                }
                if (buf.length >= 3) out.push(buf);
                // Always include the whole run too — fuzzy match prefers the
                // longest match, and a sub-block split that's wrong shouldn't
                // strand the original block from being tried.
                if (out.length > 1) out.push(run);
                if (out.length === 0 && run.length >= 3) out.push(run);
                return out;
              };
              let current: string[] = [];
              const flush = () => {
                for (const sub of splitIntoSubBlocks(current)) {
                  blocks.push({ lines: sub, promptIndex: pc.promptIndex, pc });
                }
                current = [];
              };
              for (const raw of section.split('\n').slice(1)) {
                if (raw.startsWith('+++') || raw.startsWith('---')) continue;
                if (raw.startsWith('+')) {
                  current.push(raw.slice(1));
                } else {
                  flush();
                }
              }
              flush();
            }
          }
        }
        // Fuzzy block search. A pc.diff block of size N is matched against
        // fullView starting at any position whose first line equals the
        // block's first line — at that anchor we count how many of the
        // block's next lines match in sequence. If the match score is
        // ≥ 60 % of the block size (and ≥ 3 absolute matches), we attribute
        // the matching positions to that prompt. Mismatched positions
        // (e.g. a line a later prompt mutated) stay unattributed and fall
        // through to the per-line content queue below.
        for (const block of blocks) {
          const N = block.lines.length;
          const minMatches = Math.max(3, Math.ceil(N * 0.6));
          let bestIdx = -1;
          let bestMatches: number[] = [];
          for (let i = 0; i + N <= fullView.length; i++) {
            if (blockAttribution.has(i)) continue;
            const fv0 = fullView[i];
            if (!fv0 || fv0.isGap) continue;
            if (fv0.content !== block.lines[0]) continue;
            const matchedIdxs: number[] = [];
            for (let j = 0; j < N; j++) {
              const fv = fullView[i + j];
              if (!fv || fv.isGap) break;
              if (blockAttribution.has(i + j)) continue;
              if (fv.content === block.lines[j]) matchedIdxs.push(i + j);
            }
            if (matchedIdxs.length >= minMatches && matchedIdxs.length > bestMatches.length) {
              bestIdx = i;
              bestMatches = matchedIdxs;
              if (bestMatches.length === N) break;
            }
          }
          if (bestIdx >= 0 && bestMatches.length > 0) {
            const attrMeta = sessionDedupedChanges.find(
              (x: any) => x.promptIndex === block.promptIndex,
            );
            if (attrMeta) {
              const entry: AttrEntry = {
                promptIndex: block.promptIndex,
                promptText: (attrMeta as any).promptText || '',
                type: 'added',
                sessionId: session.id,
                isCurrentSession: true,
                sessionAiTitle: (session as any).aiTitle || undefined,
                sessionModel: session.model,
                agentName: (session as any).agent?.name || undefined,
                authorName: (session as any).user?.name || undefined,
                authorEmail: (session as any).user?.email || undefined,
              };
              for (const idx of bestMatches) {
                blockAttribution.set(idx, entry);
              }
            }
          }
        }
      }

      blameLines = fullView.map((line, idx) => {
        if (line.isGap) {
          return {
            lineNumber: -1,
            content: line.content,
            attribution: null,
            isGap: true,
          };
        }
        // PRIMARY: block match first (catches committed prior-prompt content
        // that surfaces as context in sessionDiff), then per-line content
        // queue for shorter or singleton additions, then unique-content
        // attribution for context lines whose content was added by exactly
        // one prompt in this session (catches single-line additions like
        // "Twenty-fifth small Codex change." that fall under the block
        // matcher's 3-line minimum and never appear as `+` in sessionDiff
        // because they're already committed and part of HEAD).
        let primary: AttrEntry | undefined = blockAttribution.get(idx);
        if (!primary && line.type === 'added') {
          const queue = contentAttributions.get(line.content);
          if (queue && queue.length > 0) primary = queue.shift();
        }
        if (!primary && line.type === 'context' && line.content.trim().length > 0) {
          // Only attribute non-blank context lines — blank lines are too
          // common to risk false positives. Require the content to be
          // unique within this session's added-line pool (queue.length === 1)
          // so we never steal a multi-prompt-shared line.
          const queue = contentAttributions.get(line.content);
          if (queue && queue.length === 1) {
            primary = queue.shift();
          }
        }
        // ORIGINAL = the earliest prior session that wrote this content.
        // Surfaces as a secondary annotation so context lines also carry
        // attribution (e.g. "originally Codex P2") and added lines that
        // re-add prior content credit the original author too.
        let original: AttrEntry | undefined;
        const priorQueue = priorContentAttributions.get(line.content);
        if (priorQueue && priorQueue.length > 0) original = priorQueue.shift();

        // Display rule:
        //   - If this session added the line → primary wins (its own promptIndex).
        //     originalAuthor is attached only if a prior session also wrote
        //     identical content earlier.
        //   - If only a prior session wrote it → primary stays null;
        //     originalAuthor surfaces the cross-session author directly.
        const primaryAttribution = primary
          ? toAttribution(primary)
          : original
            ? toAttribution(original)
            : null;
        const originalAuthor =
          primary && original ? toAttribution(original) : undefined;

        const isUncommitted = !!(
          primaryAttribution &&
          primaryAttribution.isCurrentSession !== false &&
          isPromptUncommittedForFile(primaryAttribution.promptIndex)
        );
        return {
          lineNumber: line.lineNumber,
          content: line.content,
          attribution: primaryAttribution
            ? { ...primaryAttribution, ...(originalAuthor ? { originalAuthor } : {}) }
            : null,
          ...(isUncommitted ? { isUncommitted: true } : {}),
        };
      });
    } else {
      // Fallback path — no sessionDiff. Render only this session's own
      // attributed lines by line number. Cross-session originalAuthor isn't
      // surfaced here because we have no full file view.
      const allLineNumbers = Array.from(lineAttributions.keys()).sort(
        (a, b) => a - b,
      );
      blameLines = allLineNumbers.map((ln) => {
        const attr = lineAttributions.get(ln)!;
        const isUncommitted = isPromptUncommittedForFile(attr.promptIndex);
        return {
          lineNumber: ln,
          content: attr.content,
          attribution: toAttribution(attr),
          ...(isUncommitted ? { isUncommitted: true } : {}),
        };
      });
    }

    const totalAttributedLines = blameLines.filter(
      (l) => l.attribution !== null && !l.isGap,
    ).length;

    // Diagnose attribution. Unconditional while we trace remaining
    // misattribution issues in the rollout-walk path.
    console.log('[blame] diag', JSON.stringify({
      sessionId: id,
      model: session.model,
      targetFile: file,
      totalAttributedLines,
      totalPrompts: blameDebug.totalPrompts,
      promptsWithDiff: blameDebug.promptsWithDiff,
      promptsWithMatchedLines: blameDebug.promptsWithMatchedLines,
      diffFileHeaderSamples: [...blameDebug.diffFileHeaderSamples],
      perPromptMatches: blameDebug.perPromptMatches,
      promptTexts: dedupedChanges.map((pc: { promptIndex: number; promptText: string }) => ({
        idx: pc.promptIndex,
        text: pc.promptText.slice(0, 80),
      })),
      hasSessionDiff: !!session.sessionDiff?.diff,
      sessionDiffLen: session.sessionDiff?.diff?.length ?? 0,
    }));

    // Distinct list of models used across this session's prompts. Falls back
    // to [session.model] when no per-prompt model field is populated.
    const blameSeen = new Set<string>();
    const blameModelsUsed: string[] = [];
    for (const pc of session.promptChanges ?? []) {
      const m = (pc as { model?: string | null }).model || null;
      if (m && !blameSeen.has(m)) { blameSeen.add(m); blameModelsUsed.push(m); }
    }
    if (blameModelsUsed.length === 0 && session.model) blameModelsUsed.push(session.model);

    res.json({
      file,
      sessionId: id,
      model: session.model,
      modelsUsed: blameModelsUsed,
      totalAttributedLines,
      lines: blameLines,
      prompts: promptsInfo.map((p) => ({
        ...p,
        promptText:
          p.promptText.length > 200 ? p.promptText.slice(0, 200) + '...' : p.promptText,
      })),
      // Every prompt across all sessions in this repo that touched this file,
      // chronologically. Lets the UI annotate lines whose attribution comes
      // from a different session ("added by Codex in or-test-1 P2").
      crossSessionPrompts: crossSessionPrompts.map((p) => ({
        ...p,
        promptText:
          p.promptText.length > 200 ? p.promptText.slice(0, 200) + '...' : p.promptText,
      })),
    });
  } catch (err) {
    console.error('Get session blame error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/ask — Ask the Author: contextual questions about a session
// ---------------------------------------------------------------------------

const ASK_AUTHOR_SYSTEM_PROMPT = `You are explaining code that was written during an AI coding session. You have access to the full transcript of the conversation between the human developer and the AI assistant, along with the code changes that were produced.

Your role is to explain WHY specific code decisions were made, based on what was discussed in the transcript. Reference specific parts of the conversation when relevant.

When answering:
- Reference specific prompts from the conversation that led to the code
- Explain the reasoning and intent, not just what the code does
- If the question is about code you don't have context for, say so
- Be concise but thorough
- Format responses in markdown when helpful
`;

router.post('/:id/ask', expensiveLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { question, context, messages: conversationHistory } = req.body;

    if (!question && (!conversationHistory || conversationHistory.length === 0)) {
      return res.status(400).json({ error: 'question is required' });
    }

    // Cost-burning defense. /ask sends `question` + `conversationHistory`
    // straight into an LLM call, and every request here spends the org's
    // LLM credits. Without a cap, a member could post a 50MB question and
    // blow a five-figure hole in a single request. Cap the question
    // itself, the per-message content, and the total history size.
    const MAX_QUESTION_LEN = 8 * 1024;   // 8KB per question
    const MAX_HISTORY_BYTES = 50 * 1024; // 50KB aggregate history
    const MAX_HISTORY_MSGS = 50;         // even with slice(-10), cap incoming array
    if (question !== undefined && typeof question !== 'string') {
      return res.status(400).json({ error: 'question must be a string' });
    }
    if (typeof question === 'string' && question.length > MAX_QUESTION_LEN) {
      return res.status(413).json({ error: 'question exceeds maximum length' });
    }
    if (conversationHistory !== undefined && !Array.isArray(conversationHistory)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }
    if (Array.isArray(conversationHistory)) {
      if (conversationHistory.length > MAX_HISTORY_MSGS) {
        return res.status(413).json({ error: 'messages array exceeds maximum length' });
      }
      let total = 0;
      for (const m of conversationHistory) {
        const c = typeof m?.content === 'string' ? m.content : '';
        total += c.length;
        if (total > MAX_HISTORY_BYTES) {
          return res.status(413).json({ error: 'messages aggregate size exceeds limit' });
        }
      }
    }

    const session = await prisma.codingSession.findFirst({
      where: scopedSessionWhere(req, {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
      }),
      include: {
        commit: true,
        promptChanges: { orderBy: { promptIndex: 'asc' } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Build context sections
    const contextParts: string[] = [];

    // Session metadata
    contextParts.push(
      `=== Session Context ===\nModel: ${session.model}\nCommit: ${session.commit?.sha?.slice(0, 8) || 'n/a'} - ${session.commit?.message || 'n/a'}\nFiles Changed: ${(() => { try { return JSON.parse(session.filesChanged).join(', '); } catch { return 'n/a'; } })()}\nPrompt Count: ${session.promptChanges.length}`,
    );

    // Transcript (truncated to stay within token limits)
    let transcript = '';
    try {
      const parsed = JSON.parse(session.transcript);
      if (Array.isArray(parsed)) {
        transcript = parsed
          .map((m: any) => `[${m.role?.toUpperCase()}]: ${m.content}`)
          .join('\n\n');
      }
    } catch {
      transcript = session.transcript || '';
    }

    // Truncate transcript to ~30k chars
    if (transcript.length > 30000) {
      transcript = transcript.slice(-30000);
      transcript = '...(transcript truncated)...\n\n' + transcript;
    }

    if (transcript) {
      contextParts.push(`=== Transcript ===\n${transcript}`);
    }

    // Include relevant diffs
    let diffContext = '';
    if (context?.file) {
      // File-specific context: only include diffs for that file
      const relevantChanges = session.promptChanges.filter((pc) => {
        const files: string[] = (() => {
          try {
            return JSON.parse(pc.filesChanged || '[]');
          } catch {
            return [];
          }
        })();
        return files.some(
          (f) =>
            f === context.file ||
            f.endsWith(context.file) ||
            context.file.endsWith(f),
        );
      });

      diffContext = relevantChanges
        .map((pc) => `--- Prompt #${pc.promptIndex}: "${pc.promptText.slice(0, 100)}" ---\n${pc.diff}`)
        .join('\n\n');
    } else if (context?.promptIndex !== undefined) {
      // Prompt-specific context
      const pc = session.promptChanges.find(
        (p) => p.promptIndex === context.promptIndex,
      );
      if (pc) {
        diffContext = `--- Prompt #${pc.promptIndex}: "${pc.promptText}" ---\n${pc.diff}`;
      }
    } else {
      // General context: include all diffs (truncated)
      diffContext = session.promptChanges
        .map((pc) => `--- Prompt #${pc.promptIndex}: "${pc.promptText.slice(0, 80)}" ---\n${(pc.diff || '').slice(0, 2000)}`)
        .join('\n\n');

      if (diffContext.length > 15000) {
        diffContext = diffContext.slice(0, 15000) + '\n...(diffs truncated)...';
      }
    }

    if (diffContext) {
      contextParts.push(`=== Code Changes ===\n${diffContext}`);
    }

    const systemPrompt = ASK_AUTHOR_SYSTEM_PROMPT + '\n' + contextParts.join('\n\n');

    // Build messages array
    const msgs: Array<{ role: string; content: string }> = [];
    if (conversationHistory && Array.isArray(conversationHistory)) {
      msgs.push(...conversationHistory.slice(-10));
    }
    if (question) {
      msgs.push({ role: 'user', content: question });
    }

    // Use org-level LLM config (same key configured in Settings)
    const orgId = req.activeOrgId!;
    const [orgKey, orgModel, orgProvider] = await Promise.all([
      getOrgLLMKey(orgId),
      getOrgLLMModel(orgId),
      getOrgLLMProvider(orgId),
    ]);

    const answer = await callLLM(systemPrompt, msgs, 2048, {
      apiKey: orgKey || undefined,
      model: orgModel,
      provider: orgProvider,
    });

    res.json({ answer });
  } catch (err: any) {
    console.error('Ask session author error:', err);
    if (err.message === 'AI chat is not configured') {
      return res.status(503).json({ error: 'AI chat is not configured. Set ANTHROPIC_API_KEY in Settings → Integrations.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/secrets — Report secret findings from pre-commit hook
// ---------------------------------------------------------------------------

router.post('/:id/secrets', async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = req.params.id as string;
    const { findings, source } = req.body;

    if (!findings || !Array.isArray(findings) || findings.length === 0) {
      return res.status(400).json({ error: 'findings array is required' });
    }
    // Cap findings array. Each entry writes a SecretFinding row below, so
    // an unbounded POST turns into an unbounded sequential DB-write amp.
    const MAX_FINDINGS = 500;
    if (findings.length > MAX_FINDINGS) {
      return res.status(413).json({ error: `findings exceeds max of ${MAX_FINDINGS}` });
    }

    // Verify session exists and belongs to user's org
    const session = await prisma.codingSession.findFirst({
      where: {
        id: sessionId,
        commit: { repo: { orgId: req.activeOrgId! } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Store each finding
    for (const f of findings) {
      await prisma.secretFinding.create({
        data: {
          sessionId,
          type: f.type || 'GENERIC_SECRET',
          severity: f.severity || 'medium',
          filePath: f.filePath || '',
          lineNumber: f.lineNumber || 0,
          match: f.match || '',
          ruleName: f.ruleName || 'pre-commit',
        },
      });
    }

    // Audit log
    const orgId = req.activeOrgId!;
    await prisma.auditLog.create({
      data: {
        orgId,
        action: 'SECRET_DETECTED',
        resource: sessionId,
        metadata: JSON.stringify({
          sessionId,
          source: source || 'pre-commit',
          findingsCount: findings.length,
          types: [...new Set(findings.map((f: any) => f.type))],
          severities: [...new Set(findings.map((f: any) => f.severity))],
        }),
      },
    });

    // Notify admins for critical/high findings
    const criticalFindings = findings.filter(
      (f: any) => f.severity === 'critical' || f.severity === 'high',
    );
    if (criticalFindings.length > 0) {
      const typesSummary = [...new Set(criticalFindings.map((f: any) => f.ruleName))].join(', ');
      await notifyOrgAdmins(
        orgId,
        'SECRET_DETECTED',
        `Secret Detected (pre-commit): ${criticalFindings.length} finding${criticalFindings.length !== 1 ? 's' : ''}`,
        `${typesSummary} found — commit blocked`,
        `/sessions/${sessionId}`,
        { sessionId, findingsCount: criticalFindings.length, types: [...new Set(criticalFindings.map((f: any) => f.type))] },
      );
    }

    console.log(`[secrets] Session ${sessionId}: ${findings.length} finding(s) from ${source || 'pre-commit'}`);
    res.json({ stored: findings.length });
  } catch (err: any) {
    console.error('Store secret findings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/share — create a public share link for a session
router.post('/:id/share', async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = req.params.id as string;
    const { expiresAt } = req.body || {};

    // Verify the session exists and belongs to user's org (support short ID prefix)
    const session = await prisma.codingSession.findFirst({
      where: {
        id: sessionId.length < 36 ? { startsWith: sessionId } : sessionId,
        commit: { repo: { orgId: req.activeOrgId! } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Check if already shared — return existing link (use resolved full ID)
    const existing = await prisma.sharedSession.findFirst({
      where: { sessionId: session.id },
    });

    if (existing) {
      const baseUrl = process.env.PUBLIC_URL || 'https://getorigin.io';
      return res.json({
        url: `${baseUrl}/s/${existing.slug}`,
        slug: existing.slug,
        expiresAt: existing.expiresAt,
      });
    }

    // Generate a 22-char base64url slug from 128 bits of entropy.
    //
    // The previous implementation used 6 bytes → 8 base64url chars ≈ 48
    // bits, which is well within brute-force range for an unauthenticated
    // URL that returns full prompts, transcripts, and diffs. At 48 bits an
    // attacker enumerating the slug space finds a valid link after roughly
    // 2^24 requests — minutes on a cheap VPS, even with our rate limits.
    //
    // 16 bytes → 22 base64url chars (trailing `=` stripped) → 128 bits. At
    // that width, enumeration becomes computationally infeasible regardless
    // of rate limits, matching the security posture of session UUIDs.
    //
    // Existing short slugs in the DB still work — they're looked up by
    // exact match in GET /:slug, so the length change is forward-compatible.
    const slug = crypto.randomBytes(16).toString('base64url').replace(/=+$/, '');

    const shared = await prisma.sharedSession.create({
      data: {
        sessionId: session.id,
        slug,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        createdById: req.user!.id,
      },
    });

    const baseUrl = process.env.PUBLIC_URL || 'https://getorigin.io';
    res.json({
      url: `${baseUrl}/s/${shared.slug}`,
      slug: shared.slug,
      expiresAt: shared.expiresAt,
    });
  } catch (err) {
    console.error('Share session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id/share — revoke a shared session link
router.delete('/:id/share', async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = req.params.id as string;

    const session = await prisma.codingSession.findFirst({
      where: {
        id: sessionId.length < 36 ? { startsWith: sessionId } : sessionId,
        commit: { repo: { orgId: req.activeOrgId! } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await prisma.sharedSession.deleteMany({
      where: { sessionId: session.id },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Revoke share error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Bookmarks ─────────────────────────────────────────────────────────────────

// GET /bookmarked — list bookmarked sessions for the current user
router.get('/bookmarked', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const orgId = req.activeOrgId!;

    const bookmarks = await prisma.sessionBookmark.findMany({
      where: { userId },
      include: {
        session: {
          include: {
            commit: { include: { repo: true } },
            agent: true,
            user: true,
            review: { include: { user: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Filter to only sessions in the user's org
    const filtered = bookmarks.filter(
      (b) => b.session.commit?.repo?.orgId === orgId,
    );

    res.json(
      filtered.map((b) => ({
        ...mapSession(b.session),
        bookmark: {
          id: b.id,
          tags: safeParseArray<string>(b.tags, `bookmarks.list ${b.id}`),
          note: b.note,
          createdAt: b.createdAt,
        },
      })),
    );
  } catch (err) {
    console.error('List bookmarks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/bookmark — bookmark a session
router.post('/:id/bookmark', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessionId = req.params.id as string;
    const { tags, note } = req.body || {};

    const bookmark = await prisma.sessionBookmark.upsert({
      where: { sessionId_userId: { sessionId, userId } },
      update: {
        tags: JSON.stringify(tags || []),
        note: note || '',
      },
      create: {
        sessionId,
        userId,
        tags: JSON.stringify(tags || []),
        note: note || '',
      },
    });

    res.json({
      id: bookmark.id,
      sessionId: bookmark.sessionId,
      tags: safeParseArray<string>(bookmark.tags, `bookmarks.create ${bookmark.id}`),
      note: bookmark.note,
      createdAt: bookmark.createdAt,
    });
  } catch (err) {
    console.error('Bookmark session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id/bookmark — remove bookmark
router.delete('/:id/bookmark', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessionId = req.params.id as string;

    await prisma.sessionBookmark.deleteMany({
      where: { sessionId, userId },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Remove bookmark error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /merge — merge multiple sessions into one
router.post('/merge', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { sessionIds, name } = req.body as { sessionIds: string[]; name?: string };

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length < 2) {
      return res.status(400).json({ error: 'At least 2 session IDs are required' });
    }
    // Hard cap — merging 100 sessions already stresses diff serialization,
    // and without a ceiling the client can make us load arbitrary rows.
    if (sessionIds.length > 100) {
      return res.status(400).json({ error: 'Cannot merge more than 100 sessions at once' });
    }

    // Fetch all sessions with their data
    const sessions = await prisma.codingSession.findMany({
      where: {
        id: { in: sessionIds },
        userId, // only merge own sessions
      },
      include: {
        commit: { include: { repo: true } },
        agent: true,
        promptChanges: { orderBy: { createdAt: 'asc' } },
        sessionDiff: true,
      },
      orderBy: { startedAt: 'asc' },
    });

    if (sessions.length !== sessionIds.length) {
      return res.status(404).json({ error: 'One or more sessions not found or not accessible' });
    }

    // Validate: no running sessions
    if (sessions.some((s) => s.status === 'RUNNING')) {
      return res.status(400).json({ error: 'Cannot merge running sessions. Wait for them to complete.' });
    }

    // Validate: all from same repo
    const repoIds = new Set(sessions.map((s) => s.commit?.repoId).filter(Boolean));
    if (repoIds.size > 1) {
      return res.status(400).json({ error: 'Cannot merge sessions from different repositories' });
    }

    // Validate: not already merged
    if (sessions.some((s) => s.mergedInto)) {
      return res.status(400).json({ error: 'One or more sessions were already merged into another session' });
    }

    // Compute merged values
    const totalTokens = sessions.reduce((sum, s) => sum + s.tokensUsed, 0);
    const totalInputTokens = sessions.reduce((sum, s) => sum + s.inputTokens, 0);
    const totalOutputTokens = sessions.reduce((sum, s) => sum + s.outputTokens, 0);
    const totalToolCalls = sessions.reduce((sum, s) => sum + s.toolCalls, 0);
    const totalDuration = sessions.reduce((sum, s) => sum + s.durationMs, 0);
    const totalLinesAdded = sessions.reduce((sum, s) => sum + s.linesAdded, 0);
    const totalLinesRemoved = sessions.reduce((sum, s) => sum + s.linesRemoved, 0);
    const totalCost = sessions.reduce((sum, s) => sum + s.costUsd, 0);

    // Files changed: union of all
    const allFiles = new Set<string>();
    for (const s of sessions) {
      try {
        const files = JSON.parse(s.filesChanged);
        if (Array.isArray(files)) files.forEach((f: string) => allFiles.add(f));
      } catch { /* ignore */ }
    }

    // Agent: use common agent or "Multiple"
    const agentIds = new Set(sessions.map((s) => s.agentId).filter(Boolean));
    const agentNames = [...new Set(sessions.map((s) => s.agent?.name).filter(Boolean))];
    const mergedAgentId = agentIds.size === 1 ? [...agentIds][0] : null;

    // Model: use common model or list
    const models = [...new Set(sessions.map((s) => s.model))];
    const mergedModel = models.length === 1 ? models[0] : models.join(' + ');

    // Branch: use common branch
    const branches = [...new Set(sessions.map((s) => s.branch).filter(Boolean))];
    const mergedBranch = branches.length === 1 ? branches[0] : branches.join(', ');

    // Combine transcripts
    const combinedTranscript: any[] = [];
    for (const s of sessions) {
      try {
        const parsed = JSON.parse(s.transcript);
        if (Array.isArray(parsed)) {
          combinedTranscript.push(
            { role: 'system', content: `--- Session ${s.id.slice(0, 8)} (${s.agent?.name || s.model}) ---` },
            ...parsed,
          );
        }
      } catch {
        if (s.transcript) {
          combinedTranscript.push(
            { role: 'system', content: `--- Session ${s.id.slice(0, 8)} ---` },
            { role: 'assistant', content: s.transcript },
          );
        }
      }
    }

    // Combine diffs
    const combinedDiff = sessions
      .map((s) => s.sessionDiff?.diff || '')
      .filter(Boolean)
      .join('\n');

    // Time range
    const startedAt = sessions[0].startedAt || sessions[0].createdAt;
    const endedAt = sessions[sessions.length - 1].endedAt || sessions[sessions.length - 1].createdAt;

    // Create placeholder commit for the merged session
    const placeholderSha = crypto.randomBytes(20).toString('hex');
    const repoId = sessions[0].commit?.repoId!;
    const mergedCommit = await prisma.commit.create({
      data: {
        repoId,
        sha: placeholderSha,
        message: name || `Merged session (${sessions.length} sessions)`,
        author: 'origin-merge',
        aiToolDetected: mergedModel,
        aiDetectionMethod: 'merge',
        filesChanged: JSON.stringify([...allFiles]),
        committedAt: new Date(),
      },
    });

    // Create the merged session
    const mergedSession = await prisma.codingSession.create({
      data: {
        commitId: mergedCommit.id,
        agentId: mergedAgentId,
        userId,
        model: mergedModel,
        prompt: name || `Merged: ${agentNames.length > 1 ? agentNames.join(' + ') : agentNames[0] || 'AI'} session`,
        transcript: JSON.stringify(combinedTranscript),
        filesChanged: JSON.stringify([...allFiles]),
        tokensUsed: totalTokens,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCalls: totalToolCalls,
        durationMs: totalDuration,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
        costUsd: totalCost,
        branch: mergedBranch || null,
        status: 'COMPLETED',
        mergedFrom: JSON.stringify(sessionIds),
        startedAt,
        endedAt,
      },
    });

    // Create merged session diff
    if (combinedDiff) {
      const allCommitShas = sessions.flatMap((s) => {
        try { return JSON.parse(s.sessionDiff?.commitShas || '[]'); } catch { return []; }
      });
      await prisma.sessionDiff.create({
        data: {
          sessionId: mergedSession.id,
          headBefore: sessions[0].sessionDiff?.headBefore || '',
          headAfter: sessions[sessions.length - 1].sessionDiff?.headAfter || '',
          commitShas: JSON.stringify([...new Set(allCommitShas)]),
          diff: combinedDiff,
          diffTruncated: sessions.some((s) => s.sessionDiff?.diffTruncated),
          linesAdded: totalLinesAdded,
          linesRemoved: totalLinesRemoved,
        },
      });
    }

    // Re-index prompt changes into the merged session
    let promptOffset = 0;
    for (const s of sessions) {
      for (const pc of s.promptChanges) {
        await prisma.promptChange.create({
          data: {
            sessionId: mergedSession.id,
            promptIndex: promptOffset + pc.promptIndex,
            promptText: pc.promptText,
            filesChanged: pc.filesChanged,
            diff: pc.diff,
            uncommittedDiff: pc.uncommittedDiff || '',
            linesAdded: pc.linesAdded || 0,
            linesRemoved: pc.linesRemoved || 0,
            aiPercentage: pc.aiPercentage ?? 100,
            checkpointType: pc.checkpointType || null,
            commitSha: pc.commitSha || null,
            treeSha: pc.treeSha || null,
            createdAt: pc.createdAt,
          },
        });
      }
      promptOffset += s.promptChanges.length;
    }

    // Mark original sessions as merged
    await prisma.codingSession.updateMany({
      where: { id: { in: sessionIds } },
      data: { mergedInto: mergedSession.id },
    });

    res.json({
      mergedSessionId: mergedSession.id,
      mergedCount: sessions.length,
      totalTokens,
      totalCost,
    });
  } catch (err) {
    console.error('Merge sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
