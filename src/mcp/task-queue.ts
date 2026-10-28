// The live task queue's MCP tools: list_tasks, take_task, release_task,
// finish_task (docs/LIVE_TASK_QUEUE.md).
//
// An agent takes a task on the server with a lease, so another agent asking
// for work gets something else. The claim lives on the server only — never in
// the memory note — and is read only when a tool is called: no polling.
//
// The claim token the server hands back is kept HERE, in this MCP server
// process (one per agent session), and never shown to the model: it is what
// releases and finishes the claim, and a token in the transcript is a token
// any later reader could use.
//
// Offline (no account, or Origin unreachable) never stops the agent:
// list_tasks falls back to the TODOs in the repo's memory note, take_task says
// "work on it, but nobody else can see you have it", and finish_task still
// writes the note's pending closure.
//
// add_todo lives here too: it writes the note (memory-write.ts) and then makes
// the TODO live on the server, so list_tasks shows it to other agents before
// the note is pushed and imported. That second half is best effort.
//
// None of these throws: every refusal comes back as { error } or a result
// that says why.
import os from 'os';
import { todoClosureKey } from '../memory.js';
import { getGitRoot, getWorkingGitRoot } from '../session-state.js';
import { gitOrNull } from '../utils/exec.js';

export interface TaskQueueDeps {
  request: (path: string, opts?: RequestInit) => Promise<any>;
  connected: () => boolean;
  /** Open TODOs from the repo's memory note — the offline list. */
  openTodos: (repoRoot: string) => Array<{ id: string; text: string; pending?: unknown }>;
  /** close_todo's writer: a pending closure in the note, confirmed when the work is on main. */
  closeTodo: (args: { todo: string; reason: string; commit_sha?: string; repo_path?: string }) => Record<string, unknown>;
  /** The Origin session doing the work here, when one is identifiable. */
  session: (repoRoot: string, workRoot: string) => { sessionId?: string; agentSessionId?: string; agentSlug?: string } | null;
  hostname?: () => string;
  /** Claims a Start run took for this session (issue-link.ts), and dropping one that ended. */
  sessionClaims?: (workRoot: string, sessionId: string) => Array<{ repoId: string; shortId: string; claimToken: string; leaseExpiresAt: string }>;
  dropSessionClaim?: (workRoot: string, sessionId: string, repoId: string, shortId: string) => void;
  /** add_todo's note writer (memory-write.ts addTodoTool). */
  addTodo?: (args: { text?: unknown; repo_path?: unknown }) => { id?: string; text?: string; error?: string; [k: string]: unknown };
}

/** adoptedFrom: the session file a Start run's claim came from, to drop it once the claim ends. */
type Held = { token: string; leaseExpiresAt: string; adoptedFrom?: { workRoot: string; sessionId: string } };

