// The WRITE half of the MCP memory tools: add_todo, close_todo, record_decision.
//
// Until these, repo memory was written only from Stop / session end, by mining
// `[Origin: Open]`, `[Origin: Closes]` and `[Origin: Decision]` markers out of
// the transcript. An agent could not deliberately leave a TODO, close one, or
// record a decision without hoping its prose was parsed the way it meant.
//
// Each tool is a thin wrapper over the writer the marker path already uses, so
// what it records lands in the same place, travels the same way
// (refs/notes/origin-memory) and is read by the same readers:
//
//   add_todo        → addManualTodo (todo.ts): the local store + `manualTodos`
//   close_todo      → recordPendingClosures + sweepTodoClosures (todo-sweep.ts):
//                     a PENDING claim that closes only when the work lands on
//                     the default branch — exactly the `[Origin: Closes]` rule.
//                     There is deliberately no way to close outright.
//   record_decision → writeSessionMemory (memory.ts): the current session's
//                     entry, as `recordedDecisions`, which every later rewrite
//                     of that entry carries forward.
//
// None of these throws: every refusal comes back as `{ error }`.
import path from 'path';
import {
  isBakeoffRepo, readManualTodos, readSessionMemoryEntry, readTodoClosures, todoClosureKey, writeSessionMemory,
  type RecordedDecision, type SessionMemoryEntry,
} from '../memory.js';
import { isRepoIgnored } from '../ignore-repos.js';
import { shouldIncludePromptText } from '../prompt-privacy.js';
import { getGitRoot, getWorkingGitRoot, isSessionAlive, listActiveSessions, type SessionState } from '../session-state.js';
import { addManualTodo, getOpenTodos, readMemoryTodos } from '../todo.js';
import { matchTodoForClosure, recordPendingClosures, sweepTodoClosures } from '../todo-sweep.js';
import { gitOrNull } from '../utils/exec.js';
import { samePath } from '../paths.js';

export const MAX_TODO_CHARS = 500;
export const MAX_DECISION_CHARS = 1000;
/** Per session. The marker path keeps 8 decisions per entry; this matches it. */
export const MAX_RECORDED_DECISIONS = 8;
const MAX_DECISION_FILES = 20;
const MAX_CANDIDATES = 5;

type Refusal = { error: string; [k: string]: unknown };

/** The repo a write goes to, or why it may not be written. */
function resolveRepo(repoPathArg: unknown): { repoRoot: string; workRoot: string } | Refusal {
  const raw = typeof repoPathArg === 'string' && repoPathArg.trim() ? repoPathArg.trim() : process.cwd();
  const workRoot = getWorkingGitRoot(raw);
  const repoRoot = getGitRoot(raw);
  if (!workRoot || !repoRoot) return { error: `not a git repository: ${raw}` };
  // The same gates every memory writer applies (writeSessionMemory,
  // recordTodoClosures, recordManualTodos). Those return silently; an agent
  // asked to record something is told instead.
  if (isRepoIgnored(repoRoot)) return { error: `this repo is in Origin's ignoredRepos — nothing is recorded for it: ${repoRoot}` };
  if (isBakeoffRepo(repoRoot) || isBakeoffRepo(workRoot)) return { error: 'this is a bake-off repo — its work is never remembered' };
  if (!gitOrNull(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: workRoot, timeoutMs: 5_000 })) {
    return { error: 'this repo has no commits yet — repo memory is stored on the root commit' };
  }
  return { repoRoot, workRoot };
}

/** Whether what was just written leaves this machine with the memory notes. */
function travels(repoRoot: string): { travels: boolean; note?: string } {
  if (shouldIncludePromptText(repoRoot)) return { travels: true };
  return {
    travels: false,
    note: 'recorded in this clone\'s memory note; it is not pushed because this repo/machine keeps notes metadata-only (notesIncludePrompts is not true)',
  };
}

