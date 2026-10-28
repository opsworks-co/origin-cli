// The live task queue's MCP tools (mcp/task-queue.ts) against a fake Origin
// API: the claim token stays in the process and never reaches the model, the
// repo lookup is cached, a held claim renews on the agent's own queue calls,
// a memory TODO's finish also writes the note, and offline never blocks work.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTaskQueue, type TaskQueueDeps } from '../mcp/task-queue.js';

const TOKEN = 'secret-claim-token-abc';
const REPO_ID = 'repo-1';

let repo: string;
let calls: Array<{ path: string; body: any }>;
let closed: Array<Record<string, unknown>>;

/** A request that fails like a dead network: no HTTP status. */
const networkDown = () => { throw Object.assign(new Error('fetch failed'), {}); };
/** A request the server answered with an error status. */
const httpError = (status: number, body: object) => Object.assign(new Error(String((body as any).error)), { status, body });

function deps(over: Partial<TaskQueueDeps> & { routes?: Record<string, (body: any) => any> } = {}): TaskQueueDeps {
  const routes: Record<string, (body: any) => any> = {
    'POST /api/mcp/route-preview': () => ({ repo: { id: REPO_ID } }),
    [`POST /api/repos/${REPO_ID}/issues/claim-next`]: () => ({
      task: { shortId: 'ori-1', title: 'Fix the thing', type: 'task', priority: 2, description: 'details', source: null },
      claimToken: TOKEN, leaseExpiresAt: '2026-10-15T20:00:00.000Z',
    }),
    [`POST /api/repos/${REPO_ID}/issues/ori-1/release`]: () => ({ ok: true }),
    [`POST /api/repos/${REPO_ID}/issues/ori-1/renew`]: () => ({ leaseExpiresAt: '2026-10-15T21:00:00.000Z' }),
    [`POST /api/repos/${REPO_ID}/issues/ori-1/finish`]: () => ({ outcome: 'closed', issue: { shortId: 'ori-1', source: null } }),
    [`GET /api/repos/${REPO_ID}/issues/queue?state=ready&limit=20`]: () => ([
      { shortId: 'ori-2', title: 'Other', type: 'task', priority: 3, status: 'open', deps: [], claim: null },
    ]),
    ...over.routes,
  };
  return {
    request: async (p, opts) => {
      const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
      calls.push({ path: `${opts?.method || 'GET'} ${p}`, body });
      const h = routes[`${opts?.method || 'GET'} ${p}`];
      if (!h) throw httpError(404, { error: 'Issue not found' });
      return h(body);
    },
    connected: () => true,
    openTodos: () => [{ id: '511e4071', text: 'Verify the queue on prod' }],
    closeTodo: (a) => { closed.push(a); return { id: a.todo, state: 'pending' }; },
    session: () => ({ sessionId: 'sess-1', agentSessionId: 'agent-1', agentSlug: 'claude-code' }),
    hostname: () => 'laptop',
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  closed = [];
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mcp-queue-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('take_task', () => {
  it('claims the next task as this session, and never shows the token', async () => {
    const q = createTaskQueue(deps());
    const r: any = await q.takeTask({ repo_path: repo });
    expect(r).toMatchObject({ claimed: true, task: { id: 'ori-1', title: 'Fix the thing', description: 'details' } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    // Only list_tasks renews from the client; the server renews on heartbeats
    // and turn uploads. The note must not promise that any queue call renews.
    expect(r.note).not.toMatch(/any queue tool call/);
    expect(r.note).toMatch(/list_tasks/);
    const claim = calls.find((c) => c.path.endsWith('/claim-next'))!;
    expect(claim.body).toMatchObject({ agent: 'claude-code', agentSessionId: 'agent-1', sessionId: 'sess-1', host: 'laptop' });
  });

  it('a named task goes to /claim, and a lease is clamped to 5–120 minutes', async () => {
    const q = createTaskQueue(deps({
      routes: { [`POST /api/repos/${REPO_ID}/issues/ori-9/claim`]: () => ({ task: { shortId: 'ori-9', title: 't' }, claimToken: TOKEN, leaseExpiresAt: 'x' }) },
    }));
    expect(await q.takeTask({ task: 'ori-9', lease_minutes: 999, repo_path: repo })).toMatchObject({ claimed: true });
    expect(calls.find((c) => c.path.endsWith('/ori-9/claim'))!.body.leaseSeconds).toBe(120 * 60);
  });

  it('says who holds a task someone else has', async () => {
    const q = createTaskQueue(deps({
      routes: {
        [`POST /api/repos/${REPO_ID}/issues/ori-3/claim`]: () => {
          throw httpError(409, { error: 'claimed', claim: { agent: 'codex', host: 'desktop', leaseExpiresAt: 'soon' } });
        },
      },
    }));
    expect(await q.takeTask({ task: 'ori-3', repo_path: repo })).toEqual({
      claimed: false, reason: 'claimed', heldBy: { agent: 'codex', host: 'desktop', until: 'soon' },
    });
  });

  it('nothing free is an answer, not an error', async () => {
    const q = createTaskQueue(deps({ routes: { [`POST /api/repos/${REPO_ID}/issues/claim-next`]: () => ({ task: null }) } }));
    expect(await q.takeTask({ repo_path: repo })).toMatchObject({ claimed: false, reason: 'nothing_ready' });
  });

  it('refuses an argument it does not know instead of taking the next task', async () => {
    // An agent that named its task `taskId` was handed the top of the queue (OR-45).
    const q = createTaskQueue(deps());
    const r: any = await q.takeTask({ taskId: '2c762dea', repo_path: repo } as any);
    expect(r.error).toMatch(/unknown argument taskId/);
    expect(r.error).toMatch(/`task`/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a task id that is not one', async () => {
    const q = createTaskQueue(deps());
    expect(await q.takeTask({ task: '../../etc', repo_path: repo })).toHaveProperty('error');
    expect(calls).toHaveLength(0);
  });
});

describe('release_task and finish_task', () => {
  it('release uses the held token, and a second release says you do not hold it', async () => {
    const q = createTaskQueue(deps());
    await q.takeTask({ repo_path: repo });
    expect(await q.releaseTask({ task: 'ori-1', repo_path: repo })).toEqual({ released: true, task: 'ori-1' });
    expect(calls.find((c) => c.path.endsWith('/release'))!.body).toEqual({ claimToken: TOKEN });
    expect(await q.releaseTask({ task: 'ori-1', repo_path: repo })).toMatchObject({ released: false, reason: 'not_held' });
  });

  it('finish on an Origin issue closes it on the server and leaves the note alone', async () => {
    const q = createTaskQueue(deps());
    await q.takeTask({ repo_path: repo });
    const r: any = await q.finishTask({ task: 'ori-1', resolution: 'fixed it', commit_sha: 'abc1234', repo_path: repo });
    expect(r).toMatchObject({ finished: true, outcome: 'closed' });
    expect(calls.find((c) => c.path.endsWith('/finish'))!.body).toEqual({ claimToken: TOKEN, resolution: 'fixed it', commitSha: 'abc1234' });
    expect(closed).toHaveLength(0);
  });

  it('finish on a memory TODO also writes the pending closure to the note', async () => {
    const q = createTaskQueue(deps({
      routes: { [`POST /api/repos/${REPO_ID}/issues/ori-1/finish`]: () => ({ outcome: 'pending', issue: { shortId: 'ori-1', source: 'memory' } }) },
    }));
    await q.takeTask({ repo_path: repo });
    const r: any = await q.finishTask({ task: 'ori-1', resolution: 'fixed it', commit_sha: 'abc1234', repo_path: repo });
    expect(r).toMatchObject({ finished: true, outcome: 'pending' });
    expect(closed).toEqual([{ todo: 'ori-1', reason: 'fixed it', commit_sha: 'abc1234', repo_path: repo }]);
  });

  it('a claim that is gone is reported as lost and dropped', async () => {
    const q = createTaskQueue(deps({
      routes: { [`POST /api/repos/${REPO_ID}/issues/ori-1/finish`]: () => { throw httpError(409, { error: 'lost' }); } },
    }));
    await q.takeTask({ repo_path: repo });
    expect(await q.finishTask({ task: 'ori-1', resolution: 'x', repo_path: repo })).toMatchObject({ finished: false, reason: 'lost' });
    expect(await q.releaseTask({ task: 'ori-1', repo_path: repo })).toMatchObject({ reason: 'not_held' });
  });
});

describe('list_tasks', () => {
  it('renews the claims this agent holds, and looks the repo up once', async () => {
    const q = createTaskQueue(deps());
    await q.takeTask({ repo_path: repo });
    const r: any = await q.listTasks({ repo_path: repo });
    expect(r.tasks).toEqual([{ id: 'ori-2', title: 'Other', type: 'task', priority: 3, status: 'open', claim: null }]);
    expect(r.youHold).toEqual([{ task: 'ori-1', leaseExpiresAt: '2026-10-15T21:00:00.000Z' }]);
    expect(calls.filter((c) => c.path.endsWith('/renew'))).toHaveLength(1);
    expect(calls.filter((c) => c.path === 'POST /api/mcp/route-preview')).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe('offline', () => {
  it('Origin unreachable: list falls back to the memory note, take says work on it unclaimed', async () => {
    const q = createTaskQueue(deps({ request: async () => networkDown() }));
    const list: any = await q.listTasks({ repo_path: repo });
    expect(list).toMatchObject({ offline: true, tasks: [{ id: '511e4071', text: 'Verify the queue on prod' }] });

    const take: any = await q.takeTask({ task: '511e', repo_path: repo });
    expect(take).toMatchObject({ claimed: false, offline: true, task: { id: '511e4071' } });
    expect(take.note).toMatch(/nobody else can see/);
  });

  it('not connected to an account: no request at all', async () => {
    const q = createTaskQueue(deps({ connected: () => false }));
    expect(await q.listTasks({ repo_path: repo })).toMatchObject({ offline: true });
    expect(calls).toHaveLength(0);
  });

  it('finish offline still writes the note', async () => {
    const q = createTaskQueue(deps({ request: async () => networkDown() }));
    const r: any = await q.finishTask({ task: '511e4071', resolution: 'did it', repo_path: repo });
    expect(r).toMatchObject({ offline: true, memoryNote: { id: '511e4071', state: 'pending' } });
    expect(closed).toHaveLength(1);
  });

  it('a failed repo lookup is tried again on the next call', async () => {
    let down = true;
    const base = deps();
    const q = createTaskQueue({ ...base, request: async (p, o) => { if (down) networkDown(); return base.request(p, o); } });
    expect(await q.listTasks({ repo_path: repo })).toMatchObject({ offline: true });
    down = false;
    expect(await q.listTasks({ repo_path: repo })).toMatchObject({ state: 'ready' });
  });
});

describe('a claim a Start run took', () => {
  it('is adopted from the session file, finished with its token, and dropped from the file', async () => {
    const dropped: string[] = [];
    const q = createTaskQueue(deps({
      sessionClaims: (_w, sid) => (sid === 'sess-1' ? [{ repoId: REPO_ID, shortId: 'ori-1', claimToken: 'start-token', leaseExpiresAt: 'x' }] : []),
      dropSessionClaim: (_w, sid, rid, short) => { dropped.push(`${sid}/${rid}/${short}`); },
    }));
    const list: any = await q.listTasks({ repo_path: repo });
    expect(list.youHold).toEqual([{ task: 'ori-1', leaseExpiresAt: '2026-10-15T21:00:00.000Z' }]);
    expect(JSON.stringify(list)).not.toContain('start-token');

    expect(await q.finishTask({ task: 'ori-1', resolution: 'done', repo_path: repo })).toMatchObject({ finished: true });
    expect(calls.find((c) => c.path.endsWith('/finish'))!.body.claimToken).toBe('start-token');
    expect(dropped).toEqual(['sess-1/repo-1/ori-1']);
  });

  it('another repo\'s claim is not adopted', async () => {
    const q = createTaskQueue(deps({ sessionClaims: () => [{ repoId: 'other-repo', shortId: 'x-1', claimToken: 't', leaseExpiresAt: 'x' }] }));
    expect(((await q.listTasks({ repo_path: repo })) as any).youHold).toEqual([]);
  });
});

describe('add_todo: the new TODO is live on the queue', () => {
  const written = { id: 'a1b2c3d4', text: 'Check  the queue on prod', existing: false, travels: true };

  it('writes the note, then creates the issue as the memory import would, on the cached repo id', async () => {
    const notes: unknown[] = [];
    const q = createTaskQueue(deps({
      addTodo: (a) => { notes.push(a); return written; },
      routes: { [`POST /api/repos/${REPO_ID}/issues`]: (b) => ({ shortId: b.shortId, created: true }) },
    }));
    await q.listTasks({ repo_path: repo });
    const r: any = await q.addTodo({ text: 'Check  the queue on prod', repo_path: repo });
    expect(notes).toHaveLength(1);
    expect(r).toMatchObject({ id: 'a1b2c3d4', travels: true, live: { listed: true, task: 'a1b2c3d4' } });
    const create = calls.find((c) => c.path === `POST /api/repos/${REPO_ID}/issues`)!;
    expect(create.body).toEqual({
      source: 'memory', text: 'Check  the queue on prod', shortId: 'a1b2c3d4',
      // Byte for byte the server's todoKey (apps/api/src/services/repo-memory.ts).
      sourceKey: 'check the queue on prod',
      sessionId: 'agent-1', agentSlug: 'claude-code',
    });
    expect(calls.filter((c) => c.path.endsWith('/route-preview'))).toHaveLength(1);
  });

  it('a TODO the server already has is reported as existing', async () => {
    const q = createTaskQueue(deps({
      addTodo: () => ({ ...written, existing: true }),
      routes: { [`POST /api/repos/${REPO_ID}/issues`]: () => ({ shortId: '0badc0de', created: false }) },
    }));
    expect(await q.addTodo({ text: 'x', repo_path: repo })).toMatchObject({ live: { listed: true, task: '0badc0de', existing: true } });
  });

  it('offline, unreachable, or deleted on the server: the note still has it, never an error', async () => {
    const off: any = await createTaskQueue(deps({ addTodo: () => written, connected: () => false })).addTodo({ text: 'x', repo_path: repo });
    expect(off).toMatchObject({ id: 'a1b2c3d4', live: { listed: false, offline: true } });
    expect(off.error).toBeUndefined();

    const down: any = await createTaskQueue(deps({
      addTodo: () => written,
      routes: { [`POST /api/repos/${REPO_ID}/issues`]: networkDown },
    })).addTodo({ text: 'x', repo_path: repo });
    expect(down).toMatchObject({ id: 'a1b2c3d4', live: { listed: false, offline: true } });
    expect(down.error).toBeUndefined();

    const gone: any = await createTaskQueue(deps({
      addTodo: () => written,
      routes: { [`POST /api/repos/${REPO_ID}/issues`]: () => { throw httpError(410, { error: 'deleted', tombstoned: true }); } },
    })).addTodo({ text: 'x', repo_path: repo });
    expect(gone).toMatchObject({ id: 'a1b2c3d4', live: { listed: false, reason: 'deleted' } });
  });

  it('a refused note write goes no further', async () => {
    const q = createTaskQueue(deps({ addTodo: () => ({ error: 'text is required' }) }));
    expect(await q.addTodo({ text: '', repo_path: repo })).toEqual({ error: 'text is required' });
    expect(calls).toHaveLength(0);
  });
});