const LEASE_MIN_MINUTES = 5;
const LEASE_MAX_MINUTES = 120;
const TASK_ID_RE = /^[A-Za-z0-9#][A-Za-z0-9_.#-]{0,63}$/;
/** take_task's arguments (server.ts's inputSchema). */
const TAKE_TASK_ARGS = ['task', 'lease_minutes', 'repo_path'];

export function createTaskQueue(deps: TaskQueueDeps) {
  /** repoRoot → API repo id, for this process's life. One route-preview per repo. */
  const repoIds = new Map<string, string | null>();
  /** `${repoId}:${shortId}` → the claim this agent holds. */
  const held = new Map<string, Held>();

  type Repo = { repoRoot: string; workRoot: string };
  type Where = Repo & { repoId: string | null; offline: string | null };

  function resolveRepo(repoPathArg: unknown): Repo | { error: string } {
    const raw = typeof repoPathArg === 'string' && repoPathArg.trim() ? repoPathArg.trim() : process.cwd();
    const workRoot = getWorkingGitRoot(raw);
    const repoRoot = getGitRoot(raw);
    if (!workRoot || !repoRoot) return { error: `not a git repository: ${raw}` };
    return { repoRoot, workRoot };
  }

  /** The repo's id on Origin, or why the queue is out of reach (offline). */
  async function where(repoPathArg: unknown): Promise<Where | { error: string }> {
    const repo = resolveRepo(repoPathArg);
    if ('error' in repo) return repo;
    if (!deps.connected()) return { ...repo, repoId: null, offline: 'this machine is not connected to an Origin account' };
    if (repoIds.has(repo.repoRoot)) {
      const id = repoIds.get(repo.repoRoot)!;
      return { ...repo, repoId: id, offline: id ? null : 'Origin does not know this repo' };
    }
    try {
      const remote = gitOrNull(['remote', 'get-url', 'origin'], { cwd: repo.repoRoot, timeoutMs: 5_000 })?.trim();
      const route = await deps.request('/api/mcp/route-preview', {
        method: 'POST',
        body: JSON.stringify({ repoPath: repo.repoRoot, ...(remote ? { repoUrl: remote } : {}) }),
      });
      const id = typeof route?.repo?.id === 'string' ? route.repo.id : null;
      repoIds.set(repo.repoRoot, id);
      return { ...repo, repoId: id, offline: id ? null : 'Origin does not know this repo' };
    } catch (err: any) {
      // Not cached: the next call tries again.
      return { ...repo, repoId: null, offline: unreachable(err) };
    }
  }

  function unreachable(err: any): string {
    return `Origin is unreachable (${err?.message || 'network error'})`;
  }
  /** A thrown request that carries an HTTP status is an answer, not an outage. */
  function isAnswer(err: any): boolean {
    return typeof err?.status === 'number';
  }

  function issuesPath(repoId: string, rest = ''): string {
    return `/api/repos/${encodeURIComponent(repoId)}/issues${rest}`;
  }

  function claimer(w: Repo, leaseMinutes: unknown) {
    const s = safe(() => deps.session(w.repoRoot, w.workRoot), null);
    const minutes = typeof leaseMinutes === 'number' && Number.isFinite(leaseMinutes)
      ? Math.min(LEASE_MAX_MINUTES, Math.max(LEASE_MIN_MINUTES, leaseMinutes))
      : undefined;
    return {
      agent: s?.agentSlug ?? null,
      agentSessionId: s?.agentSessionId ?? null,
      sessionId: s?.sessionId ?? null,
      host: safe(() => (deps.hostname ?? os.hostname)(), null),
      ...(minutes ? { leaseSeconds: minutes * 60 } : {}),
    };
  }

  function offlineTodos(repoRoot: string) {
    return safe(() => deps.openTodos(repoRoot), []).map((t) => ({ id: t.id, text: t.text, ...(t.pending ? { pendingClosure: true } : {}) }));
  }

  /**
   * Push out the lease on every claim this agent holds in the repo. Rides on
   * the agent's own queue calls, so a task it keeps working on stays its own.
   * A claim the server says is gone is dropped here too.
   */
  async function renewHeld(repoId: string): Promise<void> {
    for (const [k, h] of held) {
      if (!k.startsWith(`${repoId}:`)) continue;
      const shortId = k.slice(repoId.length + 1);
      try {
        const r = await deps.request(issuesPath(repoId, `/${encodeURIComponent(shortId)}/renew`), { method: 'POST', body: JSON.stringify({ claimToken: h.token }) });
        if (r?.leaseExpiresAt) h.leaseExpiresAt = r.leaseExpiresAt;
      } catch (err: any) {
        if (isAnswer(err) && err.status === 409) forget(k);
      }
    }
  }

  function heldHere(repoId: string) {
    return [...held.entries()]
      .filter(([k]) => k.startsWith(`${repoId}:`))
      .map(([k, h]) => ({ task: k.slice(repoId.length + 1), leaseExpiresAt: h.leaseExpiresAt }));
  }

  /**
   * Take over the claims a Start run made for this session: the session-start
   * hook got the token from /link and left it in the checkout's git dir.
   */
  function adopt(w: Where): void {
    if (!w.repoId || !deps.sessionClaims) return;
    const s = safe(() => deps.session(w.repoRoot, w.workRoot), null);
    if (!s?.sessionId) return;
    for (const c of safe(() => deps.sessionClaims!(w.workRoot, s.sessionId!), [])) {
      const k = `${c.repoId}:${c.shortId}`;
      if (c.repoId === w.repoId && !held.has(k)) {
        held.set(k, { token: c.claimToken, leaseExpiresAt: c.leaseExpiresAt, adoptedFrom: { workRoot: w.workRoot, sessionId: s.sessionId } });
      }
    }
  }

  /** The claim ended (released, finished, lost): forget it here and in the session file. */
  function forget(key: string): void {
    const h = held.get(key);
    held.delete(key);
    if (h?.adoptedFrom && deps.dropSessionClaim) {
      const i = key.indexOf(':');
      safe(() => deps.dropSessionClaim!(h.adoptedFrom!.workRoot, h.adoptedFrom!.sessionId, key.slice(0, i), key.slice(i + 1)), undefined);
    }
  }

  // ─── list_tasks ────────────────────────────────────────────────────────────

  async function listTasks(args: { state?: unknown; limit?: unknown; repo_path?: unknown }) {
    const w = await where(args.repo_path);
    if ('error' in w) return w;
    const state = args.state === 'claimed' || args.state === 'all' ? args.state : 'ready';
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(50, Math.floor(args.limit)) : 20;
    adopt(w);
    if (w.repoId) {
      try {
        await renewHeld(w.repoId);
        const rows = await deps.request(issuesPath(w.repoId, `/queue?state=${state}&limit=${limit}`));
        return {
          state,
          tasks: (Array.isArray(rows) ? rows : []).map((r: any) => ({
            id: r.shortId, title: r.title, type: r.type, priority: r.priority, status: r.status,
            ...(r.deps?.length ? { deps: r.deps } : {}),
            ...(r.source ? { source: r.source } : {}),
            ...(r.provider ? { provider: r.provider } : {}),
            claim: r.claim ? { agent: r.claim.agent, host: r.claim.host, until: r.claim.leaseExpiresAt, mine: held.has(`${w.repoId}:${r.shortId}`) } : null,
          })),
          youHold: heldHere(w.repoId),
        };
      } catch (err: any) {
        if (isAnswer(err)) return { error: err.message };
        w.offline = unreachable(err);
      }
    }
    return {
      offline: true,
      reason: w.offline,
      note: 'These are the open TODOs from the repo memory note. Nobody\'s claims are visible offline.',
      tasks: offlineTodos(w.repoRoot).slice(0, limit),
    };
  }

  // ─── take_task ─────────────────────────────────────────────────────────────

  async function takeTask(args: { task?: unknown; lease_minutes?: unknown; repo_path?: unknown }) {
    // An argument it does not know is a mistake, not "take the next one": an
    // agent that named its task as `taskId` was handed the top of the queue
    // (OR-45) instead of the task it was started for.
    const unknown = Object.keys(args || {}).filter((k) => !TAKE_TASK_ARGS.includes(k));
    if (unknown.length > 0) {
      return { error: `unknown argument${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')} — name the task with \`task\` (e.g. {"task": "ori-a3f2"}), or pass no task to take the next ready one` };
    }
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (task && !TASK_ID_RE.test(task)) return { error: 'task must be a task id from list_tasks (e.g. "ori-a3f2", "511e4071", "#123")' };
    const w = await where(args.repo_path);
    if ('error' in w) return w;
    if (w.repoId) {
      try {
        const body = JSON.stringify(claimer(w, args.lease_minutes));
        const r = task
          ? await deps.request(issuesPath(w.repoId, `/${encodeURIComponent(task)}/claim`), { method: 'POST', body })
          : await deps.request(issuesPath(w.repoId, '/claim-next'), { method: 'POST', body });
        if (!r?.task) return { claimed: false, reason: 'nothing_ready', note: 'No open task is free right now (all taken, blocked by deps, or none left).' };
        held.set(`${w.repoId}:${r.task.shortId}`, { token: r.claimToken, leaseExpiresAt: r.leaseExpiresAt });
        return {
          claimed: true,
          task: {
            id: r.task.shortId, title: r.task.title, type: r.task.type, priority: r.task.priority,
            ...(r.task.description ? { description: r.task.description } : {}),
            ...(r.task.agentPrompt ? { prompt: r.task.agentPrompt } : {}),
            ...(r.task.source ? { source: r.task.source } : {}),
            ...(r.task.hostUrl ? { url: r.task.hostUrl } : {}),
          },
          leaseExpiresAt: r.leaseExpiresAt,
          note: 'It is yours until the lease runs out; it renews while your session is live (heartbeats and recorded turns) and on each list_tasks call. Call finish_task when done, or release_task to give it back.',
        };
      } catch (err: any) {
        if (isAnswer(err)) {
          const b = err.body || {};
          if (err.status === 409) return { claimed: false, reason: b.error, ...(b.claim ? { heldBy: { agent: b.claim.agent, host: b.claim.host, until: b.claim.leaseExpiresAt } } : {}), ...(b.deps ? { openDeps: b.deps } : {}), ...(b.status ? { status: b.status } : {}) };
          if (err.status === 404) return { claimed: false, reason: 'not_found' };
          return { error: err.message };
        }
        w.offline = unreachable(err);
      }
    }
    // Offline: work anyway, unclaimed (Artem, 2026-10-15).
    const todos = offlineTodos(w.repoRoot);
    const local = task ? todos.find((t) => t.id.toLowerCase().startsWith(task.toLowerCase())) : todos[0];
    return {
      claimed: false,
      offline: true,
      reason: w.offline,
      ...(local ? { task: local } : {}),
      note: 'You can work on it, but nobody else can see you have it — another agent may pick the same task.',
    };
  }

  // ─── release_task ──────────────────────────────────────────────────────────

  async function releaseTask(args: { task?: unknown; repo_path?: unknown }) {
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) return { error: 'task is required' };
    const w = await where(args.repo_path);
    if ('error' in w) return w;
    if (!w.repoId) return { released: false, offline: true, reason: w.offline };
    adopt(w);
    const k = heldKey(w.repoId, task);
    if (!k) return { released: false, reason: 'not_held', note: `You do not hold ${task} in this session.` };
    try {
      await deps.request(issuesPath(w.repoId, `/${encodeURIComponent(k.shortId)}/release`), { method: 'POST', body: JSON.stringify({ claimToken: k.held.token }) });
      forget(k.key);
      return { released: true, task: k.shortId };
    } catch (err: any) {
      if (isAnswer(err) && err.status === 409) { forget(k.key); return { released: false, reason: 'lost', note: 'The claim was already gone (lease ran out, or a person took it back).' }; }
      return isAnswer(err) ? { error: err.message } : { released: false, offline: true, reason: unreachable(err) };
    }
  }

  // ─── finish_task ───────────────────────────────────────────────────────────

  async function finishTask(args: { task?: unknown; resolution?: unknown; commit_sha?: unknown; pr_url?: unknown; repo_path?: unknown }) {
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    const resolution = typeof args.resolution === 'string' ? args.resolution.trim() : '';
    const commitSha = typeof args.commit_sha === 'string' && args.commit_sha.trim() ? args.commit_sha.trim() : undefined;
    const prUrl = typeof args.pr_url === 'string' && args.pr_url.trim() ? args.pr_url.trim() : undefined;
    if (!task) return { error: 'task is required' };
    if (!resolution) return { error: 'resolution is required — say what was done' };
    const w = await where(args.repo_path);
    if ('error' in w) return w;

    let server: Record<string, unknown> | null = null;
    let source: string | null = null;
    let closeRef = task;
    adopt(w);
    if (w.repoId) {
      const k = heldKey(w.repoId, task);
      if (!k) {
        server = { finished: false, reason: 'not_held', note: `You do not hold ${task} in this session; nothing changed on the server.` };
      } else {
        try {
          const r = await deps.request(issuesPath(w.repoId, `/${encodeURIComponent(k.shortId)}/finish`), {
            method: 'POST',
            body: JSON.stringify({ claimToken: k.held.token, resolution, ...(commitSha ? { commitSha } : {}), ...(prUrl ? { prUrl } : {}) }),
          });
          forget(k.key);
          source = r?.issue?.source ?? null;
          closeRef = k.shortId;
          server = {
            finished: true,
            outcome: r?.outcome,
            ...(r?.outcome === 'pending' ? { note: 'Recorded. It shows as closed once the work is on main.' } : {}),
            ...(r?.hostSync ? { hostSync: r.hostSync } : {}),
          };
        } catch (err: any) {
          if (isAnswer(err) && err.status === 409) { forget(k.key); server = { finished: false, reason: 'lost', note: 'The claim was already gone (lease ran out, or a person took it back).' }; }
          else server = isAnswer(err) ? { finished: false, error: err.message } : { finished: false, offline: true, reason: unreachable(err) };
        }
      }
    } else {
      server = { finished: false, offline: true, reason: w.offline };
    }

    // A memory TODO also gets its pending closure in the note — the record that
    // travels with the repo and closes it when the work is on main. Offline, the
    // note is the only place the finish can go.
    const isMemory = source === 'memory' || (source === null && (server as any)?.offline);
    const note = isMemory
      ? safe(() => deps.closeTodo({ todo: closeRef, reason: resolution, ...(commitSha ? { commit_sha: commitSha } : {}), repo_path: w.workRoot }), { error: 'could not write the memory note' })
      : null;
    return { task, ...server, ...(note ? { memoryNote: note } : {}) };
  }

  // ─── add_todo ──────────────────────────────────────────────────────────────

  async function addTodo(args: { text?: unknown; repo_path?: unknown }) {
    if (!deps.addTodo) return { error: 'add_todo is not available' };
    const r = safe(() => deps.addTodo!(args), { error: 'could not record the TODO' } as ReturnType<NonNullable<TaskQueueDeps['addTodo']>>);
    if (r.error || !r.id || !r.text) return r;
    return { ...r, live: await publishTodo(args.repo_path, r.id, r.text) };
  }

  /**
   * The note's TODO as a server issue, under the id and key the memory import
   * gives it (source 'memory', sourceKey from the text), so that import
   * updates this row rather than adding a second.
   * Unreachable, unknown repo, not signed in: the note alone, never an error.
   */
  async function publishTodo(repoPathArg: unknown, id: string, text: string): Promise<Record<string, unknown>> {
    const w = await where(repoPathArg);
    if ('error' in w) return { listed: false, reason: w.error };
    if (!w.repoId) return { listed: false, offline: true, reason: w.offline, note: 'Other agents see it once the memory note is pushed and imported.' };
    const s = safe(() => deps.session(w.repoRoot, w.workRoot), null);
    try {
      const r = await deps.request(issuesPath(w.repoId), {
        method: 'POST',
        body: JSON.stringify({
          // The server derives the key itself; sending ours makes a drift
          // between todoClosureKey and its todoKey a 400 instead of a duplicate.
          source: 'memory', text, shortId: id, sourceKey: todoClosureKey(text),
          ...(s?.agentSessionId ? { sessionId: s.agentSessionId } : {}),
          ...(s?.agentSlug ? { agentSlug: s.agentSlug } : {}),
        }),
      });
      return { listed: true, task: r?.shortId ?? id, ...(r?.created === false ? { existing: true } : {}) };
    } catch (err: any) {
      if (isAnswer(err) && err.status === 410) {
        return { listed: false, reason: 'deleted', note: 'Someone deleted this TODO from the issues list; it stays off the queue.' };
      }
      return isAnswer(err) ? { listed: false, reason: err.message } : { listed: false, offline: true, reason: unreachable(err) };
    }
  }

  function heldKey(repoId: string, task: string): { key: string; shortId: string; held: Held } | null {
    const want = task.replace(/^#/, '').toLowerCase();
    for (const [key, h] of held) {
      if (!key.startsWith(`${repoId}:`)) continue;
      const shortId = key.slice(repoId.length + 1);
      if (shortId.toLowerCase() === task.toLowerCase() || shortId.toLowerCase() === want) return { key, shortId, held: h };
    }
    return null;
  }

  return { listTasks, takeTask, releaseTask, finishTask, addTodo };
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}