/**
 * The Origin CAPTURE session this MCP server is serving — the id the hooks
 * write into Origin-Session trailers and memory entries.
 *
 * Not the MCP server's own `currentSessionId`: that is only set by the
 * `start_session` tool, is a separate server-side session, and appears in no
 * trailer, so a closure claimed under it could never confirm.
 *
 * An MCP server is a child of the agent and has no hook payload, so the session
 * is found the way the bare git hooks find one: the live state files for this
 * repo. Narrowed by the agent's own session id when the host exports one
 * (Claude Code: CLAUDE_CODE_SESSION_ID), then by the working tree. Several
 * candidates left is AMBIGUOUS, never a guess — a claim filed under another
 * agent's session would confirm when THAT session's work lands.
 */
export function resolveCaptureSession(
  repoRoot: string,
  workRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { state: SessionState } | { reason: 'none' | 'ambiguous'; count: number } {
  let live: SessionState[] = [];
  try {
    live = listActiveSessions(repoRoot).filter((s) => isSessionAlive(s, (s as any).__statePath));
  } catch { live = []; }
  if (live.length === 0) return { reason: 'none', count: 0 };

  const agentId = (env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (agentId) {
    const mine = live.filter((s) => s.agentSessionId === agentId || s.claudeSessionId === agentId);
    if (mine.length === 1) return { state: mine[0] };
  }
  if (live.length === 1) return { state: live[0] };

  const here = live.filter((s) => {
    const root = getWorkingGitRoot(s.lastCwd || s.repoPath);
    return !!root && samePath(root, workRoot);
  });
  if (here.length === 1) return { state: here[0] };
  return { reason: 'ambiguous', count: here.length || live.length };
}

function sessionRefusal(r: { reason: 'none' | 'ambiguous'; count: number }, what: string): Refusal {
  return r.reason === 'none'
    ? { error: `no live Origin session found for this repo — ${what} is recorded under the session doing the work, and none is being captured here` }
    : { error: `${r.count} live Origin sessions in this repo and none is identifiably this one — ${what} is not recorded rather than filed under the wrong session` };
}

// ─── add_todo ────────────────────────────────────────────────────────────────

export function addTodoTool(args: { text?: unknown; repo_path?: unknown }): { id: string; text: string; existing: boolean; travels: boolean; note?: string } | Refusal {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return { error: 'text is required' };
  if (text.length > MAX_TODO_CHARS) return { error: `text is ${text.length} characters; keep a TODO under ${MAX_TODO_CHARS}` };
  const repo = resolveRepo(args.repo_path);
  if ('error' in repo) return repo;
  try {
    // An open TODO with the same text — session-mined, archived, typed — is the
    // same item. Adding it again would list it twice in the local store.
    const key = todoClosureKey(text);
    const same = getOpenTodos(repo.repoRoot).find((t) => todoClosureKey(t.text) === key);
    if (same) return { id: same.id, text: same.text, existing: true, ...travels(repo.repoRoot) };

    const item = addManualTodo(text, repo.repoRoot);
    // addManualTodo never fails on the note write — the local store is its
    // fallback. An agent needs to know whether the TODO actually reached the
    // repo, because the local store is invisible to every other clone.
    const inNote = readManualTodos(repo.repoRoot).some((m) => m.key === key);
    if (!inNote) {
      return {
        id: item.id, text: item.text, existing: false, travels: false,
        note: 'saved to this machine\'s TODO store only — the repo memory note could not be written',
      };
    }
    return { id: item.id, text: item.text, existing: false, ...travels(repo.repoRoot) };
  } catch (err: any) {
    return { error: `could not record the TODO: ${err?.message || err}` };
  }
}

// ─── close_todo ──────────────────────────────────────────────────────────────

/**
 * The TODOs a reference plausibly meant, for an error that lets the agent pick
 * one by id. Same two arms as matchTodoForClosure — id prefix, then text
 * containment — without its "exactly one" rule, falling back to the newest.
 */
function closureCandidates(ref: string, open: { id: string; text: string }[]): { id: string; text: string }[] {
  const raw = ref.trim();
  const idToken = raw.match(/^[`'"]?([0-9a-f]{4,16})[`'"]?\b/i)?.[1]?.toLowerCase();
  const key = todoClosureKey(raw);
  const words = key.split(' ').filter((w) => w.length > 3);
  const scored = open.map((t) => {
    const k = todoClosureKey(t.text);
    let score = 0;
    if (idToken && t.id.startsWith(idToken)) score += 100;
    if (key && (k.includes(key) || key.includes(k))) score += 50;
    score += words.filter((w) => k.includes(w)).length;
    return { t, score };
  });
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.t);
  return (hits.length ? hits : open).slice(0, MAX_CANDIDATES).map((t) => ({ id: t.id, text: t.text }));
}

export function closeTodoTool(
  args: { todo?: unknown; reason?: unknown; commit_sha?: unknown; repo_path?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): { id: string; text: string; state: 'pending' | 'closed'; alreadyClaimed?: boolean; travels: boolean; note?: string } | Refusal {
  const ref = typeof args.todo === 'string' ? args.todo.trim() : '';
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!ref) return { error: 'todo is required (an id prefix from origin todo list / get_repo_memory, or the TODO text)' };
  if (!reason) return { error: 'reason is required — say what was done' };
  const repo = resolveRepo(args.repo_path);
  if ('error' in repo) return repo;

  let shas: string[] | undefined;
  if (args.commit_sha !== undefined && args.commit_sha !== null && args.commit_sha !== '') {
    const given = String(args.commit_sha).trim();
    const full = /^[0-9a-f]{7,40}$/i.test(given)
      ? gitOrNull(['rev-parse', '--verify', '--quiet', `${given}^{commit}`], { cwd: repo.workRoot, timeoutMs: 5_000 })?.trim()
      : null;
    if (!full) return { error: `commit_sha ${given} is not a commit in this repo` };
    shas = [full];
  }

  // The claim has to name the session doing the work: the sweep confirms it by
  // that session's Origin-Session trailer reaching the default branch. With a
  // commit sha the sha alone can confirm it, so an unidentifiable session is
  // only a refusal when there is nothing else to confirm by.
  const session = resolveCaptureSession(repo.repoRoot, repo.workRoot, env);
  if (!('state' in session) && !shas) {
    return { ...sessionRefusal(session, 'a closure'), hint: 'pass commit_sha — the commit that did the work — and the claim confirms when that commit lands' };
  }
  const sessionId = 'state' in session ? session.state.sessionId : '';

  try {
    // Matched against the same list Stop and session end hand
    // claimSessionCloses — the TODOs the repo's memory note carries.
    const open = readMemoryTodos(repo.repoRoot).map((t) => ({ id: t.id, text: t.text }));
    const hit = matchTodoForClosure(ref, open);
    if (!hit) {
      return {
        error: open.length === 0
          ? 'this repo has no open TODOs in its memory'
          : `"${ref.slice(0, 80)}" matches no single open TODO — name one by id`,
        candidates: closureCandidates(ref, open),
      };
    }
    const key = todoClosureKey(hit.text);
    const recorded = recordPendingClosures({
      repoPath: repo.repoRoot, sessionId, markers: [hit.text], openTodos: [hit], shas, reason,
    });
    const prior = readTodoClosures(repo.repoRoot).find((c) => c.key === key);
    if (!prior) return { error: 'the closure could not be written to the repo memory note' };
    // An already-merged sha confirms it now rather than at the next list read.
    sweepTodoClosures(repo.repoRoot);
    const now = readTodoClosures(repo.repoRoot).find((c) => c.key === key) || prior;
    return {
      id: hit.id, text: hit.text, state: now.state,
      ...(recorded === 0 ? { alreadyClaimed: true } : {}),
      ...travels(repo.repoRoot),
      ...(now.state === 'pending'
        ? { note: 'pending: it closes once the work reaches the default branch (by commit sha or this session\'s Origin-Session trailer)' }
        : {}),
    };
  } catch (err: any) {
    return { error: `could not record the closure: ${err?.message || err}` };
  }
}

// ─── record_decision ─────────────────────────────────────────────────────────

/** Repo-relative paths, as memory stores them. Anything outside the repo is dropped. */
function repoRelative(files: unknown, workRoot: string): string[] {
  if (!Array.isArray(files)) return [];
  const out: string[] = [];
  for (const f of files) {
    if (typeof f !== 'string' || !f.trim()) continue;
    let p = f.trim();
    if (path.isAbsolute(p)) {
      const rel = path.relative(workRoot, p);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      p = rel;
    }
    p = p.replace(/\\/g, '/').replace(/^\.\//, '');
    if (p.startsWith('../')) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, MAX_DECISION_FILES);
}

/**
 * The entry to hang the first recorded decision on, for a session that has not
 * written one yet (no commit, `memoryUpdate: session-end`). The same shape the
 * hooks write; the next commit or the session's end rewrites it whole and keeps
 * `recordedDecisions` (see writeSessionMemory).
 */
function seedEntry(state: SessionState): SessionMemoryEntry {
  const first = (state.prompts || []).find((p) => typeof p === 'string' && p.trim());
  return {
    sessionId: state.sessionId,
    agentSlug: (state as any).agentSlug || 'unknown',
    model: state.model || 'unknown',
    startedAt: state.startedAt,
    endedAt: new Date().toISOString(),
    branch: (state as any).branch ?? null,
    summary: first ? first.trim().slice(0, 200) : 'No summary',
    filesChanged: [],
    promptCount: (state.prompts || []).length,
    linesAdded: 0,
    linesRemoved: 0,
    openTodos: [],
  };
}

export function recordDecisionTool(
  args: { decision?: unknown; why?: unknown; files?: unknown; repo_path?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): { sessionId: string; text: string; files: string[]; existing: boolean; travels: boolean; note?: string } | Refusal {
  const decision = typeof args.decision === 'string' ? args.decision.trim() : '';
  const why = typeof args.why === 'string' ? args.why.trim() : '';
  if (!decision) return { error: 'decision is required' };
  // The marker's own shape — `<choice> — <why>` — so a recorded decision reads
  // like every other one in the memory digest.
  const text = why ? `${decision} — ${why}` : decision;
  if (text.length > MAX_DECISION_CHARS) return { error: `decision + why is ${text.length} characters; keep it under ${MAX_DECISION_CHARS}` };
  const repo = resolveRepo(args.repo_path);
  if ('error' in repo) return repo;
  const files = repoRelative(args.files, repo.workRoot);

  const session = resolveCaptureSession(repo.repoRoot, repo.workRoot, env);
  if (!('state' in session)) return sessionRefusal(session, 'a decision');
  const state = session.state;

  try {
    const existing = readSessionMemoryEntry(repo.repoRoot, state.sessionId);
    const recorded = existing?.recordedDecisions || [];
    const key = todoClosureKey(text);
    if (recorded.some((d) => todoClosureKey(d.text) === key)) {
      return { sessionId: state.sessionId, text, files, existing: true, ...travels(repo.repoRoot) };
    }
    if (recorded.length >= MAX_RECORDED_DECISIONS) {
      return { error: `this session already recorded ${MAX_RECORDED_DECISIONS} decisions — the limit per session` };
    }
    const entry: RecordedDecision = { text, at: new Date().toISOString(), ...(files.length ? { files } : {}) };
    const base = existing || seedEntry(state);
    writeSessionMemory(repo.repoRoot, { ...base, recordedDecisions: [...recorded, entry] });
    // writeSessionMemory is best-effort and swallows its failures; read back.
    const after = readSessionMemoryEntry(repo.repoRoot, state.sessionId);
    if (!after?.recordedDecisions?.some((d) => todoClosureKey(d.text) === key)) {
      return { error: 'the decision could not be written to the repo memory note' };
    }
    return { sessionId: state.sessionId, text, files, existing: false, ...travels(repo.repoRoot) };
  } catch (err: any) {
    return { error: `could not record the decision: ${err?.message || err}` };
  }
}
